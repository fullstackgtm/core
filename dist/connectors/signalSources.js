/**
 * Source connectors for the `signals` layer — the connection-based intake that
 * generalizes the no-auth ATS adapters (`atsBoards.ts`) and the hand-staged
 * `--from <file.json>` path into one contract: a platform connection in, a list
 * of evidence-bearing staged signal rows out.
 *
 * Design (see docs/spec-connectors-signals-outbound.md):
 *   - Zero runtime deps: global `fetch` only, injectable for tests.
 *   - Read-only: a source never writes a CRM record and never emits a
 *     PatchOperation. `signals fetch` stays read-only re: the CRM.
 *   - Verbatim evidence: every row carries a non-empty `quote`; a row that
 *     cannot ground a why-now is dropped, never faked. The central
 *     `stagedRowToSignal` gate enforces this again.
 *   - Secrets via the credential ladder: API keys come from
 *     `ctx.getApiKey(provider)` (login store -> env -> broker), NEVER from argv.
 *     `ctx.options` carries non-secret knobs only (a file path, a query term).
 *   - Per-source resilience: a connector's own failure yields `[]` (logged by
 *     the caller), it must never sink a multi-source run — the per-provider
 *     try/catch idiom of atsBoards/prospectSources.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FREE_EMAIL_DOMAINS } from "../freeEmailDomains.js";
import { SIGNAL_BUCKETS } from "../signals.js";
import { parseSpoolText, spoolFilesIn } from "../spoolFiles.js";
// ---------------------------------------------------------------------------
// file — local JSON / JSONL intake (also the webhook landing-zone reader)
/**
 * Read staged rows from a local path — the webhook landing-zone reader. The path
 * (from `options.path`/`options.file`) may be:
 *   - a single FILE: a JSON array, or newline-delimited JSON (one row per line);
 *   - a DIRECTORY (the conventional spool): every `*.jsonl` / `*.json` file in
 *     it is read and concatenated (sorted by name), so multiple receivers can
 *     each append their own file (`rb2b.jsonl`, `hubspot.jsonl`) and they all
 *     land in one fetch.
 * No auth. This is how every push platform (RB2B, Trigify, HubSpot webhooks)
 * reaches the CLI: a receiver appends a row to the spool, this reads it on the
 * next `signals fetch`. The CLI defaults the path to the conventional spool dir
 * (`signalsSpoolDir`) when `--connector file` is used with no path; a bare
 * library call with no path is inactive (returns []).
 *
 * Resilient: a missing path / unreadable file yields [] (an empty source, not a
 * crash), and one unreadable file in a spool directory is skipped. A file that
 * IS present but malformed throws — a corrupt spool is a real error to surface,
 * not silent data loss. The central `stagedRowToSignal` gate validates rows.
 */
export const fileSource = {
    id: "file",
    bucket: "company",
    shape: "pull",
    auth: "none",
    async fetch(ctx) {
        const path = ctx.options?.path ?? ctx.options?.file;
        if (!path)
            return []; // no spool configured (the CLI fills the default dir)
        const abs = resolve(process.cwd(), path);
        let isDir;
        try {
            isDir = statSync(abs).isDirectory();
        }
        catch {
            return []; // missing path: an empty source, not a crash
        }
        // Container parsing lives in the shared spool reader (src/spoolFiles.ts) so
        // `signals fetch --from`, `enrich ingest`, and `market observe --from` read
        // the same convention; the "file source" label keeps error text unchanged.
        const files = isDir ? spoolFilesIn(abs) : [abs];
        const rows = [];
        for (const file of files) {
            let raw;
            try {
                raw = readFileSync(file, "utf8");
            }
            catch {
                continue; // one unreadable file in a spool dir must not sink the rest
            }
            rows.push(...parseSpoolText(raw, file, "file source"));
        }
        return rows.map((row) => coerceRow(row, this.bucket));
    },
};
// ---------------------------------------------------------------------------
// serpapi-news — funding/company signals from a news REST query (API key)
const SERPAPI_BASE_URL = "https://serpapi.com";
/**
 * Pull recent news per watchlist account and stage funding/company signals. One
 * query per account (`q="<domain>"`, Google News engine); each result becomes a
 * row whose verbatim `quote` is the headline (+ source), so the downstream judge
 * can ground a why-now on a real, linkable article. API key via the credential
 * ladder (provider "serpapi"); no key -> [] (the source is simply inactive).
 *
 * Bucket defaults to `funding`; override per run with `--connector-opt bucket=company`.
 */
export const serpapiNewsSource = {
    id: "serpapi-news",
    bucket: "funding",
    shape: "pull",
    auth: "api_key",
    async fetch(ctx) {
        const apiKey = ctx.getApiKey ? await ctx.getApiKey("serpapi") : null;
        if (!apiKey)
            return [];
        const fetchImpl = ctx.fetchImpl ?? fetch;
        const base = (ctx.options?.apiBaseUrl ?? SERPAPI_BASE_URL).replace(/\/$/, "");
        const bucket = pickBucket(ctx.options?.bucket, this.bucket);
        const out = [];
        for (const account of ctx.watchlist) {
            const domain = account.domain.trim();
            if (!domain)
                continue;
            try {
                const url = `${base}/search.json?engine=google_news&q=${encodeURIComponent(`"${domain}"`)}` +
                    `&api_key=${encodeURIComponent(apiKey)}`;
                const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
                if (!response.ok)
                    continue;
                const data = (await response.json());
                for (const item of data.news_results ?? []) {
                    const title = typeof item.title === "string" ? item.title.trim() : "";
                    if (!title)
                        continue; // no headline -> no verbatim evidence -> drop
                    const sourceName = typeof item.source === "string" ? item.source : item.source?.name ?? "";
                    const quote = sourceName ? `${title} — ${sourceName}` : title;
                    out.push({
                        bucket,
                        accountDomain: domain,
                        trigger: `news: ${title}`,
                        quote,
                        sourceUrl: typeof item.link === "string" ? item.link : "",
                    });
                }
            }
            catch {
                continue; // one account's outage must not sink the run
            }
        }
        return out;
    },
};
// ---------------------------------------------------------------------------
// hubspot-forms — first-party demand from recent HubSpot form submissions
const HUBSPOT_BASE_URL = "https://api.hubapi.com";
/**
 * Stage `demand` signals from recent HubSpot form submissions — the first real
 * `demand`-bucket producer (a form fill is first-party demand). Reuses the
 * EXISTING HubSpot credential via the ladder (provider "hubspot"); no separate
 * login. Each submission whose email carries a company domain becomes a row
 * whose verbatim `quote` is the form name + submitted email (the evidence a rep
 * can verify). Submissions without a corporate domain (free-mail) are dropped —
 * no account to attach demand to.
 *
 * Phase 1 is a pull over the Forms submissions API; the form-submission webhook
 * (push) lands in Phase 2 via the spool + `file` source.
 */
export const hubspotFormsSource = {
    id: "hubspot-forms",
    bucket: "demand",
    shape: "pull",
    auth: "oauth",
    async fetch(ctx) {
        const token = ctx.getApiKey ? await ctx.getApiKey("hubspot") : null;
        if (!token)
            return [];
        const fetchImpl = ctx.fetchImpl ?? fetch;
        const base = (ctx.options?.apiBaseUrl ?? HUBSPOT_BASE_URL).replace(/\/$/, "");
        const out = [];
        let forms = [];
        try {
            const response = await fetchImpl(`${base}/marketing/v3/forms`, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            });
            if (!response.ok)
                return [];
            const data = (await response.json());
            forms = data.results ?? [];
        }
        catch {
            return [];
        }
        for (const form of forms) {
            const formId = form.guid ?? form.id;
            if (!formId)
                continue;
            const formName = typeof form.name === "string" && form.name ? form.name : "form";
            try {
                const response = await fetchImpl(`${base}/form-integrations/v1/submissions/forms/${encodeURIComponent(formId)}?limit=50`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
                if (!response.ok)
                    continue;
                const data = (await response.json());
                for (const submission of data.results ?? []) {
                    const email = fieldValue(submission.values, "email");
                    const domain = corporateDomain(email);
                    if (!domain)
                        continue; // free-mail / no email: no account to attach to
                    const submittedAt = typeof submission.submittedAt === "number"
                        ? new Date(submission.submittedAt).toISOString()
                        : undefined;
                    out.push({
                        bucket: "demand",
                        accountDomain: domain,
                        trigger: `form: ${formName}`,
                        quote: `Submitted "${formName}" — ${email}`,
                        sourceUrl: "",
                        ...(submittedAt ? { firstSeen: submittedAt } : {}),
                    });
                }
            }
            catch {
                continue;
            }
        }
        return out;
    },
};
// ---------------------------------------------------------------------------
// Registry
const CONNECTORS = [fileSource, serpapiNewsSource, hubspotFormsSource];
const REGISTRY = new Map(CONNECTORS.map((c) => [c.id, c]));
/** All registered source connectors (stable order). */
export function listSignalSources() {
    return [...CONNECTORS];
}
/** Resolve a connector by id, or null when unknown. */
export function getSignalSource(id) {
    return REGISTRY.get(id) ?? null;
}
// ---------------------------------------------------------------------------
// Helpers
function coerceRow(row, defaultBucket) {
    // Fill the bucket from the connector default when a file row omits it; the
    // central validator still rejects an unknown bucket and an empty quote.
    const bucket = row.bucket === undefined ? defaultBucket : row.bucket;
    return { ...row, bucket };
}
function pickBucket(raw, fallback) {
    if (raw && SIGNAL_BUCKETS.includes(raw))
        return raw;
    return fallback;
}
function fieldValue(values, name) {
    for (const field of values ?? []) {
        if (field.name === name && typeof field.value === "string")
            return field.value.trim();
    }
    return "";
}
/** Company domain from an email, or "" for free-mail / no email. */
function corporateDomain(email) {
    if (!email.includes("@"))
        return "";
    const domain = email.split("@").at(-1).trim().toLowerCase();
    if (!domain || FREE_EMAIL_DOMAINS.has(domain))
        return "";
    return domain;
}

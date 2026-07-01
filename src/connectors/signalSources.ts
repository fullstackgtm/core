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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SignalBucket, StagedSignalRow } from "../signals.ts";
import { SIGNAL_BUCKETS } from "../signals.ts";

export type SignalSourceShape = "pull" | "push";
export type SignalSourceAuth = "none" | "api_key" | "oauth";

/** Everything a source connector needs for one `fetch`, supplied by the CLI. */
export type SignalSourceContext = {
  /** Accounts to scope a pull. May be empty (a file/spool source ignores it). */
  watchlist: { domain: string }[];
  /** Evidence keywords for job/listing-style sources; may be empty. */
  keywords: string[];
  now: Date;
  /** Injectable fetch for tests; global `fetch` by default. */
  fetchImpl?: typeof fetch;
  /**
   * Credential-ladder lookup. Returns a usable secret for `provider`, or null
   * when nothing is configured (the connector then returns []). Secrets NEVER
   * arrive via argv — only through this.
   */
  getApiKey?: (provider: string) => Promise<string | null>;
  /** Non-secret per-connector knobs from `--connector-opt k=v` (paths, queries). */
  options?: Record<string, string>;
};

export type SignalSourceConnector = {
  id: string;
  /** Default bucket this source feeds (a row may still override it). */
  bucket: SignalBucket;
  shape: SignalSourceShape;
  auth: SignalSourceAuth;
  /**
   * Produce staged rows now. Resilient by contract: the connector's own
   * failures (offline, non-2xx, malformed payload, missing key) resolve to []
   * rather than throwing, so one source's outage never aborts a multi-source
   * `signals fetch`. Validation/evidence-gating of the returned rows happens
   * centrally in `stagedRowToSignal`.
   */
  fetch(ctx: SignalSourceContext): Promise<StagedSignalRow[]>;
};

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
export const fileSource: SignalSourceConnector = {
  id: "file",
  bucket: "company",
  shape: "pull",
  auth: "none",
  async fetch(ctx) {
    const path = ctx.options?.path ?? ctx.options?.file;
    if (!path) return []; // no spool configured (the CLI fills the default dir)
    const abs = resolve(process.cwd(), path);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      return []; // missing path: an empty source, not a crash
    }
    const files = isDir ? spoolFilesIn(abs) : [abs];
    const rows: Record<string, unknown>[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue; // one unreadable file in a spool dir must not sink the rest
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsed = trimmed.startsWith("[") ? parseJsonArray(trimmed, file) : parseJsonl(trimmed, file);
      rows.push(...parsed);
    }
    return rows.map((row) => coerceRow(row, this.bucket));
  },
};

/** Spool files in a landing-zone directory: `*.jsonl` / `*.json`, name-sorted. */
function spoolFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

function parseJsonArray(raw: string, path: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`file source ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`file source ${path}: expected a JSON array of staged signal rows.`);
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`file source ${path}: row ${index} is not an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

function parseJsonl(raw: string, path: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (error) {
      throw new Error(`file source ${path}: line ${index} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`file source ${path}: line ${index} is not a JSON object.`);
    }
    out.push(parsed as Record<string, unknown>);
  });
  return out;
}

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
export const serpapiNewsSource: SignalSourceConnector = {
  id: "serpapi-news",
  bucket: "funding",
  shape: "pull",
  auth: "api_key",
  async fetch(ctx) {
    const apiKey = ctx.getApiKey ? await ctx.getApiKey("serpapi") : null;
    if (!apiKey) return [];
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const base = (ctx.options?.apiBaseUrl ?? SERPAPI_BASE_URL).replace(/\/$/, "");
    const bucket = pickBucket(ctx.options?.bucket, this.bucket);
    const out: StagedSignalRow[] = [];
    for (const account of ctx.watchlist) {
      const domain = account.domain.trim();
      if (!domain) continue;
      try {
        const url =
          `${base}/search.json?engine=google_news&q=${encodeURIComponent(`"${domain}"`)}` +
          `&api_key=${encodeURIComponent(apiKey)}`;
        const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
        if (!response.ok) continue;
        const data = (await response.json()) as {
          news_results?: Array<{ title?: string; link?: string; source?: { name?: string } | string; date?: string }>;
        };
        for (const item of data.news_results ?? []) {
          const title = typeof item.title === "string" ? item.title.trim() : "";
          if (!title) continue; // no headline -> no verbatim evidence -> drop
          const sourceName =
            typeof item.source === "string" ? item.source : item.source?.name ?? "";
          const quote = sourceName ? `${title} — ${sourceName}` : title;
          out.push({
            bucket,
            accountDomain: domain,
            trigger: `news: ${title}`,
            quote,
            sourceUrl: typeof item.link === "string" ? item.link : "",
          });
        }
      } catch {
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
export const hubspotFormsSource: SignalSourceConnector = {
  id: "hubspot-forms",
  bucket: "demand",
  shape: "pull",
  auth: "oauth",
  async fetch(ctx) {
    const token = ctx.getApiKey ? await ctx.getApiKey("hubspot") : null;
    if (!token) return [];
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const base = (ctx.options?.apiBaseUrl ?? HUBSPOT_BASE_URL).replace(/\/$/, "");
    const out: StagedSignalRow[] = [];
    let forms: Array<{ guid?: string; id?: string; name?: string }> = [];
    try {
      const response = await fetchImpl(`${base}/marketing/v3/forms`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { results?: typeof forms };
      forms = data.results ?? [];
    } catch {
      return [];
    }
    for (const form of forms) {
      const formId = form.guid ?? form.id;
      if (!formId) continue;
      const formName = typeof form.name === "string" && form.name ? form.name : "form";
      try {
        const response = await fetchImpl(
          `${base}/form-integrations/v1/submissions/forms/${encodeURIComponent(formId)}?limit=50`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
        );
        if (!response.ok) continue;
        const data = (await response.json()) as {
          results?: Array<{ values?: Array<{ name?: string; value?: string }>; submittedAt?: number }>;
        };
        for (const submission of data.results ?? []) {
          const email = fieldValue(submission.values, "email");
          const domain = corporateDomain(email);
          if (!domain) continue; // free-mail / no email: no account to attach to
          const submittedAt =
            typeof submission.submittedAt === "number"
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
      } catch {
        continue;
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Registry

const CONNECTORS: SignalSourceConnector[] = [fileSource, serpapiNewsSource, hubspotFormsSource];

const REGISTRY = new Map<string, SignalSourceConnector>(CONNECTORS.map((c) => [c.id, c]));

/** All registered source connectors (stable order). */
export function listSignalSources(): SignalSourceConnector[] {
  return [...CONNECTORS];
}

/** Resolve a connector by id, or null when unknown. */
export function getSignalSource(id: string): SignalSourceConnector | null {
  return REGISTRY.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Helpers

function coerceRow(row: Record<string, unknown>, defaultBucket: SignalBucket): StagedSignalRow {
  // Fill the bucket from the connector default when a file row omits it; the
  // central validator still rejects an unknown bucket and an empty quote.
  const bucket = row.bucket === undefined ? defaultBucket : (row.bucket as SignalBucket);
  return { ...(row as StagedSignalRow), bucket };
}

function pickBucket(raw: string | undefined, fallback: SignalBucket): SignalBucket {
  if (raw && SIGNAL_BUCKETS.includes(raw as SignalBucket)) return raw as SignalBucket;
  return fallback;
}

function fieldValue(values: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  for (const field of values ?? []) {
    if (field.name === name && typeof field.value === "string") return field.value.trim();
  }
  return "";
}

const FREE_MAIL = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

/** Company domain from an email, or "" for free-mail / no email. */
function corporateDomain(email: string): string {
  if (!email.includes("@")) return "";
  const domain = email.split("@").at(-1)!.trim().toLowerCase();
  if (!domain || FREE_MAIL.has(domain)) return "";
  return domain;
}

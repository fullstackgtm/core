import { ProviderHttpError } from "../providerError.js";
function splitName(full) {
    if (!full)
        return {};
    const parts = full.trim().split(/\s+/);
    if (parts.length === 1)
        return { firstName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
function bareDomain(value) {
    if (!value)
        return undefined;
    return value
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/.*$/, "")
        .toLowerCase() || undefined;
}
export async function fetchExploriumProspects(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = (opts.apiBaseUrl ?? "https://api.explorium.ai").replace(/\/$/, "");
    const size = Math.min(opts.size ?? 25, 100);
    const response = await fetchImpl(`${base}/v1/prospects`, {
        method: "POST",
        headers: { "api_key": opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full", size, page_size: size, page: 1, filters: opts.filters }),
    });
    if (!response.ok) {
        throw new ProviderHttpError("Explorium", "prospect search", response.status);
    }
    const data = (await response.json());
    return (data.data ?? []).map((row) => ({
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: row.full_name ?? ([row.first_name, row.last_name].filter(Boolean).join(" ") || undefined),
        jobTitle: row.job_title,
        jobLevel: row.job_level_main,
        jobDepartment: row.job_department_main,
        companyName: row.company_name,
        companyDomain: bareDomain(row.company_website),
        linkedin: normalizeLinkedin(row.linkedin),
        sourceId: row.prospect_id,
    }));
}
// ---------------------------------------------------------------------------
// pipe0 / Crustdata — net-new discovery (search). Crustdata is built into pipe0
// (no separate connection needed). Returns profiles; pair with
// pipe0ResolveWorkEmails to get real emails.
export async function fetchPipe0CrustdataProspects(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = (opts.apiBaseUrl ?? "https://api.pipe0.com").replace(/\/$/, "");
    const limit = Math.min(opts.limit ?? 25, 100);
    const response = await fetchImpl(`${base}/v1/searches/run/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            searches: [{ search_id: "people:profiles:crustdata@1", config: { limit, filters: opts.filters } }],
        }),
    });
    if (!response.ok) {
        throw new ProviderHttpError("pipe0", "prospect search", response.status);
    }
    const body = (await response.json());
    // Surface upstream provider errors (e.g. CreditBalanceInsufficient) instead of
    // silently returning [] — a throttle/credit failure must not look like "no ICP matches".
    const upstreamErrors = (body.search_statuses ?? []).flatMap((s) => s.errors ?? []);
    if (upstreamErrors.length > 0 && !(body.results ?? []).length) {
        throw new Error(`pipe0/Crustdata search error: ${upstreamErrors.map((e) => `${e.code ?? "error"}: ${e.message ?? ""}`).join("; ")}`);
    }
    return (body.results ?? []).map((row) => {
        const fullName = strField(row.name);
        const { firstName, lastName } = splitName(fullName);
        return {
            firstName,
            lastName,
            fullName,
            jobTitle: strField(row.job_title),
            companyDomain: bareDomain(strField(row.company_website_url)),
            linkedin: normalizeLinkedin(strField(row.profile_url)),
            sourceId: strField(row.profile_url) ?? fullName,
        };
    });
}
function strField(field) {
    const v = field?.value;
    return typeof v === "string" && v.trim() ? v : undefined;
}
// ---------------------------------------------------------------------------
// TAM universe count — "how many ACCOUNTS match this ICP firmographic?"
//
// Verified empirically (2026-06-25) against the live providers, because the
// obvious endpoints lie about totals:
//   - Explorium /v1/prospects `total_results` == the PAGE size (1→1, 10→10), not
//     the universe — useless for sizing. So is /v1/businesses for tiny pages? No:
//   - Explorium /v1/businesses `total_results` IS a real COUNT of matching
//     companies (US+10000-emp → 9,754; Liechtenstein+10000 → 11), capped at
//     EXPLORIUM_BUSINESS_COUNT_CAP. At/above the cap it saturates at exactly that
//     number, so the caller must treat a capped reading as a FLOOR, not a count.
//   - pipe0/Crustdata people search returns only a pagination cursor, NO total —
//     it cannot size a universe at all (callers use it for discovery, not counting).
// So the TAM count source is Explorium /v1/businesses (a company/account count).
export const EXPLORIUM_BUSINESS_COUNT_CAP = 60_000;
/**
 * Count the COMPANIES (accounts) matching an ICP firmographic via Explorium
 * /v1/businesses. Returns the real total (capped at 60k — `capped` flags the
 * ceiling) or null if the response carries no `total_results`. Use
 * `icpToExploriumBusinessFilters` to build `filters` (firmographic field names
 * differ from /v1/prospects).
 */
export async function probeExploriumBusinessCount(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = (opts.apiBaseUrl ?? "https://api.explorium.ai").replace(/\/$/, "");
    const response = await fetchImpl(`${base}/v1/businesses`, {
        method: "POST",
        headers: { "api_key": opts.apiKey, "Content-Type": "application/json" },
        // page_size 1: we want the envelope's total_results, not the rows. CRITICAL:
        // do NOT send `size` — Explorium caps total_results to `size` when present
        // (verified: size:1 → total_results:1; omitted → the real count, e.g. 19,058).
        body: JSON.stringify({ mode: "full", page_size: 1, page: 1, filters: opts.filters }),
    });
    if (!response.ok) {
        throw new ProviderHttpError("Explorium", "business count", response.status);
    }
    const body = (await response.json());
    const total = body.total_results;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0)
        return null;
    const rounded = Math.round(total);
    return { total: rounded, capped: rounded >= EXPLORIUM_BUSINESS_COUNT_CAP };
}
function normalizeLinkedin(value) {
    if (!value)
        return undefined;
    const v = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return v ? `https://${v}` : undefined;
}
// ---------------------------------------------------------------------------
// pipe0 — work-email resolution (waterfall)
/**
 * Resolve real work emails for people via pipe0's waterfall. Input rows need a
 * full name + a company domain (or name). Returns the prospects with `email`
 * filled where the waterfall found one; rows with no hit are returned unchanged.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Run `count` async tasks with at most `limit` in flight. Order-independent. */
async function runWithConcurrency(count, limit, worker) {
    const out = new Array(count);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, count || 1)) }, async () => {
        for (let i = next++; i < count; i = next++)
            out[i] = await worker(i);
    });
    await Promise.all(runners);
    return out;
}
/**
 * POST a pipe0 sync run with exponential backoff on transient failure
 * (throttle/5xx/network). pipe0's waterfall throttles under burst — a 429'd
 * chunk returns all-failed — so concurrency must be paired with real backoff,
 * not a single retry, or coverage collapses at scale (a parallel run without
 * this dropped the work-email hit-rate from ~79% to ~17%). Retries 500ms →
 * 1s → 2s → 4s (capped) so a throttled chunk lands on a later attempt instead
 * of being lost.
 */
async function pipe0Post(fetchImpl, base, apiKey, payload, maxAttempts = 5) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await fetchImpl(`${base}/v1/pipes/run/sync`, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (response.ok)
                return (await response.json());
            // non-ok (429/5xx) — fall through to backoff + retry
        }
        catch {
            // network error — fall through to backoff + retry
        }
        if (attempt < maxAttempts - 1)
            await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
    return undefined; // still failing after backoff — caller keeps the other chunks
}
export async function pipe0ResolveWorkEmails(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = (opts.apiBaseUrl ?? "https://api.pipe0.com").replace(/\/$/, "");
    const chunkSize = Math.max(1, opts.chunkSize ?? 3);
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    // Only rows with the waterfall's required inputs (name + company_domain|name).
    const resolvable = opts.prospects.filter((p) => p.fullName && (p.companyDomain || p.companyName));
    if (resolvable.length === 0)
        return opts.prospects;
    const chunks = [];
    for (let i = 0; i < resolvable.length; i += chunkSize)
        chunks.push(resolvable.slice(i, i + chunkSize));
    const perChunk = await runWithConcurrency(chunks.length, concurrency, async (ci) => {
        const input = chunks[ci].map((p) => ({
            name: p.fullName,
            ...(p.companyDomain ? { company_domain: p.companyDomain } : { company_name: p.companyName }),
        }));
        const body = await pipe0Post(fetchImpl, base, opts.apiKey, {
            pipes: [{ pipe_id: "person:workemail:waterfall@1" }],
            input,
        });
        const entries = [];
        for (const recordId of body?.order ?? []) {
            const fields = body.records?.[recordId]?.fields ?? {};
            const email = fields.work_email?.status === "completed" ? fieldValue(fields.work_email) : undefined;
            if (email) {
                const domain = fieldValue(fields.company_domain) ?? fieldValue(fields.company_name);
                entries.push([personKey(fieldValue(fields.name), domain), email]);
            }
        }
        return entries;
    });
    const emailByKey = new Map();
    for (const entries of perChunk)
        for (const [k, v] of entries)
            emailByKey.set(k, v);
    return opts.prospects.map((p) => {
        const email = emailByKey.get(personKey(p.fullName, p.companyDomain ?? p.companyName));
        return email ? { ...p, email } : p;
    });
}
function personKey(name, company) {
    return `${(name ?? "").trim().toLowerCase()}|${(company ?? "").trim().toLowerCase()}`;
}
/** Bare registrable host from a URL or domain string ("https://www.x.com/a" → "x.com"). */
export function hostFromUrl(url) {
    if (!url || !url.trim())
        return undefined;
    try {
        const u = url.includes("://") ? url : `https://${url}`;
        const host = new URL(u).hostname.replace(/^www\./, "");
        return host || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Fill `companyDomain` for prospects that have a company NAME but no domain,
 * using pipe0's `company:identity@1` pipe (name → website URL). The work-email
 * waterfall requires a domain — a LinkedIn/HeyReach list supplies only names, so
 * without this step every resolution fails. Resolves each unique company once
 * (companies repeat across a list); leaves a prospect untouched when the domain
 * can't be found, so the waterfall simply skips it rather than guessing.
 */
export async function pipe0ResolveCompanyDomains(opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = (opts.apiBaseUrl ?? "https://api.pipe0.com").replace(/\/$/, "");
    const chunkSize = Math.max(1, opts.chunkSize ?? 5);
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    const uniqueNames = [
        ...new Set(opts.prospects
            .filter((p) => !p.companyDomain && p.companyName)
            .map((p) => p.companyName.trim())
            .filter(Boolean)),
    ];
    if (uniqueNames.length === 0)
        return opts.prospects;
    const chunks = [];
    for (let i = 0; i < uniqueNames.length; i += chunkSize)
        chunks.push(uniqueNames.slice(i, i + chunkSize));
    const perChunk = await runWithConcurrency(chunks.length, concurrency, async (ci) => {
        const body = await pipe0Post(fetchImpl, base, opts.apiKey, {
            pipes: [{ pipe_id: "company:identity@1" }],
            input: chunks[ci].map((company_name) => ({ company_name })),
        });
        const entries = [];
        for (const recordId of body?.order ?? []) {
            const fields = body.records?.[recordId]?.fields ?? {};
            const name = fieldValue(fields.company_name) ?? fieldValue(fields.cleaned_company_name);
            const domain = hostFromUrl(fieldValue(fields.company_website_url));
            if (name && domain)
                entries.push([name.trim().toLowerCase(), domain]);
        }
        return entries;
    });
    const domainByName = new Map();
    for (const entries of perChunk)
        for (const [k, v] of entries)
            domainByName.set(k, v);
    return opts.prospects.map((p) => {
        if (p.companyDomain || !p.companyName)
            return p;
        const domain = domainByName.get(p.companyName.trim().toLowerCase());
        return domain ? { ...p, companyDomain: domain } : p;
    });
}
function fieldValue(field) {
    const v = field?.value;
    return typeof v === "string" && v.trim() ? v : undefined;
}
// ---------------------------------------------------------------------------
// Pre-email dedup: identity keys shared between prospects and CRM contacts, so
// we can drop already-in-CRM / already-seen people BEFORE paying for emails.
function normName(value) {
    return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
/**
 * Stable identity keys for a prospect (prefixed by kind). A match on ANY key
 * means "same person". LinkedIn is strongest; name+domain is the only key
 * shareable with the canonical CRM snapshot (which has no LinkedIn); email is
 * available only after resolution (so it can't pre-filter, but it strengthens
 * the seen cache).
 */
export function prospectIdentityKeys(p) {
    const keys = [];
    if (p.linkedin)
        keys.push(`li:${p.linkedin.trim().toLowerCase().replace(/\/+$/, "")}`);
    const name = normName(p.fullName ?? [p.firstName, p.lastName].filter(Boolean).join(" "));
    const domain = bareDomain(p.companyDomain);
    if (name && domain)
        keys.push(`nd:${name}|${domain}`);
    if (p.email)
        keys.push(`em:${p.email.trim().toLowerCase()}`);
    return keys;
}
/** Identity keys for every contact already in the CRM snapshot (email + name|domain). */
export function crmContactKeys(snapshot) {
    const domainByAccount = new Map();
    for (const account of snapshot.accounts ?? []) {
        const d = bareDomain(account.domain);
        if (d)
            domainByAccount.set(account.id, d);
    }
    const set = new Set();
    for (const contact of snapshot.contacts ?? []) {
        if (contact.linkedin)
            set.add(`li:${contact.linkedin.trim().toLowerCase().replace(/\/+$/, "")}`);
        if (contact.email)
            set.add(`em:${contact.email.trim().toLowerCase()}`);
        const name = normName([contact.firstName, contact.lastName].filter(Boolean).join(" "));
        const domain = contact.accountId ? domainByAccount.get(contact.accountId) : undefined;
        if (name && domain)
            set.add(`nd:${name}|${domain}`);
    }
    return set;
}
/**
 * Split prospects into those worth paying to enrich vs. drop. A prospect is
 * dropped if any identity key is already in the CRM (`crmKeys`) or in the
 * cross-run `seen` cache. Pure + deterministic.
 */
export function partitionFreshProspects(prospects, crmKeys, seen) {
    const fresh = [];
    let skippedCrm = 0;
    let skippedSeen = 0;
    for (const p of prospects) {
        const keys = prospectIdentityKeys(p);
        if (keys.some((k) => crmKeys.has(k))) {
            skippedCrm += 1;
            continue;
        }
        if (keys.some((k) => seen.has(k))) {
            skippedSeen += 1;
            continue;
        }
        fresh.push(p);
    }
    return { fresh, skippedCrm, skippedSeen };
}

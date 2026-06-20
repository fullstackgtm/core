/**
 * API prospect sources for `enrich acquire` — net-new lead discovery + email
 * resolution, behind one normalized shape the acquire builder consumes.
 *
 * Two confirmed providers (others slot in the same way):
 *  - Explorium  — net-new discovery (POST /v1/prospects). Returns names, titles,
 *    company + website, LinkedIn; the email it returns is HASHED, so it is a
 *    discovery source, not an email source.
 *  - pipe0      — work-email resolution (POST /v1/pipes/run/sync with the
 *    `person:workemail:waterfall@1` block). Turns {name, company_domain} into a
 *    real work email. This is the email leg for Explorium-discovered people.
 *
 * Zero runtime deps: global fetch only, injectable for tests. Keys arrive via
 * env/credential store, never argv.
 */
import type { CanonicalGtmSnapshot } from "../types.ts";

export type Prospect = {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jobTitle?: string;
  /** normalized seniority, e.g. "cxo","vp","director" (Explorium job_level_main) */
  jobLevel?: string;
  /** normalized department, e.g. "sales" (Explorium job_department_main) */
  jobDepartment?: string;
  companyName?: string;
  /** bare domain, e.g. "microsoft.com" — feeds pipe0's company_domain */
  companyDomain?: string;
  linkedin?: string;
  /** real work email once resolved (pipe0); never the hashed value */
  email?: string;
  /** ICP fit score 0..1, set by the acquire scorer */
  fitScore?: number;
  /** provider-native id for traceability */
  sourceId?: string;
};

function splitName(full: string | undefined): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

type FetchImpl = typeof fetch;

function bareDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase() || undefined;
}

// ---------------------------------------------------------------------------
// Explorium — net-new discovery

export type ExploriumFilters = Record<string, { values?: string[]; value?: boolean }>;

export async function fetchExploriumProspects(opts: {
  apiKey: string;
  filters: ExploriumFilters;
  size?: number;
  apiBaseUrl?: string;
  fetchImpl?: FetchImpl;
}): Promise<Prospect[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? "https://api.explorium.ai").replace(/\/$/, "");
  const size = Math.min(opts.size ?? 25, 100);
  const response = await fetchImpl(`${base}/v1/prospects`, {
    method: "POST",
    headers: { "api_key": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "full", size, page_size: size, page: 1, filters: opts.filters }),
  });
  if (!response.ok) {
    throw new Error(`Explorium /v1/prospects failed: HTTP ${response.status} ${await safeText(response)}`);
  }
  const data = (await response.json()) as { data?: ExploriumRow[] };
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

type ExploriumRow = {
  prospect_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_title?: string;
  job_level_main?: string;
  job_department_main?: string;
  company_name?: string;
  company_website?: string;
  linkedin?: string;
};

// ---------------------------------------------------------------------------
// pipe0 / Crustdata — net-new discovery (search). Crustdata is built into pipe0
// (no separate connection needed). Returns profiles; pair with
// pipe0ResolveWorkEmails to get real emails.

export async function fetchPipe0CrustdataProspects(opts: {
  apiKey: string;
  filters: Record<string, unknown>;
  limit?: number;
  apiBaseUrl?: string;
  fetchImpl?: FetchImpl;
}): Promise<Prospect[]> {
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
    throw new Error(`pipe0 /v1/searches/run/sync failed: HTTP ${response.status} ${await safeText(response)}`);
  }
  const body = (await response.json()) as {
    results?: Array<Record<string, { value?: unknown }>>;
    search_statuses?: Array<{ errors?: Array<{ code?: string; message?: string }> }>;
  };
  // Surface upstream provider errors (e.g. CreditBalanceInsufficient) instead of
  // silently returning [] — a throttle/credit failure must not look like "no ICP matches".
  const upstreamErrors = (body.search_statuses ?? []).flatMap((s) => s.errors ?? []);
  if (upstreamErrors.length > 0 && !(body.results ?? []).length) {
    throw new Error(
      `pipe0/Crustdata search error: ${upstreamErrors.map((e) => `${e.code ?? "error"}: ${e.message ?? ""}`).join("; ")}`,
    );
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

function strField(field: { value?: unknown } | undefined): string | undefined {
  const v = field?.value;
  return typeof v === "string" && v.trim() ? v : undefined;
}

function normalizeLinkedin(value: string | undefined): string | undefined {
  if (!value) return undefined;
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
export async function pipe0ResolveWorkEmails(opts: {
  apiKey: string;
  prospects: Prospect[];
  apiBaseUrl?: string;
  fetchImpl?: FetchImpl;
  /** Rows per pipe0 call. Small chunks are resilient to the waterfall's
   *  batch rate-limit (a throttled chunk returns work_email status "failed"
   *  for every row, so one big batch is all-or-nothing). Default 3. */
  chunkSize?: number;
}): Promise<Prospect[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? "https://api.pipe0.com").replace(/\/$/, "");
  const chunkSize = Math.max(1, opts.chunkSize ?? 3);

  // Only rows with the waterfall's required inputs (name + company_domain|name).
  const resolvable = opts.prospects.filter((p) => p.fullName && (p.companyDomain || p.companyName));
  if (resolvable.length === 0) return opts.prospects;

  const emailByKey = new Map<string, string>();
  for (let i = 0; i < resolvable.length; i += chunkSize) {
    const chunk = resolvable.slice(i, i + chunkSize);
    const input = chunk.map((p) => ({
      name: p.fullName,
      ...(p.companyDomain ? { company_domain: p.companyDomain } : { company_name: p.companyName }),
    }));
    let body: Pipe0RunResponse;
    try {
      const response = await fetchImpl(`${base}/v1/pipes/run/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pipes: [{ pipe_id: "person:workemail:waterfall@1" }], input }),
      });
      if (!response.ok) continue; // throttled/5xx chunk — skip, keep the rest
      body = (await response.json()) as Pipe0RunResponse;
    } catch {
      continue; // network hiccup on one chunk must not sink the whole run
    }
    for (const recordId of body.order ?? []) {
      const fields = body.records?.[recordId]?.fields ?? {};
      const email = fields.work_email?.status === "completed" ? fieldValue(fields.work_email) : undefined;
      if (email) {
        const domain = fieldValue(fields.company_domain) ?? fieldValue(fields.company_name);
        emailByKey.set(personKey(fieldValue(fields.name), domain), email);
      }
    }
  }
  return opts.prospects.map((p) => {
    const email = emailByKey.get(personKey(p.fullName, p.companyDomain ?? p.companyName));
    return email ? { ...p, email } : p;
  });
}

function personKey(name: string | undefined, company: string | undefined): string {
  return `${(name ?? "").trim().toLowerCase()}|${(company ?? "").trim().toLowerCase()}`;
}

type Pipe0Field = { value?: unknown; status?: string };
type Pipe0RunResponse = {
  order?: string[];
  records?: Record<string, { fields?: Record<string, Pipe0Field> }>;
};

function fieldValue(field: Pipe0Field | undefined): string | undefined {
  const v = field?.value;
  return typeof v === "string" && v.trim() ? v : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Pre-email dedup: identity keys shared between prospects and CRM contacts, so
// we can drop already-in-CRM / already-seen people BEFORE paying for emails.

function normName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Stable identity keys for a prospect (prefixed by kind). A match on ANY key
 * means "same person". LinkedIn is strongest; name+domain is the only key
 * shareable with the canonical CRM snapshot (which has no LinkedIn); email is
 * available only after resolution (so it can't pre-filter, but it strengthens
 * the seen cache).
 */
export function prospectIdentityKeys(p: Prospect): string[] {
  const keys: string[] = [];
  if (p.linkedin) keys.push(`li:${p.linkedin.trim().toLowerCase().replace(/\/+$/, "")}`);
  const name = normName(p.fullName ?? [p.firstName, p.lastName].filter(Boolean).join(" "));
  const domain = bareDomain(p.companyDomain);
  if (name && domain) keys.push(`nd:${name}|${domain}`);
  if (p.email) keys.push(`em:${p.email.trim().toLowerCase()}`);
  return keys;
}

/** Identity keys for every contact already in the CRM snapshot (email + name|domain). */
export function crmContactKeys(snapshot: CanonicalGtmSnapshot): Set<string> {
  const domainByAccount = new Map<string, string>();
  for (const account of snapshot.accounts ?? []) {
    const d = bareDomain(account.domain);
    if (d) domainByAccount.set(account.id, d);
  }
  const set = new Set<string>();
  for (const contact of snapshot.contacts ?? []) {
    if (contact.linkedin) set.add(`li:${contact.linkedin.trim().toLowerCase().replace(/\/+$/, "")}`);
    if (contact.email) set.add(`em:${contact.email.trim().toLowerCase()}`);
    const name = normName([contact.firstName, contact.lastName].filter(Boolean).join(" "));
    const domain = contact.accountId ? domainByAccount.get(contact.accountId) : undefined;
    if (name && domain) set.add(`nd:${name}|${domain}`);
  }
  return set;
}

/**
 * Split prospects into those worth paying to enrich vs. drop. A prospect is
 * dropped if any identity key is already in the CRM (`crmKeys`) or in the
 * cross-run `seen` cache. Pure + deterministic.
 */
export function partitionFreshProspects(
  prospects: Prospect[],
  crmKeys: Set<string>,
  seen: Set<string>,
): { fresh: Prospect[]; skippedCrm: number; skippedSeen: number } {
  const fresh: Prospect[] = [];
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

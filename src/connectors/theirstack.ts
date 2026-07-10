/**
 * TheirStack — technographic company discovery.
 *
 * Explorium can only size a firmographic universe (NAICS/size/geo) and can't even
 * return the list. For a CRM-hygiene/RevOps tool the real buying signal is
 * "company runs a CRM", and the deliverable is an actual list of those companies.
 * TheirStack does both: filter companies by the technology they use (Salesforce,
 * HubSpot, Pipedrive, …) plus firmographics, and return real records (name,
 * domain, employee_count, …). A cheap count sizes the market; a paged search
 * materializes the list. Both cost ~3 credits per company RETURNED — counting
 * still returns 1 row (the API rejects limit:0), so a count is ~3 credits, not
 * free; a list pull is ~3 × the rows.
 *
 * API: POST https://api.theirstack.com/v1/companies/search, Bearer auth.
 * Verified live (2026-06-29): filters company_technology_slug_or /
 * company_country_code_or / min_employee_count / max_employee_count; the total is
 * `metadata.total_results` with include_total_results:true; limit must be ≥ 1
 * (limit:0 → 422, the count gotcha — cf. Explorium's `size`-caps-the-total).
 */
import { ProviderHttpError } from "../providerError.ts";

type FetchImpl = typeof fetch;

/** TheirStack charges per company RETURNED — verified live (a list pull of N
 *  companies spends 3N). The count (limit:1) returns 1 row, so it's ~3 credits. */
export const THEIRSTACK_CREDITS_PER_COMPANY = 3;

export type TheirStackCost = {
  companies: number;
  credits: number;
  /** USD estimate — present ONLY when a per-credit rate is supplied (no
   *  fabricated default; TheirStack pricing varies ~$0.04–$0.11/credit by tier). */
  usd?: number;
};

/** Deterministic cost of pulling `companies` records (the credits are the hard
 *  fact; the dollar figure needs an explicit rate). */
export function theirStackPullCost(companies: number, usdPerCredit?: number): TheirStackCost {
  const n = Math.max(0, Math.round(companies));
  const credits = n * THEIRSTACK_CREDITS_PER_COMPANY;
  return {
    companies: n,
    credits,
    ...(usdPerCredit && usdPerCredit > 0 ? { usd: Math.round(credits * usdPerCredit) } : {}),
  };
}

/** Firmographic + technographic filter for TheirStack company search. */
export type TheirStackFilters = {
  /** technology slugs, OR-matched — e.g. ["salesforce","hubspot","pipedrive"]. */
  company_technology_slug_or?: string[];
  min_employee_count?: number;
  max_employee_count?: number;
  /** ISO2 country codes, OR-matched — e.g. ["US"]. */
  company_country_code_or?: string[];
};

/** A real company record from TheirStack (the materialized list element). */
export type TheirStackCompany = {
  name?: string;
  domain?: string;
  employeeCount?: number;
  countryCode?: string;
  city?: string;
  linkedinUrl?: string;
  /** the matched technology slugs that put this company in the list. */
  technologies?: string[];
};

const BASE = "https://api.theirstack.com";
const SEARCH_PATH = "/v1/companies/search";

function buildBody(filters: TheirStackFilters, limit: number, page: number, includeTotal: boolean): string {
  // Drop undefined keys so we never send empty filters the API rejects.
  const body: Record<string, unknown> = { limit, page };
  if (includeTotal) body.include_total_results = true;
  if (filters.company_technology_slug_or?.length) body.company_technology_slug_or = filters.company_technology_slug_or;
  if (filters.company_country_code_or?.length) body.company_country_code_or = filters.company_country_code_or;
  if (typeof filters.min_employee_count === "number") body.min_employee_count = filters.min_employee_count;
  if (typeof filters.max_employee_count === "number") body.max_employee_count = filters.max_employee_count;
  return JSON.stringify(body);
}

/** Read the total-match count from the response envelope (field name varies). */
export function readTheirStackTotal(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const meta = (obj.metadata ?? obj.meta ?? obj) as Record<string, unknown>;
  for (const key of ["total_results", "total_companies", "total_count", "total", "count"]) {
    const v = meta[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  return null;
}

function mapCompany(row: Record<string, unknown>): TheirStackCompany {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const slugs = row.technology_slugs ?? row.technology_names;
  return {
    name: str(row.name),
    domain: str(row.domain),
    employeeCount: num(row.employee_count),
    countryCode: str(row.country_code),
    city: str(row.city),
    linkedinUrl: str(row.linkedin_url),
    technologies: Array.isArray(slugs) ? slugs.filter((s): s is string => typeof s === "string") : undefined,
  };
}

/**
 * Count companies matching the technographic + firmographic filter — the real
 * TAM size. Uses `limit: 1` (the API rejects `limit: 0` with a 422 — verified
 * live) + `include_total_results`, and reads `metadata.total_results`. Costs the
 * 1 returned company's credits; the total itself is the point.
 * Returns null if the envelope carries no total.
 */
export async function theirStackCountCompanies(opts: {
  apiKey: string;
  filters: TheirStackFilters;
  apiBaseUrl?: string;
  fetchImpl?: FetchImpl;
}): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? BASE).replace(/\/$/, "");
  const res = await fetchImpl(`${base}${SEARCH_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: buildBody(opts.filters, 1, 0, true),
  });
  if (!res.ok) {
    throw new ProviderHttpError("TheirStack", "count", res.status);
  }
  return readTheirStackTotal(await res.json());
}

/**
 * Pull a page of real companies matching the filter — the materialized list.
 * Returns the records plus the total (when the envelope reports it).
 */
export async function theirStackSearchCompanies(opts: {
  apiKey: string;
  filters: TheirStackFilters;
  limit?: number;
  page?: number;
  apiBaseUrl?: string;
  fetchImpl?: FetchImpl;
}): Promise<{ companies: TheirStackCompany[]; total: number | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? BASE).replace(/\/$/, "");
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const res = await fetchImpl(`${base}${SEARCH_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: buildBody(opts.filters, limit, opts.page ?? 0, true),
  });
  if (!res.ok) {
    throw new ProviderHttpError("TheirStack", "search", res.status);
  }
  const body = (await res.json()) as { data?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
  const rows = body.data ?? body.results ?? [];
  return { companies: rows.map(mapCompany), total: readTheirStackTotal(body) };
}

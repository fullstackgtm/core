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
type FetchImpl = typeof fetch;
/** TheirStack charges per company RETURNED — verified live (a list pull of N
 *  companies spends 3N). The count (limit:1) returns 1 row, so it's ~3 credits. */
export declare const THEIRSTACK_CREDITS_PER_COMPANY = 3;
export type TheirStackCost = {
    companies: number;
    credits: number;
    /** USD estimate — present ONLY when a per-credit rate is supplied (no
     *  fabricated default; TheirStack pricing varies ~$0.04–$0.11/credit by tier). */
    usd?: number;
};
/** Deterministic cost of pulling `companies` records (the credits are the hard
 *  fact; the dollar figure needs an explicit rate). */
export declare function theirStackPullCost(companies: number, usdPerCredit?: number): TheirStackCost;
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
/** Read the total-match count from the response envelope (field name varies). */
export declare function readTheirStackTotal(body: unknown): number | null;
/**
 * Count companies matching the technographic + firmographic filter — the real
 * TAM size. Uses `limit: 1` (the API rejects `limit: 0` with a 422 — verified
 * live) + `include_total_results`, and reads `metadata.total_results`. Costs the
 * 1 returned company's credits; the total itself is the point.
 * Returns null if the envelope carries no total.
 */
export declare function theirStackCountCompanies(opts: {
    apiKey: string;
    filters: TheirStackFilters;
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
}): Promise<number | null>;
/**
 * Pull a page of real companies matching the filter — the materialized list.
 * Returns the records plus the total (when the envelope reports it).
 */
export declare function theirStackSearchCompanies(opts: {
    apiKey: string;
    filters: TheirStackFilters;
    limit?: number;
    page?: number;
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
}): Promise<{
    companies: TheirStackCompany[];
    total: number | null;
}>;
export {};

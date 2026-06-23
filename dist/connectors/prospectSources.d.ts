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
    /** LinkedIn headline — secondary role signal for ICP scoring (the title
     *  keyword may live here, not in the formal jobTitle). */
    headline?: string;
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
type FetchImpl = typeof fetch;
export type ExploriumFilters = Record<string, {
    values?: string[];
    value?: boolean;
}>;
export declare function fetchExploriumProspects(opts: {
    apiKey: string;
    filters: ExploriumFilters;
    size?: number;
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
}): Promise<Prospect[]>;
export declare function fetchPipe0CrustdataProspects(opts: {
    apiKey: string;
    filters: Record<string, unknown>;
    limit?: number;
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
}): Promise<Prospect[]>;
/**
 * Resolve real work emails for people via pipe0's waterfall. Input rows need a
 * full name + a company domain (or name). Returns the prospects with `email`
 * filled where the waterfall found one; rows with no hit are returned unchanged.
 */
export declare function pipe0ResolveWorkEmails(opts: {
    apiKey: string;
    prospects: Prospect[];
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
    /** Rows per pipe0 call. Small chunks are resilient to the waterfall's
     *  batch rate-limit (a throttled chunk returns work_email status "failed"
     *  for every row, so one big batch is all-or-nothing). Default 3. */
    chunkSize?: number;
}): Promise<Prospect[]>;
/** Bare registrable host from a URL or domain string ("https://www.x.com/a" → "x.com"). */
export declare function hostFromUrl(url: string | undefined): string | undefined;
/**
 * Fill `companyDomain` for prospects that have a company NAME but no domain,
 * using pipe0's `company:identity@1` pipe (name → website URL). The work-email
 * waterfall requires a domain — a LinkedIn/HeyReach list supplies only names, so
 * without this step every resolution fails. Resolves each unique company once
 * (companies repeat across a list); leaves a prospect untouched when the domain
 * can't be found, so the waterfall simply skips it rather than guessing.
 */
export declare function pipe0ResolveCompanyDomains(opts: {
    apiKey: string;
    prospects: Prospect[];
    apiBaseUrl?: string;
    fetchImpl?: FetchImpl;
    chunkSize?: number;
}): Promise<Prospect[]>;
/**
 * Stable identity keys for a prospect (prefixed by kind). A match on ANY key
 * means "same person". LinkedIn is strongest; name+domain is the only key
 * shareable with the canonical CRM snapshot (which has no LinkedIn); email is
 * available only after resolution (so it can't pre-filter, but it strengthens
 * the seen cache).
 */
export declare function prospectIdentityKeys(p: Prospect): string[];
/** Identity keys for every contact already in the CRM snapshot (email + name|domain). */
export declare function crmContactKeys(snapshot: CanonicalGtmSnapshot): Set<string>;
/**
 * Split prospects into those worth paying to enrich vs. drop. A prospect is
 * dropped if any identity key is already in the CRM (`crmKeys`) or in the
 * cross-run `seen` cache. Pure + deterministic.
 */
export declare function partitionFreshProspects(prospects: Prospect[], crmKeys: Set<string>, seen: Set<string>): {
    fresh: Prospect[];
    skippedCrm: number;
    skippedSeen: number;
};
export {};

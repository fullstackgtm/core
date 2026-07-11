/**
 * ICP — the Ideal Customer Profile that makes `enrich acquire` targeted instead
 * of random. One structured artifact drives two things:
 *   1. discovery filters — translated per provider (Explorium, pipe0/Crustdata)
 *      so the pull only returns ICP-shaped companies + people, and
 *   2. fit scoring — every discovered prospect is scored against the persona so
 *      only above-threshold leads become create_record ops.
 *
 * Develop one via interview: an agent (Claude Code / Codex) reads INTERVIEW_SPEC,
 * asks the questions with its AskUserQuestion tool, and writes the answers into
 * an Icp (CLI: `icp interview` emits the spec, `icp show` renders the result).
 *
 * Zero runtime deps; pure functions (translation + scoring take plain data).
 */
export type Icp = {
    name: string;
    firmographics: {
        /** human industry labels, e.g. ["software","saas"] — used for keyword/industry filters */
        industries?: string[];
        /** Explorium naics_category codes, e.g. ["5112"] (software publishers) */
        naics?: string[];
        /** provider-agnostic employee bands: "1-10","11-50","51-200","201-500","501-1000","1001-5000","5001-10000","10001+" */
        employeeBands?: string[];
        /** ISO country codes, lowercased, e.g. ["us"] */
        geos?: string[];
        /** technographic targeting: technology slugs the account must use, e.g.
         *  ["salesforce","hubspot","pipedrive"] — the real CRM/MAP buying signal,
         *  consumed by TheirStack company search. OR-matched. */
        technologies?: string[];
    };
    persona: {
        /** seniority: "cxo","vp","director","manager","owner","senior" */
        jobLevels?: string[];
        /** "sales","marketing","operations","finance" */
        departments?: string[];
        /** the title phrases that DEFINE the buyer — also the scoring signal */
        titleKeywords?: string[];
    };
    signals?: {
        intentTopics?: string[];
    };
    scoring?: {
        /** minimum fit (0..1) for a prospect to become a create_record op. Default 0.5. */
        threshold?: number;
    };
};
export declare const DEFAULT_FIT_THRESHOLD = 0.5;
export declare function parseIcp(raw: string): Icp;
/** Explorium /v1/prospects filters from the ICP. */
export declare function icpToExploriumFilters(icp: Icp): Record<string, {
    values?: string[];
    value?: boolean;
}>;
/**
 * Explorium /v1/businesses filters from the ICP — the COMPANY (account) side, for
 * sizing the account universe (TAM). Firmographics only, no persona: the count is
 * of matching companies. Field names differ from /v1/prospects (verified live):
 * `country_code` (not company_country_code), `company_size` (same employee bands),
 * `naics_category`. `/v1/businesses` total_results is a real count, capped at
 * 60,000 (see EXPLORIUM_BUSINESS_COUNT_CAP in the connector).
 */
export declare function icpToExploriumBusinessFilters(icp: Icp): Record<string, {
    values?: string[];
}>;
/**
 * Collapse provider-agnostic employee bands ("51-200","10001+") into a single
 * {min,max} envelope for APIs that take integer bounds (TheirStack). An open
 * top band ("10001+") leaves max undefined.
 */
export declare function employeeBandsToRange(bands: string[] | undefined): {
    min?: number;
    max?: number;
};
/**
 * TheirStack company-search filter from the ICP: the technographic targeting that
 * Explorium can't do. `company_technology_slug_or` is the CRM/MAP buying signal
 * (firmographics.technologies); employee bands become min/max bounds; geos become
 * ISO2 codes (uppercased).
 */
export declare function icpToTheirStackFilters(icp: Icp): {
    company_technology_slug_or?: string[];
    min_employee_count?: number;
    max_employee_count?: number;
    company_country_code_or?: string[];
};
/**
 * pipe0 Crustdata people-search config.filters from the ICP. `current_job_titles`
 * matches real LinkedIn title strings (case-sensitive), so keywords are Title
 * Cased. Industry is mapped to Crustdata's controlled vocab via the table above.
 *
 * LIVE FINDINGS (2026-06-26, re-confirmed 2026-07-02 with fresh credits):
 * `current_job_titles` works; `current_title` is rejected (422). The culprit
 * that zeroed the full ICP filter is `current_seniority_levels`: ANY non-empty
 * `include` returns 0 results through pipe0's people:profiles:crustdata@1 —
 * including Crustdata's own documented values ("CXO", "Director",
 * "Vice President"), lowercase, and SNAKE_CASE variants — while the identical
 * search without it returns results. (An array instead of the
 * {include, exclude} object is a 422, so the shape was right; the filter is
 * broken upstream.) So job levels are NOT sent to the provider: persona
 * seniority is enforced by fit scoring (scoreProspectAgainstIcp weights
 * jobLevels), which was always the precision backstop. `locations` and
 * `current_employers_linkedin_industries` (both-taxonomy hedge) are live-
 * verified working in combination with titles. Note fit-scoring backs up
 * PERSONA precision but NOT industry, so the industry filter is load-bearing.
 */
export declare function icpToCrustdataFilters(icp: Icp): Record<string, unknown>;
/** Clay people-search filters using only fields confirmed in the live catalog. */
export declare function icpToClayPeopleFilters(icp: Icp): Record<string, unknown>;
export type IcpFit = {
    score: number;
    reasons: string[];
};
/**
 * Score a prospect's PERSONA fit 0..1. Title-keyword match is the strongest
 * signal (it's what defines the buyer); job level and department add to it.
 * Firmographics aren't re-scored here — discovery already filtered on them.
 */
export declare function scoreProspectAgainstIcp(prospect: {
    jobTitle?: string;
    jobLevel?: string;
    jobDepartment?: string;
    headline?: string;
}, icp: Icp): IcpFit;
export declare function fitThreshold(icp: Icp): number;
export type IcpInterviewQuestion = {
    id: keyof FlatIcpAnswers;
    header: string;
    question: string;
    multiSelect: boolean;
    options: {
        label: string;
        value: string | string[];
        description: string;
    }[];
};
/** Flattened answer keys the interview collects (assembled into an Icp). */
export type FlatIcpAnswers = {
    industries: string[];
    employeeBands: string[];
    jobLevels: string[];
    departments: string[];
    titleKeywords: string[];
    geos: string[];
};
export declare const INTERVIEW_SPEC: IcpInterviewQuestion[];
/** Assemble an Icp from flattened interview answers. */
export declare function icpFromAnswers(name: string, answers: FlatIcpAnswers): Icp;

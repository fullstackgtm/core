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
 * pipe0 Crustdata people-search config.filters from the ICP. `current_job_titles`
 * matches real LinkedIn title strings (case-sensitive), so keywords are Title
 * Cased. Seniority + industry are mapped to Crustdata's controlled vocab via the
 * tables above. NOTE: the exact pipe0→Crustdata value set could not be re-run
 * live (pipe0 credits were exhausted) — validate when credits refill; fit
 * scoring is the safety net for persona precision regardless.
 */
export declare function icpToCrustdataFilters(icp: Icp): Record<string, unknown>;
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

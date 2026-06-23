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
export const DEFAULT_FIT_THRESHOLD = 0.5;
const COUNTRY_NAMES = {
    us: "United States",
    ca: "Canada",
    gb: "United Kingdom",
    uk: "United Kingdom",
};
export function parseIcp(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`icp: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!parsed || typeof parsed !== "object")
        throw new Error("icp: expected a JSON object");
    const icp = parsed;
    if (!icp.name || typeof icp.name !== "string")
        throw new Error('icp: missing "name"');
    if (!icp.persona || (!icp.persona.titleKeywords?.length && !icp.persona.jobLevels?.length)) {
        throw new Error('icp: "persona" needs at least titleKeywords or jobLevels (without them, scoring cannot rank fit)');
    }
    return icp;
}
// ---------------------------------------------------------------------------
// Discovery-filter translation
/** Explorium /v1/prospects filters from the ICP. */
export function icpToExploriumFilters(icp) {
    const f = { has_email: { value: true } };
    if (icp.persona.jobLevels?.length)
        f.job_level = { values: icp.persona.jobLevels };
    if (icp.persona.departments?.length)
        f.job_department = { values: icp.persona.departments };
    if (icp.firmographics.employeeBands?.length)
        f.company_size = { values: icp.firmographics.employeeBands };
    if (icp.firmographics.geos?.length)
        f.company_country_code = { values: icp.firmographics.geos };
    if (icp.firmographics.naics?.length)
        f.naics_category = { values: icp.firmographics.naics };
    return f;
}
/**
 * Crustdata / LinkedIn seniority vocab. ICP job levels are normalized lowercase;
 * Crustdata expects these exact capitalized strings (verified: "CXO",
 * "Vice President", "Director" appear in Crustdata's docs/examples).
 */
const CRUSTDATA_SENIORITY = {
    cxo: "CXO",
    "c-suite": "CXO",
    c_suite: "CXO",
    founder: "Owner",
    owner: "Owner",
    partner: "Partner",
    vp: "Vice President",
    "vice president": "Vice President",
    head: "Director",
    director: "Director",
    manager: "Manager",
    senior: "Senior",
    entry: "Entry",
};
/**
 * ICP industry keyword → LinkedIn industry names Crustdata filters on. Includes
 * the current LinkedIn-v2 names; for software we send the cluster (dev + IT
 * services + internet) so an OR match isn't overly narrow.
 */
const CRUSTDATA_INDUSTRY = {
    software: ["Software Development", "Information Technology and Services", "Internet"],
    saas: ["Software Development", "Information Technology and Services"],
    "information technology & services": ["Information Technology and Services"],
    "information technology and services": ["Information Technology and Services"],
    internet: ["Internet"],
    fintech: ["Financial Services"],
    "financial services": ["Financial Services"],
};
/**
 * pipe0 Crustdata people-search config.filters from the ICP. `current_job_titles`
 * matches real LinkedIn title strings (case-sensitive), so keywords are Title
 * Cased. Seniority + industry are mapped to Crustdata's controlled vocab via the
 * tables above. NOTE: the exact pipe0→Crustdata value set could not be re-run
 * live (pipe0 credits were exhausted) — validate when credits refill; fit
 * scoring is the safety net for persona precision regardless.
 */
export function icpToCrustdataFilters(icp) {
    const f = {};
    if (icp.persona.titleKeywords?.length)
        f.current_job_titles = icp.persona.titleKeywords.map(titleCase);
    if (icp.firmographics.geos?.length) {
        f.locations = icp.firmographics.geos.map((g) => COUNTRY_NAMES[g.toLowerCase()] ?? g);
    }
    if (icp.persona.jobLevels?.length) {
        const include = [...new Set(icp.persona.jobLevels.map((l) => CRUSTDATA_SENIORITY[l.toLowerCase()]).filter(Boolean))];
        if (include.length)
            f.current_seniority_levels = { include, exclude: [] };
    }
    if (icp.firmographics.industries?.length) {
        const inds = [
            ...new Set(icp.firmographics.industries.flatMap((i) => CRUSTDATA_INDUSTRY[i.toLowerCase()] ?? [titleCase(i)])),
        ];
        if (inds.length)
            f.current_employers_linkedin_industries = inds;
    }
    return f;
}
const ACRONYMS = new Set(["cro", "coo", "ceo", "cfo", "vp", "crm", "gtm", "saas"]);
function titleCase(value) {
    return value
        .split(/\s+/)
        .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(" ");
}
/**
 * Score a prospect's PERSONA fit 0..1. Title-keyword match is the strongest
 * signal (it's what defines the buyer); job level and department add to it.
 * Firmographics aren't re-scored here — discovery already filtered on them.
 */
export function scoreProspectAgainstIcp(prospect, icp) {
    const reasons = [];
    // Match title keywords across BOTH the formal title and the headline: on
    // LinkedIn-sourced prospects the role signal often lives only in the headline
    // (e.g. position "Founder" but headline "… | RevOps | …"), so scoring on the
    // title alone would miss genuine in-persona leads.
    const title = `${prospect.jobTitle ?? ""} ${prospect.headline ?? ""}`.trim().toLowerCase();
    const keywords = (icp.persona.titleKeywords ?? []).map((k) => k.toLowerCase());
    const levels = (icp.persona.jobLevels ?? []).map((l) => l.toLowerCase());
    const depts = (icp.persona.departments ?? []).map((d) => d.toLowerCase());
    let score = 0;
    let weightSum = 0;
    if (keywords.length) {
        weightSum += 0.6;
        const hit = keywords.find((k) => title.includes(k));
        if (hit) {
            score += 0.6;
            reasons.push(`title matches ICP keyword "${hit}"`);
        }
    }
    if (levels.length) {
        weightSum += 0.25;
        const level = (prospect.jobLevel ?? "").toLowerCase();
        if (level && levels.some((l) => level.includes(l))) {
            score += 0.25;
            reasons.push(`seniority "${prospect.jobLevel}" in ICP levels`);
        }
    }
    if (depts.length) {
        weightSum += 0.15;
        const dept = (prospect.jobDepartment ?? "").toLowerCase();
        if (dept && depts.some((d) => dept.includes(d))) {
            score += 0.15;
            reasons.push(`department "${prospect.jobDepartment}" in ICP`);
        }
    }
    const normalized = weightSum > 0 ? score / weightSum : 0;
    if (reasons.length === 0)
        reasons.push("no persona signal matched the ICP");
    return { score: Number(normalized.toFixed(3)), reasons };
}
export function fitThreshold(icp) {
    return icp.scoring?.threshold ?? DEFAULT_FIT_THRESHOLD;
}
export const INTERVIEW_SPEC = [
    {
        id: "industries",
        header: "Target market",
        question: "What company profile are you targeting? (Drives firmographic discovery filters.)",
        multiSelect: true,
        options: [
            { label: "B2B SaaS / software", value: ["software", "saas"], description: "Software & internet — classic messy-CRM, RevOps-equipped buyer." },
            { label: "Broader tech-enabled B2B", value: ["software", "information technology & services", "financial services"], description: "Any B2B running a real sales motion on a CRM." },
            { label: "Any B2B with a CRM", value: [], description: "Vertical-agnostic — qualify on persona, not industry." },
        ],
    },
    {
        id: "employeeBands",
        header: "Company size",
        question: "Company size (employee bands) that fit?",
        multiSelect: true,
        options: [
            { label: "Seed–Series A (1–50)", value: ["1-10", "11-50"], description: "Early; often no dedicated RevOps yet." },
            { label: "Series B–C (51–500)", value: ["51-200", "201-500"], description: "Sweet spot: messy CRM, RevOps exists, budget exists." },
            { label: "Growth (501–2000)", value: ["501-1000", "1001-5000"], description: "Established RevOps, many CRM writers." },
            { label: "Enterprise (2000+)", value: ["1001-5000", "5001-10000", "10001+"], description: "Up-market; longer cycles." },
        ],
    },
    {
        id: "titleKeywords",
        header: "Buyer persona",
        question: "Which buyer persona(s) should discovery target and scoring reward?",
        multiSelect: true,
        options: [
            { label: "RevOps leadership", value: ["revenue operations", "revops", "head of revenue operations"], description: "VP/Head/Dir Revenue Operations." },
            { label: "Sales/Marketing Ops", value: ["sales operations", "gtm operations", "marketing operations", "revenue ops"], description: "Hands-on the CRM daily." },
            { label: "Exec buyers", value: ["chief revenue officer", "cro", "chief operating officer", "vp of sales"], description: "Economic sign-off." },
            { label: "CRM/SF admins", value: ["salesforce admin", "hubspot admin", "crm manager", "revops analyst"], description: "Feel the pain, champion the fix." },
        ],
    },
    {
        id: "geos",
        header: "Geography",
        question: "Geography?",
        multiSelect: true,
        options: [
            { label: "United States", value: ["us"], description: "US-only (best data coverage)." },
            { label: "US + Canada", value: ["us", "ca"], description: "North America." },
            { label: "US + UK/EU", value: ["us", "gb"], description: "English-speaking + Western Europe (mind GDPR)." },
            { label: "Global", value: [], description: "No geo filter." },
        ],
    },
];
/** Assemble an Icp from flattened interview answers. */
export function icpFromAnswers(name, answers) {
    const levelsFromTitles = inferLevels(answers.titleKeywords);
    return {
        name,
        firmographics: {
            industries: dedupe(answers.industries),
            naics: answers.industries.some((i) => /software|saas/i.test(i)) ? ["5112"] : undefined,
            employeeBands: dedupe(answers.employeeBands),
            geos: dedupe(answers.geos),
        },
        persona: {
            jobLevels: answers.jobLevels?.length ? dedupe(answers.jobLevels) : levelsFromTitles,
            departments: answers.departments?.length ? dedupe(answers.departments) : ["sales", "marketing", "operations"],
            titleKeywords: dedupe(answers.titleKeywords),
        },
        scoring: { threshold: DEFAULT_FIT_THRESHOLD },
    };
}
function inferLevels(titles) {
    const levels = new Set();
    for (const t of titles.map((x) => x.toLowerCase())) {
        if (/chief|^c[a-z]o$|cro|coo/.test(t))
            levels.add("cxo");
        if (/vp|vice president|head of/.test(t))
            levels.add("vp");
        if (/director/.test(t))
            levels.add("director");
        if (/manager|admin|analyst|operations/.test(t))
            levels.add("manager");
    }
    return levels.size ? [...levels] : ["cxo", "vp", "director", "manager"];
}
function dedupe(values) {
    return [...new Set((values ?? []).filter(Boolean))];
}

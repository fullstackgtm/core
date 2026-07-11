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
 * Explorium /v1/businesses filters from the ICP — the COMPANY (account) side, for
 * sizing the account universe (TAM). Firmographics only, no persona: the count is
 * of matching companies. Field names differ from /v1/prospects (verified live):
 * `country_code` (not company_country_code), `company_size` (same employee bands),
 * `naics_category`. `/v1/businesses` total_results is a real count, capped at
 * 60,000 (see EXPLORIUM_BUSINESS_COUNT_CAP in the connector).
 */
export function icpToExploriumBusinessFilters(icp) {
    const f = {};
    if (icp.firmographics.geos?.length)
        f.country_code = { values: icp.firmographics.geos };
    if (icp.firmographics.employeeBands?.length)
        f.company_size = { values: icp.firmographics.employeeBands };
    if (icp.firmographics.naics?.length)
        f.naics_category = { values: icp.firmographics.naics };
    return f;
}
/**
 * Collapse provider-agnostic employee bands ("51-200","10001+") into a single
 * {min,max} envelope for APIs that take integer bounds (TheirStack). An open
 * top band ("10001+") leaves max undefined.
 */
export function employeeBandsToRange(bands) {
    if (!bands?.length)
        return {};
    let min;
    let max;
    let openTop = false;
    for (const band of bands) {
        const plus = /^(\d+)\+$/.exec(band.trim());
        if (plus) {
            const lo = Number(plus[1]);
            if (min === undefined || lo < min)
                min = lo;
            openTop = true;
            continue;
        }
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(band.trim());
        if (range) {
            const lo = Number(range[1]);
            const hi = Number(range[2]);
            if (min === undefined || lo < min)
                min = lo;
            if (max === undefined || hi > max)
                max = hi;
        }
    }
    return { min, max: openTop ? undefined : max };
}
/**
 * TheirStack company-search filter from the ICP: the technographic targeting that
 * Explorium can't do. `company_technology_slug_or` is the CRM/MAP buying signal
 * (firmographics.technologies); employee bands become min/max bounds; geos become
 * ISO2 codes (uppercased).
 */
export function icpToTheirStackFilters(icp) {
    const f = {};
    if (icp.firmographics.technologies?.length) {
        f.company_technology_slug_or = icp.firmographics.technologies.map((t) => t.trim().toLowerCase());
    }
    if (icp.firmographics.geos?.length) {
        f.company_country_code_or = icp.firmographics.geos.map((g) => g.trim().toUpperCase());
    }
    const range = employeeBandsToRange(icp.firmographics.employeeBands);
    if (range.min !== undefined)
        f.min_employee_count = range.min;
    if (range.max !== undefined)
        f.max_employee_count = range.max;
    return f;
}
// NOTE: a CRUSTDATA_SENIORITY vocab table lived here until 2026-07-02 — the
// `current_seniority_levels` filter is broken upstream (see the live findings
// on icpToCrustdataFilters below), so job levels are no longer sent to the
// provider at all. Resurrect the table from git history if pipe0 fixes it.
/**
 * ICP industry keyword → LinkedIn industry names Crustdata filters on.
 *
 * LinkedIn renamed its industry taxonomy (v1 → v2, ~2022), and data vendors
 * normalize to one generation or the other. Sending ONLY the v2 names risks a
 * zero-match when Crustdata stores v1 (and vice-versa) — observed live: a RevOps
 * ICP whose only firmographic constraint was the v2 names returned 0 even though
 * the title-only search returned plenty. So each cluster sends BOTH generations
 * (OR-matched within the field): v2 ("Software Development", "IT Services and IT
 * Consulting", "Technology, Information and Internet") AND v1 ("Computer
 * Software", "Information Technology & Services", "Internet").
 */
const CRUSTDATA_INDUSTRY = {
    software: [
        "Software Development",
        "Computer Software",
        "IT Services and IT Consulting",
        "Information Technology & Services",
        "Information Technology and Services",
        "Technology, Information and Internet",
        "Internet",
    ],
    saas: ["Software Development", "Computer Software", "IT Services and IT Consulting", "Information Technology & Services"],
    "information technology & services": ["Information Technology & Services", "IT Services and IT Consulting"],
    "information technology and services": ["Information Technology & Services", "IT Services and IT Consulting"],
    internet: ["Internet", "Technology, Information and Internet"],
    fintech: ["Financial Services"],
    "financial services": ["Financial Services"],
};
// Common NAICS groups translated into Crustdata's LinkedIn industry vocabulary.
// This keeps an ICP authored with provider-neutral NAICS codes from silently
// dropping its industry constraint on the Pipe0 path.
const NAICS_CRUSTDATA_INDUSTRY = {
    "5112": ["Software Development", "Computer Software"],
    "5182": ["IT Services and IT Consulting", "Information Technology & Services"],
    "5415": ["IT Services and IT Consulting", "Information Technology & Services"],
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
export function icpToCrustdataFilters(icp) {
    const f = {};
    if (icp.persona.titleKeywords?.length)
        f.current_job_titles = icp.persona.titleKeywords.map(titleCase);
    if (icp.firmographics.geos?.length) {
        f.locations = icp.firmographics.geos.map((g) => COUNTRY_NAMES[g.toLowerCase()] ?? g);
    }
    if (icp.firmographics.industries?.length || icp.firmographics.naics?.length) {
        const inds = [
            ...new Set([
                ...(icp.firmographics.industries ?? []).flatMap((i) => CRUSTDATA_INDUSTRY[i.toLowerCase()] ?? [titleCase(i)]),
                ...(icp.firmographics.naics ?? []).flatMap((code) => NAICS_CRUSTDATA_INDUSTRY[code] ?? []),
            ]),
        ];
        if (inds.length)
            f.current_employers_linkedin_industries = inds;
    }
    return f;
}
const CLAY_INDUSTRY = {
    software: ["Software Development"],
    saas: ["Software Development"],
    internet: ["Technology, Information and Internet"],
    fintech: ["Financial Services"],
    "financial services": ["Financial Services"],
    "information technology & services": ["IT Services and IT Consulting"],
    "information technology and services": ["IT Services and IT Consulting"],
};
const CLAY_EMPLOYEE_BAND = {
    "1-10": "2-10",
    "11-50": "11-50",
    "51-200": "51-200",
    "201-500": "201-500",
    "501-1000": "501-1,000",
    "1001-5000": "1,001-5,000",
    "5001-10000": "5,001-10,000",
    "10001+": "10,001+",
};
const CLAY_SENIORITY = {
    cxo: "c-suite",
    "c-suite": "c-suite",
    vp: "vp",
    director: "director",
    head: "head",
    manager: "manager",
    owner: "owner",
    founder: "founder",
    senior: "senior",
};
const CLAY_REGION_COUNTRIES = {
    "north america": ["United States", "Canada"],
    europe: ["United Kingdom", "Germany", "France", "Netherlands", "Spain", "Italy", "Ireland", "Sweden", "Switzerland"],
    "asia pacific": ["Australia", "New Zealand", "Singapore", "Japan", "India"],
    apac: ["Australia", "New Zealand", "Singapore", "Japan", "India"],
};
/** Clay people-search filters using only fields confirmed in the live catalog. */
export function icpToClayPeopleFilters(icp) {
    const filters = {};
    if (icp.persona.titleKeywords?.length)
        filters.job_title_keywords = icp.persona.titleKeywords;
    const seniorities = [...new Set((icp.persona.jobLevels ?? []).map((level) => CLAY_SENIORITY[level.toLowerCase()]).filter(Boolean))];
    if (seniorities.length)
        filters.job_title_seniority_levels_v2 = seniorities;
    const sizes = [...new Set((icp.firmographics.employeeBands ?? []).map((band) => CLAY_EMPLOYEE_BAND[band.replace(/,/g, "")]).filter(Boolean))];
    if (sizes.length)
        filters.company_sizes = sizes;
    if (icp.firmographics.geos?.length) {
        const countries = [...new Set(icp.firmographics.geos.flatMap((geo) => {
                const normalized = geo.toLowerCase().trim();
                if (normalized === "global" || normalized === "worldwide")
                    return [];
                return CLAY_REGION_COUNTRIES[normalized] ?? [COUNTRY_NAMES[normalized] ?? geo];
            }))];
        if (countries.length)
            filters.location_countries_include = countries;
    }
    // Clay accepts a controlled industry catalog. Never invent a title-cased
    // enum for model-authored labels: unsupported values make the entire search
    // fail with HTTP 400. Keep those labels in the editable ICP, but send only
    // mappings we have confirmed against Clay's live catalog.
    const industries = [...new Set((icp.firmographics.industries ?? []).flatMap((industry) => CLAY_INDUSTRY[industry.toLowerCase()] ?? []))];
    if (industries.length)
        filters.company_industries_include = industries;
    return filters;
}
const ROLE_STOPWORDS = new Set(["chief", "head", "director", "manager", "senior", "vice", "president", "vp", "cmo", "officer", "lead", "of", "and", "the"]);
function roleKeywords(icp) {
    return [...new Set([
            ...(icp.persona.departments ?? []),
            ...(icp.persona.titleKeywords ?? []).flatMap((title) => title.split(/[^a-z0-9]+/i)),
        ].map((word) => word.trim().toLowerCase()).filter((word) => word.length >= 4 && !ROLE_STOPWORDS.has(word)))];
}
/** Progressive Clay searches for an ICP. Each fallback removes only
 * provider-side AND constraints; the canonical ICP still scores every person
 * locally, so broader discovery does not become broader qualification. */
export function clayPeopleFilterRoutes(icp) {
    const exact = icpToClayPeopleFilters(icp);
    const without = (...keys) => Object.fromEntries(Object.entries(exact).filter(([key]) => !keys.includes(key)));
    const candidates = [
        { id: "exact", filters: exact },
        { id: "account-first", filters: without("job_title_seniority_levels_v2") },
        { id: "persona-first", filters: without("company_industries_include", "company_sizes") },
        { id: "title-first", filters: without("company_industries_include", "company_sizes", "job_title_seniority_levels_v2", "location_countries_include") },
        { id: "function-first", filters: { job_title_keywords: roleKeywords(icp) } },
    ];
    const seen = new Set();
    return candidates.filter((route) => {
        const fingerprint = JSON.stringify(route.filters);
        if (seen.has(fingerprint))
            return false;
        seen.add(fingerprint);
        return true;
    });
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
        const hit = keywords.find((k) => title.includes(k)) ?? roleKeywords(icp).find((keyword) => title.includes(keyword));
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

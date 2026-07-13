import { DEFAULT_SIGNALS_CONFIG, normalizeAccountDomain, signalId, signalWeight, } from "./signals.js";
export const DEFAULT_DISCOVERY_ATS_DOMAINS = [
    "job-boards.greenhouse.io",
    "boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "jobs.smartrecruiters.com",
    "apply.workable.com",
];
const NON_COMPANY_DOMAINS = new Set([
    ...DEFAULT_DISCOVERY_ATS_DOMAINS,
    "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
    "crunchbase.com", "wikipedia.org", "glassdoor.com", "indeed.com",
]);
const STOP_WORDS = new Set(["about", "after", "before", "company", "could", "from", "hiring", "into", "their", "there", "these", "they", "this", "with", "your"]);
function strings(value, max = 12) {
    return [...new Set((Array.isArray(value) ? value : []).filter((v) => typeof v === "string")
            .map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, max);
}
function slug(value, fallback) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}
/** Explicit hypotheses win; intent topics remain a backwards-compatible fallback. */
export function triggerHypothesesForIcp(icp) {
    const explicit = icp.signals?.triggerHypotheses ?? [];
    const valid = explicit.map((item, index) => ({
        id: slug(item.id || item.label, `trigger-${index + 1}`),
        label: item.label?.trim(),
        positiveEvidence: strings(item.positiveEvidence),
        activeProjects: strings(item.activeProjects),
        buyerFunctions: strings(item.buyerFunctions),
        negativeEvidence: strings(item.negativeEvidence),
        preferredSources: item.preferredSources,
    })).filter((item) => item.label && (item.positiveEvidence.length || item.activeProjects.length));
    if (valid.length)
        return valid;
    const topics = strings(icp.signals?.intentTopics);
    if (topics.length) {
        return [{ id: "intent-topics", label: topics.join(" or "), positiveEvidence: topics, preferredSources: ["job"] }];
    }
    throw new Error("signals discover: the ICP has no behavioral trigger hypotheses. Add signals.triggerHypotheses (or intentTopics), or regenerate it with `fullstackgtm icp derive --domain <domain>`.");
}
function evidenceTerms(hypothesis) {
    return strings([...(hypothesis.positiveEvidence ?? []), ...(hypothesis.activeProjects ?? []), ...(hypothesis.buyerFunctions ?? [])], 20);
}
export function exaQueryForHypothesis(hypothesis) {
    const terms = evidenceTerms(hypothesis).slice(0, 8).map((v) => `"${v.replace(/"/g, "")}"`);
    return `recent company job posting showing ${hypothesis.label}${terms.length ? ` (${terms.join(" OR ")})` : ""}`;
}
function words(value) {
    return value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length >= 4 && !STOP_WORDS.has(word)) ?? [];
}
function evidenceMatches(text, hypothesis) {
    const hay = text.toLowerCase();
    if ((hypothesis.negativeEvidence ?? []).some((term) => term && hay.includes(term.toLowerCase())))
        return false;
    const terms = evidenceTerms(hypothesis);
    if (terms.some((term) => term && hay.includes(term.toLowerCase())))
        return true;
    const significant = [...new Set(terms.flatMap(words))];
    return significant.filter((term) => hay.includes(term)).length >= 2;
}
function cleanTitle(value) {
    return value.replace(/\s+/g, " ").replace(/\s*[|–—-]\s*(Greenhouse|Lever|Ashby|SmartRecruiters|Workable).*$/i, "").trim();
}
export function parseJobIdentity(rawTitle, sourceUrl) {
    const title = cleanTitle(rawTitle);
    const application = /^Job Application for (.+?) at (.+)$/i.exec(title);
    if (application)
        return { jobTitle: application[1].trim(), companyName: application[2].trim() };
    const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(title);
    if (at)
        return { jobTitle: at[1].trim(), companyName: at[2].trim() };
    const dash = /^(.+?)\s+[–—-]\s+(.+)$/.exec(title);
    if (dash)
        return { companyName: dash[1].trim(), jobTitle: dash[2].trim() };
    if (sourceUrl && title) {
        try {
            const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
            const boardSlug = parts.find((part) => !["jobs", "job", "positions", "posting"].includes(part.toLowerCase()) && !/^\d+$/.test(part));
            if (boardSlug)
                return { companyName: decodeURIComponent(boardSlug).replace(/[-_]+/g, " ").trim(), jobTitle: title };
        }
        catch { /* source URL validation happens separately */ }
    }
    return null;
}
function safeHostname(raw) {
    try {
        return normalizeAccountDomain(new URL(raw).hostname);
    }
    catch {
        return "";
    }
}
function isExcludedDomain(domain) {
    return [...NON_COMPANY_DOMAINS].some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`));
}
function companyMatches(companyName, resultTitle, url) {
    const companyWords = words(companyName);
    const candidate = `${resultTitle} ${safeHostname(url).split(".")[0]}`.toLowerCase();
    return companyWords.length > 0 && companyWords.some((word) => candidate.includes(word));
}
function finiteCost(response) {
    const total = response.costDollars?.total;
    return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : 0;
}
async function exaSearch(args) {
    let response;
    try {
        response = await args.fetch(`${args.apiBaseUrl.replace(/\/$/, "")}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": args.apiKey },
            body: JSON.stringify(args.body),
        });
    }
    catch (error) {
        throw new Error(`signals discover: could not reach Exa (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error("signals discover: Exa rejected the API key. Run `fullstackgtm login exa` and try again.");
        }
        if (response.status === 429)
            throw new Error("signals discover: Exa rate limit reached; retry later or lower --max-searches.");
        throw new Error(`signals discover: Exa search failed (HTTP ${response.status}).`);
    }
    return await response.json();
}
function resultRows(response) {
    return Array.isArray(response.results) ? response.results.filter((row) => Boolean(row && typeof row === "object")) : [];
}
function firstQuote(result, title) {
    const highlights = strings(result.highlights, 4);
    return (highlights.find((value) => value.length >= 20) ?? highlights[0] ?? title).slice(0, 600);
}
export async function discoverSignalsWithExa(options) {
    if (!options.apiKey.trim())
        throw new Error("signals discover: missing Exa API key. Set EXA_API_KEY or run `fullstackgtm login exa`.");
    if (!Number.isInteger(options.maxSearches) || options.maxSearches < 1)
        throw new Error("signals discover: --max-searches must be a positive integer.");
    if (!Number.isInteger(options.maxAccounts) || options.maxAccounts < 1)
        throw new Error("signals discover: --max-accounts must be a positive integer.");
    if (!Number.isInteger(options.maxResults) || options.maxResults < 1)
        throw new Error("signals discover: --max-results must be a positive integer.");
    if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0)
        throw new Error("signals discover: --max-usd must be greater than zero.");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiBaseUrl = options.apiBaseUrl ?? process.env.EXA_API_BASE_URL ?? "https://api.exa.ai";
    const hypotheses = triggerHypothesesForIcp(options.icp).filter((h) => !h.preferredSources?.length || h.preferredSources.includes("job"));
    if (!hypotheses.length)
        throw new Error("signals discover: no trigger hypothesis allows the currently supported `job` source.");
    const now = options.now ?? new Date();
    const config = options.config ?? DEFAULT_SIGNALS_CONFIG;
    const warnings = [];
    let searchesUsed = 0;
    let costUsd = 0;
    let rawResults = 0;
    const found = [];
    const seenUrls = new Set();
    const canSearch = () => searchesUsed < options.maxSearches && costUsd < options.maxUsd;
    for (const hypothesis of hypotheses) {
        if (!canSearch() || rawResults >= options.maxResults)
            break;
        const remaining = options.maxResults - rawResults;
        const response = await exaSearch({ apiKey: options.apiKey, fetch: fetchImpl, apiBaseUrl, body: {
                query: exaQueryForHypothesis(hypothesis),
                includeDomains: DEFAULT_DISCOVERY_ATS_DOMAINS,
                startCrawlDate: options.since.toISOString(),
                numResults: Math.min(25, remaining),
                contents: { highlights: { maxCharacters: 1200 } },
            } });
        searchesUsed += 1;
        costUsd += finiteCost(response);
        const rows = resultRows(response);
        rawResults += rows.length;
        for (const row of rows) {
            const title = typeof row.title === "string" ? row.title.trim() : "";
            const sourceUrl = typeof row.url === "string" ? row.url.trim() : "";
            if (!title || !sourceUrl || seenUrls.has(sourceUrl) || !DEFAULT_DISCOVERY_ATS_DOMAINS.some((domain) => safeHostname(sourceUrl).endsWith(domain)))
                continue;
            const identity = parseJobIdentity(title, sourceUrl);
            if (!identity)
                continue;
            const quote = firstQuote(row, title);
            if (!evidenceMatches(`${title} ${quote}`, hypothesis))
                continue;
            seenUrls.add(sourceUrl);
            found.push({ hypothesisId: hypothesis.id, hypothesisLabel: hypothesis.label, companyName: identity.companyName,
                jobTitle: identity.jobTitle, sourceUrl, quote,
                ...(typeof row.publishedDate === "string" && Number.isFinite(Date.parse(row.publishedDate)) ? { publishedAt: new Date(row.publishedDate).toISOString() } : {}) });
        }
    }
    const companyNames = [...new Set(found.map((item) => item.companyName))].slice(0, options.maxAccounts);
    const domainByCompany = new Map();
    for (const companyName of companyNames) {
        if (!canSearch())
            break;
        const response = await exaSearch({ apiKey: options.apiKey, fetch: fetchImpl, apiBaseUrl, body: {
                query: `${companyName} official company website`, category: "company", numResults: 3,
            } });
        searchesUsed += 1;
        costUsd += finiteCost(response);
        const match = resultRows(response).find((row) => {
            const url = typeof row.url === "string" ? row.url : "";
            const domain = safeHostname(url);
            return domain && !isExcludedDomain(domain) && companyMatches(companyName, typeof row.title === "string" ? row.title : "", url);
        });
        if (match && typeof match.url === "string")
            domainByCompany.set(companyName, safeHostname(match.url));
    }
    for (const item of found)
        item.accountDomain = domainByCompany.get(item.companyName);
    const resolved = found.filter((item) => item.accountDomain).slice(0, options.maxAccounts);
    if (searchesUsed >= options.maxSearches && (hypotheses.length > 1 || domainByCompany.size < companyNames.length)) {
        warnings.push(`Search limit reached (${options.maxSearches}); some evidence or company domains were not resolved.`);
    }
    if (costUsd >= options.maxUsd)
        warnings.push(`Reported Exa cost reached the $${options.maxUsd.toFixed(2)} budget; no further requests were made.`);
    const nowIso = now.toISOString();
    const signals = resolved.map((item) => {
        const base = { accountDomain: item.accountDomain, bucket: "job", trigger: `evidence: ${item.hypothesisLabel} — ${item.jobTitle}` };
        return { ...base, id: signalId(base), quote: item.quote, sourceUrl: item.sourceUrl, firstSeen: nowIso,
            weight: signalWeight({ bucketWeight: config.buckets.job.weight, firstSeen: nowIso, now,
                windowDays: config.dedupWindowDays, repostedRoleBoost: config.repostedRoleBoost }),
            source: "exa", judgedBy: null, roleKey: item.sourceUrl, hypothesisId: item.hypothesisId,
            companyName: item.companyName, ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}) };
    });
    const roundedCost = Math.round(costUsd * 1_000_000) / 1_000_000;
    return { summary: { provider: "exa", readOnly: true, searchesUsed, searchLimit: options.maxSearches,
            costUsd: roundedCost, costLimitUsd: options.maxUsd, rawResults, matchedEvidence: found.length,
            resolvedAccounts: new Set(signals.map((s) => s.accountDomain)).size,
            unresolvedAccounts: new Set(found.filter((item) => !item.accountDomain).map((item) => item.companyName)).size, warnings },
        candidates: found, signals };
}

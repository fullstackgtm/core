import { DEFAULT_MODELS, forcedToolCall } from "./llm.js";
import { publicHttpGet } from "./publicHttp.js";
import { buildWebsiteIcpPrompt, normalizeWebsiteIcpModelResult, WEBSITE_ICP_DERIVE_SCHEMA, websiteIcpTraceSummaries, } from "./portable/icpDeriveContract.js";
export const DEFAULT_ICP_DERIVATION_MODEL = "z-ai/glm-5.2";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api";
export function normalizeCompanyWebsite(raw) {
    const candidate = raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`;
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        throw new Error(`icp derive: "${raw}" is not a valid company website.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("icp derive supports only public HTTP websites.");
    const domain = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!domain.includes("."))
        throw new Error(`icp derive: "${raw}" is not a public company domain.`);
    return { domain, url: `https://${domain}/` };
}
export function websiteText(html) {
    return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
async function fetchPublicText(url) {
    try {
        const response = await publicHttpGet(url, { timeoutMs: 12_000, maxRedirects: 4, maxBytes: 600_000,
            headers: { "User-Agent": "fullstackgtm-icp-derive/1 (+https://github.com/fullstackgtm/core)" } });
        if (response.status < 200 || response.status >= 300)
            return null;
        return { text: new TextDecoder().decode(response.body), finalUrl: response.finalUrl };
    }
    catch {
        return null;
    }
}
export async function deriveWebsiteIcp(args) {
    const target = normalizeCompanyWebsite(args.domain);
    const fetchPage = args.fetchPages ?? fetchPublicText;
    args.onProgress?.({ stage: "fetch", message: `Resolving and fetching ${target.url}` });
    const homepage = await fetchPage(target.url);
    if (!homepage)
        throw new Error(`icp derive: could not read ${target.domain}. Check the domain and try again.`);
    const homepageText = websiteText(homepage.text).slice(0, 28_000);
    if (homepageText.length < 80)
        throw new Error(`icp derive: ${target.domain} exposed too little readable content.`);
    args.onProgress?.({ stage: "fetch", message: `Fetched ${homepage.finalUrl} · extracted ${homepageText.length.toLocaleString("en-US")} readable characters` });
    const llmsUrl = new URL("/llms.txt", homepage.finalUrl).toString();
    args.onProgress?.({ stage: "fetch", message: `Checking ${llmsUrl} for model-readable product context` });
    const llms = await fetchPage(llmsUrl);
    const llmsText = (llms?.text ?? "").slice(0, 28_000);
    args.onProgress?.({ stage: "fetch", message: llmsText ? `Read ${llmsUrl} · ${llmsText.length.toLocaleString("en-US")} characters` : `No public /llms.txt found · using homepage evidence only` });
    const llm = args.llm ?? (args.apiKey ? { provider: "openai", apiKey: args.apiKey, openaiBaseUrl: OPENROUTER_API_BASE } : undefined);
    if (!llm)
        throw new Error("icp derive: no LLM credential was provided.");
    const isOpenRouter = llm.provider === "openai" && llm.openaiBaseUrl?.startsWith(OPENROUTER_API_BASE);
    const model = args.model ?? llm.model ?? (isOpenRouter ? DEFAULT_ICP_DERIVATION_MODEL : DEFAULT_MODELS[llm.provider]);
    args.onProgress?.({ stage: "model", message: `Submitting ${(homepageText.length + llmsText.length).toLocaleString("en-US")} characters to ${model} with the structured ICP schema` });
    args.onProgress?.({ stage: "model", message: `${model} is analyzing offers, target accounts, buyer roles, timing signals, and exact supporting quotes` });
    const prompt = buildWebsiteIcpPrompt({ domain: target.domain, homepageText, llmsText });
    const raw = args.derive
        ? await args.derive(prompt, model)
        : await forcedToolCall(prompt, "derive_website_icp", WEBSITE_ICP_DERIVE_SCHEMA, model, {
            ...llm,
            model,
            ...(isOpenRouter ? {
                onReasoningSummary: (summary) => args.onProgress?.({ stage: "model", message: `${model} reasoning summary: ${summary.slice(0, 240)}` }),
                onReasoningPhase: (phase) => args.onProgress?.({ stage: "model", message: `${model}: ${phase}` }),
            } : {}),
        });
    for (const summary of websiteIcpTraceSummaries(raw)) {
        args.onProgress?.({ stage: "model", message: `${model}: ${summary.slice(0, 220)}` });
    }
    const result = normalizeWebsiteIcpModelResult({ domain: target.domain, homepageText, homepageUrl: homepage.finalUrl,
        llmsText, llmsUrl, raw, model });
    args.onProgress?.({ stage: "verify", message: `Verified ${result.evidence.length} verbatim evidence quotes against fetched source text` });
    return result;
}
export function icpReviewSegments(icp) {
    const list = (value) => value?.join(", ") || "—";
    return [
        ...(icp.motion === "investment" ? [
            { id: "investmentStages", label: "Investment stage", value: list(icp.investment?.stages), kind: "list" },
            { id: "fundingAmounts", label: "Funding bands", value: list(icp.investment?.fundingAmounts), kind: "list" },
            { id: "thesisKeywords", label: "Thesis keywords", value: list(icp.investment?.thesisKeywords), kind: "list" },
        ] : []),
        { id: "industries", label: "Industries", value: list(icp.firmographics.industries), kind: "list" },
        { id: "employeeBands", label: "Company size", value: list(icp.firmographics.employeeBands), kind: "list" },
        { id: "geos", label: "Geography", value: list(icp.firmographics.geos), kind: "list" },
        { id: "technologies", label: "Technologies", value: list(icp.firmographics.technologies), kind: "list" },
        { id: "titleKeywords", label: "Buyer titles", value: list(icp.persona.titleKeywords), kind: "list" },
        { id: "jobLevels", label: "Seniority", value: list(icp.persona.jobLevels), kind: "list" },
        { id: "departments", label: "Departments", value: list(icp.persona.departments), kind: "list" },
        { id: "intentTopics", label: "Why now", value: list(icp.signals?.intentTopics), kind: "list" },
        { id: "triggerHypotheses", label: "Behavioral triggers", value: list(icp.signals?.triggerHypotheses?.map((item) => item.label)), kind: "list" },
        { id: "threshold", label: "Fit threshold", value: String(icp.scoring?.threshold ?? 0.6), kind: "number" },
    ];
}

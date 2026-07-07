import { getCredential } from "./credentials.js";
import { CALL_TYPE_IDS } from "./callTypes.js";
export const DEFAULT_MODELS = {
    anthropic: "claude-haiku-4-5",
    openai: "gpt-4o-mini",
};
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
/**
 * Resolve the effective endpoint, honoring an optional base-URL override.
 * Mirrors the `prospectSources.ts` idiom (`(base ?? default).replace(/\/$/, "")`):
 * trailing-slash-stripped; if the configured base already ends in the known
 * path suffix it is used as-is, otherwise the suffix is appended so callers can
 * pass either a bare origin (`https://glm.example`) or a full endpoint URL.
 * Unset override → the upstream default, so behavior is unchanged.
 */
function resolveLlmUrl(override, defaultUrl, pathSuffix) {
    if (!override)
        return defaultUrl;
    const base = override.replace(/\/$/, "");
    return base.endsWith(pathSuffix) ? base : `${base}${pathSuffix}`;
}
// Bound cost and context: long calls keep the head and tail.
const MAX_TRANSCRIPT_CHARS = 28_000;
export function detectProviderFromKey(apiKey) {
    return apiKey.startsWith("sk-ant-") ? "anthropic" : "openai";
}
/** Env first (ANTHROPIC_API_KEY, then OPENAI_API_KEY), then the credential store. */
export function resolveLlmCredential(env = process.env) {
    if (env.ANTHROPIC_API_KEY)
        return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, source: "env" };
    if (env.OPENAI_API_KEY)
        return { provider: "openai", apiKey: env.OPENAI_API_KEY, source: "env" };
    for (const provider of ["anthropic", "openai"]) {
        const stored = getCredential(provider);
        if (stored?.accessToken)
            return { provider, apiKey: stored.accessToken, source: "stored" };
    }
    return null;
}
const INSIGHT_TYPES = [
    "pain_point",
    "objection",
    "competitor_mention",
    "next_step",
    "feature_request",
    "pricing",
    "decision_criteria",
    "risk",
    "coaching_moment",
];
const EXTRACT_SCHEMA = {
    type: "object",
    required: ["insights"],
    properties: {
        insights: {
            type: "array",
            items: {
                type: "object",
                required: ["type", "text", "evidence", "importance", "confidence"],
                properties: {
                    type: { type: "string", enum: INSIGHT_TYPES },
                    text: { type: "string", description: "The insight, concise and specific (one sentence)." },
                    evidence: { type: "string", description: "VERBATIM quote from the transcript that grounds this insight. Never paraphrase." },
                    speaker: { type: "string", description: "Who said the evidence, exactly as named in the transcript." },
                    importance: { type: "integer", minimum: 1, maximum: 5 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    owner: { type: "string", description: "next_step only: who committed to the action." },
                    deadline: { type: "string", description: "next_step only: when, as stated (e.g. 'Thursday 2 PM')." },
                    commitment: { type: "string", enum: ["firm", "tentative", "exploratory"], description: "next_step only." },
                },
            },
        },
    },
};
const EXTRACT_INSTRUCTIONS = `Extract GTM insights from this sales call transcript.
Rules:
- evidence MUST be a verbatim quote from the transcript. If you cannot quote it, do not emit the insight.
- text is your concise restatement; one sentence, specific (names, numbers, dates).
- next_step insights are concrete commitments: include owner, deadline (as stated), and commitment level.
- importance: 5 = affects the deal outcome directly, 1 = color.
- Emit nothing for small talk. Quality over quantity.`;
export async function extractInsightsLlm(transcript, options) {
    const model = options.model ?? DEFAULT_MODELS[options.provider];
    const text = truncateTranscript(transcript);
    const prompt = `${EXTRACT_INSTRUCTIONS}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
    const result = (await forcedToolCall(prompt, "extract_call_insights", EXTRACT_SCHEMA, model, options));
    const normalizedTranscript = normalizeSpan(text);
    const insights = (result.insights ?? [])
        .filter((insight) => INSIGHT_TYPES.includes(insight.type))
        // Mechanical verbatim gate (mirrors market classify): the prompt asks for a
        // verbatim quote, but a prompt-injected or hallucinated transcript could
        // fabricate a grounded-looking insight that drives a governed writeback.
        // (1) The evidence quote must be a non-trivial verbatim span of the transcript.
        .filter((insight) => {
        const quote = normalizeSpan(insight.evidence ?? "");
        return quote.length >= 12 && normalizedTranscript.includes(quote);
    })
        // (2) For next_step — the only insight type whose `text` is WRITTEN to the CRM
        // (set_field nextStep / create_task body) — the written action must itself be
        // grounded in the verified quote, not just accompanied by an innocuous one.
        // This closes the decoupling attack: a prompt-injected transcript that emits a
        // malicious `text` while quoting an unrelated real span no longer survives.
        .filter((insight) => insight.type !== "next_step" || actionGroundedInEvidence(insight.text, insight.evidence ?? ""))
        .map((insight) => ({
        ...insight,
        title: insight.type.replace(/_/g, " "),
        importance: clamp(Math.round(insight.importance ?? 3), 1, 5),
        confidence: clamp(insight.confidence ?? 0.7, 0, 1),
    }))
        .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    return { insights, model };
}
/** Whitespace/punctuation-spacing-normalized match (same rule as market spans). */
function normalizeSpan(value) {
    return value
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
/**
 * Is the written next-step action grounded in its (already transcript-verified)
 * evidence quote? A legitimate next step paraphrases the quote, so it reuses the
 * quote's salient terms; a prompt-injected action ("wire $50,000 to account
 * 1234") quoting an unrelated innocuous span does not. Two checks: every
 * number/amount in the action must appear in the evidence (defeats the
 * financial-exfil class cleanly), and a meaningful share of the action's
 * distinctive (≥4-char) words must appear in the evidence.
 */
function actionGroundedInEvidence(text, evidence) {
    const action = normalizeSpan(text);
    const quote = normalizeSpan(evidence);
    if (!action)
        return false;
    const numbers = action.match(/\d[\d,.]*/g) ?? [];
    for (const n of numbers) {
        if (!quote.includes(n))
            return false; // an ungrounded amount/account/id is a red flag
    }
    const distinctive = [...new Set(action.split(/[^a-z0-9$]+/).filter((token) => token.length >= 4))];
    if (distinctive.length === 0)
        return true; // nothing distinctive to ground (a short generic step)
    const grounded = distinctive.filter((token) => quote.includes(token)).length;
    return grounded / distinctive.length >= 0.4;
}
export const DEFAULT_RUBRIC = {
    scale: 5,
    name: "Generic",
    dimensions: [
        { name: "Depth of Discovery", weight: 1.2, rubric: "Did the rep uncover concrete pain, current process, and cost of inaction with specifics — 5 — or stay at surface level — 1?" },
        { name: "Next Steps & Commitment", weight: 1.2, rubric: "Did the call end with a specific, time-bound, mutually agreed next step (5) or vague intentions (1)?" },
        { name: "Stakeholder Engagement", weight: 1.0, rubric: "Were decision makers and influencers identified and engaged (5) or is the rep single-threaded with an unknown buying group (1)?" },
        { name: "Value Articulation", weight: 1.0, rubric: "Was value tied to the prospect's own stated problems and numbers (5) or generic feature talk (1)?" },
        { name: "Objection Handling", weight: 1.0, rubric: "Were concerns surfaced, acknowledged, and resolved with evidence (5), or dismissed/avoided (1)?" },
    ],
};
const SCORE_SCHEMA = (scale, dimensions) => ({
    type: "object",
    required: ["dimensions", "highlights", "missed_items"],
    properties: {
        dimensions: {
            type: "array",
            items: {
                type: "object",
                required: ["name", "score", "evidence", "coaching_note"],
                properties: {
                    name: { type: "string", enum: dimensions.map((d) => d.name) },
                    score: { type: "integer", minimum: 1, maximum: scale },
                    evidence: { type: "array", items: { type: "string" }, description: "Verbatim quotes supporting the score." },
                    coaching_note: { type: "string", description: "One actionable sentence, max 25 words." },
                },
            },
        },
        highlights: { type: "array", items: { type: "string" } },
        missed_items: { type: "array", items: { type: "string" } },
    },
});
export async function scoreCallLlm(transcript, rubric, options) {
    const model = options.model ?? DEFAULT_MODELS[options.provider];
    const text = truncateTranscript(transcript);
    const rubricText = rubric.dimensions
        .map((d) => {
        const lines = [`- ${d.name} (weight ${d.weight}): ${d.rubric}`];
        if (d.anchorsHigh?.length)
            lines.push(`    a ${rubric.scale} looks like: ${d.anchorsHigh.join("; ")}`);
        if (d.anchorsLow?.length)
            lines.push(`    a 1 looks like: ${d.anchorsLow.join("; ")}`);
        if (d.evidenceCues?.length)
            lines.push(`    listen for: ${d.evidenceCues.join(", ")}`);
        return lines.join("\n");
    })
        .join("\n");
    const heading = rubric.name ? `${rubric.name} call` : "sales call";
    const prompt = `Score this ${heading} against the rubric. Score every dimension 1-${rubric.scale}, calibrating to the anchored examples where given. Ground every score in verbatim quotes; if the transcript gives no signal for a dimension, score it low and say why in the coaching note.\n\nRubric:\n${rubricText}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
    const result = (await forcedToolCall(prompt, "score_call", SCORE_SCHEMA(rubric.scale, rubric.dimensions), model, options));
    const byName = new Map((result.dimensions ?? []).map((d) => [d.name, d]));
    const dimensions = rubric.dimensions.map((dim) => {
        const scored = byName.get(dim.name);
        return {
            name: dim.name,
            score: clamp(Math.round(scored?.score ?? 1), 1, rubric.scale),
            maxScore: rubric.scale,
            weight: dim.weight,
            evidence: scored?.evidence ?? [],
            coachingNote: scored?.coaching_note ?? "No signal for this dimension in the transcript.",
        };
    });
    const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
    const overallScore = Math.round((dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight) * 100) / 100;
    const band = rubric.bands?.length
        ? [...rubric.bands].sort((a, b) => b.min - a.min).find((b) => overallScore >= b.min)
        : undefined;
    return {
        dimensions,
        overallScore,
        scale: rubric.scale,
        band,
        rubricName: rubric.name,
        callType: rubric.callType,
        highlights: result.highlights ?? [],
        missedItems: result.missed_items ?? [],
        model,
    };
}
const strArray = (value) => Array.isArray(value) && value.length ? value.map((v) => String(v)) : undefined;
export function parseRubric(json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.dimensions) || parsed.dimensions.length === 0) {
        throw new Error("Rubric needs a dimensions array: { scale, dimensions: [{ name, weight, rubric }] }");
    }
    const bands = Array.isArray(parsed.bands)
        ? parsed.bands
            .filter((b) => b && typeof b.min === "number" && b.label)
            .map((b) => ({ label: String(b.label), min: Number(b.min), meaning: b.meaning ? String(b.meaning) : undefined }))
        : undefined;
    return {
        scale: parsed.scale ?? 5,
        name: parsed.name ? String(parsed.name) : undefined,
        callType: parsed.callType,
        bands: bands?.length ? bands : undefined,
        dimensions: parsed.dimensions.map((d) => ({
            name: String(d.name),
            weight: typeof d.weight === "number" ? d.weight : 1,
            rubric: String(d.rubric ?? ""),
            anchorsHigh: strArray(d.anchorsHigh),
            anchorsLow: strArray(d.anchorsLow),
            evidenceCues: strArray(d.evidenceCues),
            coachingPrompts: strArray(d.coachingPrompts),
        })),
    };
}
// ── Call-type classification (LLM tiebreak) ────────────────────────────────
const CLASSIFY_SCHEMA = {
    type: "object",
    required: ["type", "reason"],
    properties: {
        type: { type: "string", enum: CALL_TYPE_IDS },
        reason: { type: "string", description: "One sentence, citing what in the transcript decided it." },
    },
};
/**
 * Model tiebreak for call-type classification — the opt-in counterpart to the
 * deterministic `classifyCall`. Same forced-tool-call seam as every other LLM
 * feature; returns the canonical CallType plus a one-line reason.
 */
export async function classifyCallLlm(transcript, defs, options) {
    const model = options.model ?? DEFAULT_MODELS[options.provider];
    const text = truncateTranscript(transcript);
    const taxonomy = defs.map((d) => `- ${d.id} (${d.name}): ${d.definition}`).join("\n");
    const prompt = `Classify this sales call into exactly one type from the taxonomy. Pick the single best fit; use "other" only if none apply.\n\nTaxonomy:\n${taxonomy}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
    const result = (await forcedToolCall(prompt, "classify_call", CLASSIFY_SCHEMA, model, options));
    return {
        type: result.type ?? "other",
        reason: result.reason ?? "Model did not give a reason.",
        model,
        method: "llm",
    };
}
// ── Provider plumbing (raw fetch, forced tool calls) ───────────────────────
/**
 * Shared constrained-tool-call plumbing: force the model to answer through a
 * single tool whose input_schema is the output contract. Exported for other
 * semi-deterministic features (market classification) — every LLM feature in
 * the package goes through this one seam.
 */
export async function forcedToolCall(prompt, toolName, schema, model, options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    if (options.provider === "anthropic") {
        const anthropicUrl = resolveLlmUrl(options.anthropicBaseUrl, ANTHROPIC_URL, "/v1/messages");
        const response = await llmFetch(fetchImpl, anthropicUrl, {
            method: "POST",
            headers: {
                "x-api-key": options.apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                tools: [{ name: toolName, description: `Return the ${toolName} result.`, input_schema: schema }],
                tool_choice: { type: "tool", name: toolName },
                messages: [{ role: "user", content: prompt }],
            }),
        });
        const block = response.content?.find((item) => item.type === "tool_use");
        if (!block?.input)
            throw new Error("Anthropic returned no tool call — try again or a different --model.");
        return block.input;
    }
    const openaiUrl = resolveLlmUrl(options.openaiBaseUrl, OPENAI_URL, "/v1/chat/completions");
    const response = await llmFetch(fetchImpl, openaiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            tools: [{ type: "function", function: { name: toolName, parameters: schema } }],
            tool_choice: { type: "function", function: { name: toolName } },
        }),
    });
    const call = response
        .choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments)
        throw new Error("OpenAI returned no tool call — try again or a different --model.");
    return JSON.parse(call.function.arguments);
}
async function llmFetch(fetchImpl, url, init) {
    let response;
    try {
        response = await fetchImpl(url, init);
    }
    catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
        throw new Error(`Cannot reach ${new URL(url).hostname}${cause}. Check network access.`);
    }
    if (!response.ok) {
        // Status line only — provider error bodies can reflect request content.
        throw new Error(`LLM API error ${response.status} ${response.statusText} from ${new URL(url).hostname}. Check the API key (\`fullstackgtm login anthropic|openai\`) and model name.`);
    }
    return response.json();
}
function truncateTranscript(transcript) {
    if (transcript.length <= MAX_TRANSCRIPT_CHARS)
        return transcript;
    const half = MAX_TRANSCRIPT_CHARS / 2;
    return `${transcript.slice(0, half)}\n[... middle of transcript truncated ...]\n${transcript.slice(-half)}`;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
/** Cheap key validation against the provider's model-list endpoint. Status line only. */
export async function validateLlmKey(provider, apiKey, fetchImpl = fetch) {
    const url = provider === "anthropic" ? "https://api.anthropic.com/v1/models" : "https://api.openai.com/v1/models";
    const headers = provider === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${apiKey}` };
    let response;
    try {
        response = await fetchImpl(url, { headers });
    }
    catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
        return { ok: false, detail: `Cannot reach ${new URL(url).hostname}${cause}.` };
    }
    return response.ok
        ? { ok: true, detail: `Key accepted by the ${provider} API.` }
        : { ok: false, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
}
// ── Chunked extraction (the TamTone "langextract" method) ───────────────────
//
// The quality property this encodes, validated on real call corpora in
// TamTone: transcripts are never sent whole. They are chopped into small
// (~1,500-char) speaker-turn-respecting chunks and each chunk gets its own
// focused extraction call — small chunks yielded ~95% more grounded signals
// than 4,000-char chunks in TamTone's testing, and whole-transcript passes
// (this module's original extractInsightsLlm, kept for tiny inputs) are the
// worst case: truncation drops the tail and one context window extracts
// shallowly. Per-chunk results pass the SAME verbatim-evidence and
// next-step-grounding gates as the single-shot path (checked against the
// chunk they came from), then a TamTone-style quality score
// (0.25·length + 0.40·specificity + 0.35·confidence, reject < 0.15) filters
// filler before per-call dedupe and ranking.
const CHUNK_MAX_CHARS = 1500;
const CHUNK_CONCURRENCY = 4;
const MAX_CHUNKS_PER_CALL = 80; // cost bound ≈ 120K chars of transcript
const MAX_INSIGHTS_PER_CALL = 40;
/**
 * Chop a "Speaker: text" transcript into ≤maxChars chunks on speaker-turn
 * (line) boundaries; a single oversize turn splits on sentence boundaries.
 * No overlap (per-chunk extraction + downstream dedupe make it unnecessary).
 */
export function chunkTranscript(transcript, maxChars = CHUNK_MAX_CHARS) {
    const lines = transcript.split("\n").filter((line) => line.trim().length > 0);
    const pieces = [];
    for (const line of lines) {
        if (line.length <= maxChars) {
            pieces.push(line);
            continue;
        }
        // Oversize turn: split on sentence boundaries within the budget.
        let rest = line;
        while (rest.length > maxChars) {
            const window = rest.slice(0, maxChars);
            const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
            const at = cut >= maxChars * 0.4 ? cut + 1 : maxChars;
            pieces.push(rest.slice(0, at).trim());
            rest = rest.slice(at).trim();
        }
        if (rest)
            pieces.push(rest);
    }
    const chunks = [];
    let current = "";
    for (const piece of pieces) {
        if (current && current.length + piece.length + 1 > maxChars) {
            chunks.push(current);
            current = piece;
        }
        else {
            current = current ? `${current}\n${piece}` : piece;
        }
    }
    if (current)
        chunks.push(current);
    return chunks;
}
// Few-shot examples are load-bearing (TamTone's extractor refuses to run
// without an example set): they anchor the "verbatim span, not paraphrase"
// contract and calibrate what NOT to extract far better than instructions.
const CHUNK_FEW_SHOT = `Examples:

Excerpt: "Prospect: honestly the big blocker is that our reps spend every Friday cleaning the pipeline by hand. Rep: how long does that take? Prospect: most of the day, easily five or six hours."
→ [{"type":"pain_point","text":"Reps lose ~5-6 hours every Friday manually cleaning the pipeline.","evidence":"our reps spend every Friday cleaning the pipeline by hand","speaker":"Prospect","importance":4,"confidence":0.9}]

Excerpt: "Prospect: we're also looking at Clari for this. Their forecasting is strong but the rollout quote scared us. Rep: what was the number? Prospect: about eighty thousand a year."
→ [{"type":"competitor_mention","text":"Evaluating Clari; strong forecasting but ~$80K/yr rollout quote is a concern.","evidence":"we're also looking at Clari for this","speaker":"Prospect","importance":4,"confidence":0.9},{"type":"pricing","text":"Clari quoted about $80K per year.","evidence":"about eighty thousand a year","speaker":"Prospect","importance":3,"confidence":0.85}]

Excerpt: "Rep: I'll send the security questionnaire answers by Thursday. Prospect: perfect, and I'll get you time with our CFO next week."
→ [{"type":"next_step","text":"Rep to send security questionnaire answers by Thursday.","evidence":"I'll send the security questionnaire answers by Thursday","speaker":"Rep","importance":4,"confidence":0.95,"owner":"Rep","deadline":"Thursday","commitment":"firm"},{"type":"next_step","text":"Prospect to schedule time with their CFO next week.","evidence":"I'll get you time with our CFO next week","speaker":"Prospect","importance":4,"confidence":0.9,"owner":"Prospect","deadline":"next week","commitment":"firm"}]

Excerpt: "Rep: how was the long weekend? Prospect: great, we took the kids camping. Rep: nice! okay, let me share my screen."
→ []

Do NOT extract: greetings, scheduling chatter, filler ("yeah", "makes sense"), screen-share logistics, or anything you cannot quote verbatim from THIS excerpt.`;
function chunkInstructions(index, total, title) {
    return `${EXTRACT_INSTRUCTIONS}

You are seeing excerpt ${index + 1} of ${total} from a longer call${title ? ` ("${title}")` : ""}.
Extract ONLY what this excerpt itself grounds — the other excerpts are handled separately.
evidence MUST be a verbatim span of THIS excerpt.

${CHUNK_FEW_SHOT}`;
}
// TamTone quality gate (analysis/quality_scorer.py):
// 0.25·length + 0.40·specificity + 0.35·confidence, hard caps for
// stopword-only/too-short, reject below 0.15. Specificity rewards the
// concrete: numbers, money, dates/durations, named things.
const STOPWORDS = new Set("a an and are as at be but by for from had has have i if in into is it its me my not of on or our so that the their them they this to was we were what when which who will with you your yeah okay right sure like just really kind sort".split(" "));
export function scoreInsightQuality(insight) {
    const text = `${insight.text} ${insight.evidence}`.trim();
    const words = text.toLowerCase().split(/[^a-z0-9$%']+/).filter(Boolean);
    if (text.length < 5)
        return 0.1;
    const nonStop = words.filter((word) => !STOPWORDS.has(word));
    if (nonStop.length === 0)
        return 0.1;
    const lengthScore = Math.min(1, words.length / 20);
    let specificity = 0;
    if (/\d/.test(text))
        specificity += 0.3; // numbers/amounts/dates
    if (/[$€£]|\b(dollars?|thousand|million|percent|%)\b/i.test(text))
        specificity += 0.2;
    if (/\b(q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|week|month|quarter|year|monday|tuesday|wednesday|thursday|friday)\b/i.test(text))
        specificity += 0.2;
    if (/\b[A-Z][a-z]{2,}/.test(insight.text.slice(1)))
        specificity += 0.15; // named things
    specificity += Math.min(0.3, nonStop.length / 40);
    specificity = Math.min(1, specificity);
    return 0.25 * lengthScore + 0.4 * specificity + 0.35 * Math.min(1, Math.max(0, insight.confidence));
}
const QUALITY_REJECT_BELOW = 0.15;
/**
 * The chunked pipeline: chunk → per-chunk forced-tool extraction (bounded
 * concurrency) → per-chunk verbatim + grounding gates → quality gate →
 * per-call dedupe → rank. A failed chunk is skipped (best-effort); only
 * all-chunks-failed throws.
 */
export async function extractInsightsChunked(transcript, options) {
    const model = options.model ?? DEFAULT_MODELS[options.provider];
    const allChunks = chunkTranscript(transcript);
    const chunks = allChunks.slice(0, options.maxChunks ?? MAX_CHUNKS_PER_CALL);
    if (chunks.length <= 1) {
        // Tiny transcript: the single-shot path is identical work with one call.
        const single = await extractInsightsLlm(transcript, options);
        return { ...single, chunks: allChunks.length, chunksUsed: chunks.length, chunksFailed: 0 };
    }
    const concurrency = Math.max(1, options.concurrency ?? CHUNK_CONCURRENCY);
    const perChunk = new Array(chunks.length);
    let failed = 0;
    let cursor = 0;
    async function worker() {
        while (cursor < chunks.length) {
            const index = cursor;
            cursor += 1;
            const chunk = chunks[index];
            try {
                const result = (await forcedToolCall(`${chunkInstructions(index, chunks.length, options.title)}\n\nExcerpt:\n${chunk}`, "extract_call_insights", EXTRACT_SCHEMA, model, options));
                const normalizedChunk = normalizeSpan(chunk);
                perChunk[index] = (result.insights ?? [])
                    .filter((insight) => INSIGHT_TYPES.includes(insight.type))
                    // The SAME gates as the single-shot path, applied per chunk: the
                    // evidence must be a verbatim span of the chunk it came from, and a
                    // next_step's written action must be grounded in that evidence.
                    .filter((insight) => {
                    const quote = normalizeSpan(insight.evidence ?? "");
                    return quote.length >= 12 && normalizedChunk.includes(quote);
                })
                    .filter((insight) => insight.type !== "next_step" ||
                    actionGroundedInEvidence(insight.text, insight.evidence ?? ""))
                    .map((insight) => ({
                    ...insight,
                    title: insight.type.replace(/_/g, " "),
                    importance: clamp(Math.round(insight.importance ?? 3), 1, 5),
                    confidence: clamp(insight.confidence ?? 0.7, 0, 1),
                }))
                    .filter((insight) => scoreInsightQuality(insight) >= QUALITY_REJECT_BELOW);
            }
            catch {
                failed += 1;
                perChunk[index] = [];
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    if (failed === chunks.length) {
        throw new Error(`LLM extraction failed for all ${chunks.length} chunks.`);
    }
    // Per-call dedupe: exact on (type, normalized evidence), then near-dup on
    // (type, normalized text) containment — chunks don't overlap, so dupes are
    // the model restating the same fact from adjacent context.
    const seen = new Map();
    const richness = (insight) => insight.confidence +
        (insight.owner ? 0.05 : 0) +
        (insight.deadline ? 0.05 : 0) +
        (insight.speaker ? 0.02 : 0);
    for (const insights of perChunk) {
        for (const insight of insights ?? []) {
            const key = `${insight.type}:${normalizeSpan(insight.evidence ?? "")}`;
            const kept = seen.get(key);
            // Same grounded fact stated twice: keep the richer statement (owner/
            // deadline/speaker attached, higher confidence), not the first seen.
            if (!kept || richness(insight) > richness(kept))
                seen.set(key, insight);
        }
    }
    const merged = [];
    for (const insight of seen.values()) {
        const text = normalizeSpan(insight.text);
        const dupe = merged.find((kept) => kept.type === insight.type &&
            (normalizeSpan(kept.text).includes(text) || text.includes(normalizeSpan(kept.text))));
        if (!dupe)
            merged.push(insight);
        else if (insight.importance > dupe.importance)
            merged[merged.indexOf(dupe)] = insight;
    }
    merged.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    return {
        insights: merged.slice(0, MAX_INSIGHTS_PER_CALL),
        model,
        chunks: allChunks.length,
        chunksUsed: chunks.length,
        chunksFailed: failed,
    };
}

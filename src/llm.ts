import { getCredential } from "./credentials.ts";
import type { CallInsightType, ExtractedCallInsight } from "./calls.ts";
import { CALL_TYPE_IDS, type CallType } from "./callTypes.ts";

/**
 * LLM-powered call extraction and scoring. Bring-your-own-key, two providers
 * (Anthropic, OpenAI), raw fetch — no SDK dependency, mirroring how the CRM
 * connectors talk to their APIs. Constrained tool calls keep the output in
 * the same canonical insight shape as the deterministic engine, with
 * mandatory verbatim-quote evidence; every insight is provenance-marked with
 * the extractor that produced it.
 */

export type LlmProvider = "anthropic" | "openai";

export type LlmCredential = { provider: LlmProvider; apiKey: string; source: "env" | "stored" };

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// Bound cost and context: long calls keep the head and tail.
const MAX_TRANSCRIPT_CHARS = 28_000;

export function detectProviderFromKey(apiKey: string): LlmProvider {
  return apiKey.startsWith("sk-ant-") ? "anthropic" : "openai";
}

/** Env first (ANTHROPIC_API_KEY, then OPENAI_API_KEY), then the credential store. */
export function resolveLlmCredential(
  env: Record<string, string | undefined> = process.env,
): LlmCredential | null {
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, source: "env" };
  if (env.OPENAI_API_KEY) return { provider: "openai", apiKey: env.OPENAI_API_KEY, source: "env" };
  for (const provider of ["anthropic", "openai"] as const) {
    const stored = getCredential(provider);
    if (stored?.accessToken) return { provider, apiKey: stored.accessToken, source: "stored" };
  }
  return null;
}

const INSIGHT_TYPES: CallInsightType[] = [
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
} as const;

const EXTRACT_INSTRUCTIONS = `Extract GTM insights from this sales call transcript.
Rules:
- evidence MUST be a verbatim quote from the transcript. If you cannot quote it, do not emit the insight.
- text is your concise restatement; one sentence, specific (names, numbers, dates).
- next_step insights are concrete commitments: include owner, deadline (as stated), and commitment level.
- importance: 5 = affects the deal outcome directly, 1 = color.
- Emit nothing for small talk. Quality over quantity.`;

export type LlmCallOptions = {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export type LlmExtractedInsight = ExtractedCallInsight & {
  owner?: string;
  deadline?: string;
  commitment?: "firm" | "tentative" | "exploratory";
};

export async function extractInsightsLlm(
  transcript: string,
  options: LlmCallOptions & { title?: string },
): Promise<{ insights: LlmExtractedInsight[]; model: string }> {
  const model = options.model ?? DEFAULT_MODELS[options.provider];
  const text = truncateTranscript(transcript);
  const prompt = `${EXTRACT_INSTRUCTIONS}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
  const result = (await forcedToolCall(prompt, "extract_call_insights", EXTRACT_SCHEMA, model, options)) as {
    insights?: LlmExtractedInsight[];
  };
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
function normalizeSpan(value: string): string {
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
function actionGroundedInEvidence(text: string, evidence: string): boolean {
  const action = normalizeSpan(text);
  const quote = normalizeSpan(evidence);
  if (!action) return false;
  const numbers = action.match(/\d[\d,.]*/g) ?? [];
  for (const n of numbers) {
    if (!quote.includes(n)) return false; // an ungrounded amount/account/id is a red flag
  }
  const distinctive = [...new Set(action.split(/[^a-z0-9$]+/).filter((token) => token.length >= 4))];
  if (distinctive.length === 0) return true; // nothing distinctive to ground (a short generic step)
  const grounded = distinctive.filter((token) => quote.includes(token)).length;
  return grounded / distinctive.length >= 0.4;
}

// ── Rubric scoring ─────────────────────────────────────────────────────────

/** A qualitative band over the weighted overall (e.g. "developing" at >=2). */
export type ScoreBand = { label: string; min: number; meaning?: string };

export type RubricDimension = {
  name: string;
  weight: number;
  rubric: string;
  /** Anchored behavioral examples of a top score — sharpens the model and cuts variance. */
  anchorsHigh?: string[];
  /** Anchored behavioral examples of a bottom score. */
  anchorsLow?: string[];
  /** Verbatim phrases to listen for — tightens evidence grounding. */
  evidenceCues?: string[];
  /** Reflective questions surfaced to the rep alongside the score. */
  coachingPrompts?: string[];
};

export type Rubric = {
  scale: number;
  /** Display name (e.g. the call type this rubric is built for). */
  name?: string;
  /** The call type this rubric scores, when type-specific. */
  callType?: CallType;
  dimensions: RubricDimension[];
  /** Optional qualitative bands over the weighted overall. */
  bands?: ScoreBand[];
};

export const DEFAULT_RUBRIC: Rubric = {
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

export type ScoredDimension = {
  name: string;
  score: number;
  maxScore: number;
  weight: number;
  evidence: string[];
  coachingNote: string;
};

export type CallScorecard = {
  dimensions: ScoredDimension[];
  /** Weighted average, computed deterministically client-side. */
  overallScore: number;
  scale: number;
  /** Qualitative band for the overall, computed client-side from the rubric's bands. */
  band?: ScoreBand;
  /** The rubric used, for provenance in reports. */
  rubricName?: string;
  callType?: CallType;
  highlights: string[];
  missedItems: string[];
  model: string;
};

const SCORE_SCHEMA = (scale: number, dimensions: Rubric["dimensions"]) =>
  ({
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
  }) as const;

export async function scoreCallLlm(
  transcript: string,
  rubric: Rubric,
  options: LlmCallOptions & { title?: string },
): Promise<CallScorecard> {
  const model = options.model ?? DEFAULT_MODELS[options.provider];
  const text = truncateTranscript(transcript);
  const rubricText = rubric.dimensions
    .map((d) => {
      const lines = [`- ${d.name} (weight ${d.weight}): ${d.rubric}`];
      if (d.anchorsHigh?.length) lines.push(`    a ${rubric.scale} looks like: ${d.anchorsHigh.join("; ")}`);
      if (d.anchorsLow?.length) lines.push(`    a 1 looks like: ${d.anchorsLow.join("; ")}`);
      if (d.evidenceCues?.length) lines.push(`    listen for: ${d.evidenceCues.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
  const heading = rubric.name ? `${rubric.name} call` : "sales call";
  const prompt = `Score this ${heading} against the rubric. Score every dimension 1-${rubric.scale}, calibrating to the anchored examples where given. Ground every score in verbatim quotes; if the transcript gives no signal for a dimension, score it low and say why in the coaching note.\n\nRubric:\n${rubricText}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
  const result = (await forcedToolCall(prompt, "score_call", SCORE_SCHEMA(rubric.scale, rubric.dimensions), model, options)) as {
    dimensions?: Array<{ name: string; score: number; evidence?: string[]; coaching_note?: string }>;
    highlights?: string[];
    missed_items?: string[];
  };
  const byName = new Map((result.dimensions ?? []).map((d) => [d.name, d]));
  const dimensions: ScoredDimension[] = rubric.dimensions.map((dim) => {
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
  const overallScore =
    Math.round((dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight) * 100) / 100;
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

const strArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length ? value.map((v) => String(v)) : undefined;

export function parseRubric(json: string): Rubric {
  const parsed = JSON.parse(json) as Partial<Rubric>;
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
} as const;

export type LlmCallClassification = { type: CallType; reason: string; model: string; method: "llm" };

/**
 * Model tiebreak for call-type classification — the opt-in counterpart to the
 * deterministic `classifyCall`. Same forced-tool-call seam as every other LLM
 * feature; returns the canonical CallType plus a one-line reason.
 */
export async function classifyCallLlm(
  transcript: string,
  defs: Array<{ id: string; name: string; definition: string }>,
  options: LlmCallOptions & { title?: string },
): Promise<LlmCallClassification> {
  const model = options.model ?? DEFAULT_MODELS[options.provider];
  const text = truncateTranscript(transcript);
  const taxonomy = defs.map((d) => `- ${d.id} (${d.name}): ${d.definition}`).join("\n");
  const prompt = `Classify this sales call into exactly one type from the taxonomy. Pick the single best fit; use "other" only if none apply.\n\nTaxonomy:\n${taxonomy}\n\n${options.title ? `Call: ${options.title}\n` : ""}Transcript:\n${text}`;
  const result = (await forcedToolCall(prompt, "classify_call", CLASSIFY_SCHEMA, model, options)) as {
    type?: CallType;
    reason?: string;
  };
  return {
    type: (result.type as CallType) ?? "other",
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
export async function forcedToolCall(
  prompt: string,
  toolName: string,
  schema: object,
  model: string,
  options: LlmCallOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.provider === "anthropic") {
    const response = await llmFetch(fetchImpl, ANTHROPIC_URL, {
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
    const block = (response as { content?: Array<{ type: string; input?: unknown }> }).content?.find(
      (item) => item.type === "tool_use",
    );
    if (!block?.input) throw new Error("Anthropic returned no tool call — try again or a different --model.");
    return block.input;
  }
  const response = await llmFetch(fetchImpl, OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: { name: toolName, parameters: schema } }],
      tool_choice: { type: "function", function: { name: toolName } },
    }),
  });
  const call = (response as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> })
    .choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) throw new Error("OpenAI returned no tool call — try again or a different --model.");
  return JSON.parse(call.function.arguments);
}

async function llmFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    throw new Error(`Cannot reach ${new URL(url).hostname}${cause}. Check network access.`);
  }
  if (!response.ok) {
    // Status line only — provider error bodies can reflect request content.
    throw new Error(`LLM API error ${response.status} ${response.statusText} from ${new URL(url).hostname}. Check the API key (\`fullstackgtm login anthropic|openai\`) and model name.`);
  }
  return response.json();
}

function truncateTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  return `${transcript.slice(0, half)}\n[... middle of transcript truncated ...]\n${transcript.slice(-half)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Cheap key validation against the provider's model-list endpoint. Status line only. */
export async function validateLlmKey(
  provider: LlmProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const url = provider === "anthropic" ? "https://api.anthropic.com/v1/models" : "https://api.openai.com/v1/models";
  const headers: Record<string, string> =
    provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return { ok: false, detail: `Cannot reach ${new URL(url).hostname}${cause}.` };
  }
  return response.ok
    ? { ok: true, detail: `Key accepted by the ${provider} API.` }
    : { ok: false, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
}

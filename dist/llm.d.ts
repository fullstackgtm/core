import type { ExtractedCallInsight } from "./calls.ts";
import { type CallType } from "./callTypes.ts";
/**
 * LLM-powered call extraction and scoring. Bring-your-own-key, two providers
 * (Anthropic, OpenAI), raw fetch — no SDK dependency, mirroring how the CRM
 * connectors talk to their APIs. Constrained tool calls keep the output in
 * the same canonical insight shape as the deterministic engine, with
 * mandatory verbatim-quote evidence; every insight is provenance-marked with
 * the extractor that produced it.
 */
export type LlmProvider = "anthropic" | "openai";
export type LlmCredential = {
    provider: LlmProvider;
    apiKey: string;
    source: "env" | "stored";
};
export declare const DEFAULT_MODELS: Record<LlmProvider, string>;
export declare function detectProviderFromKey(apiKey: string): LlmProvider;
/** Env first (ANTHROPIC_API_KEY, then OPENAI_API_KEY), then the credential store. */
export declare function resolveLlmCredential(env?: Record<string, string | undefined>): LlmCredential | null;
export type LlmCallOptions = {
    provider: LlmProvider;
    apiKey: string;
    model?: string;
    fetchImpl?: typeof fetch;
    /**
     * Override the Anthropic Messages endpoint — point the package at an
     * OpenAI/Anthropic-compatible gateway (GLM-5.2, z.ai, a local proxy) without
     * code changes. An origin (`https://...`) gets `/v1/messages` appended; a base
     * already ending in `/messages` is used verbatim. Threaded from
     * `ANTHROPIC_API_BASE_URL` at the LlmCallOptions-construction layer (cli.ts),
     * never read inside `forcedToolCall`. Unset → default api.anthropic.com.
     */
    anthropicBaseUrl?: string;
    /** OpenAI equivalent of `anthropicBaseUrl` (e.g. an Ollama OpenAI-compatible
     * endpoint). Origin → `/v1/chat/completions` appended; a base ending in
     * `/chat/completions` is used verbatim. Threaded from `OPENAI_API_BASE_URL`. */
    openaiBaseUrl?: string;
    /** Optional OpenAI-compatible streaming telemetry. Raw reasoning text is
     * deliberately not exposed; only provider-authored summaries and activity. */
    onReasoningSummary?: (summary: string) => void;
    onReasoningActivity?: (receivedCharacters: number) => void;
    /** Safe, coarse phase inferred transiently from reasoning text. The raw text
     * is never passed to callers, logged, or retained after the request. */
    onReasoningPhase?: (phase: string) => void;
};
export type LlmExtractedInsight = ExtractedCallInsight & {
    owner?: string;
    deadline?: string;
    commitment?: "firm" | "tentative" | "exploratory";
};
export declare function extractInsightsLlm(transcript: string, options: LlmCallOptions & {
    title?: string;
}): Promise<{
    insights: LlmExtractedInsight[];
    model: string;
}>;
/** A qualitative band over the weighted overall (e.g. "developing" at >=2). */
export type ScoreBand = {
    label: string;
    min: number;
    meaning?: string;
};
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
export declare const DEFAULT_RUBRIC: Rubric;
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
export declare function scoreCallLlm(transcript: string, rubric: Rubric, options: LlmCallOptions & {
    title?: string;
}): Promise<CallScorecard>;
export declare function parseRubric(json: string): Rubric;
export type LlmCallClassification = {
    type: CallType;
    reason: string;
    model: string;
    method: "llm";
};
/**
 * Model tiebreak for call-type classification — the opt-in counterpart to the
 * deterministic `classifyCall`. Same forced-tool-call seam as every other LLM
 * feature; returns the canonical CallType plus a one-line reason.
 */
export declare function classifyCallLlm(transcript: string, defs: Array<{
    id: string;
    name: string;
    definition: string;
}>, options: LlmCallOptions & {
    title?: string;
}): Promise<LlmCallClassification>;
/**
 * Shared constrained-tool-call plumbing: force the model to answer through a
 * single tool whose input_schema is the output contract. Exported for other
 * semi-deterministic features (market classification) — every LLM feature in
 * the package goes through this one seam.
 */
export declare function forcedToolCall(prompt: string, toolName: string, schema: object, model: string, options: LlmCallOptions): Promise<unknown>;
/** Cheap key validation against the provider's model-list endpoint. Status line only. */
export declare function validateLlmKey(provider: LlmProvider, apiKey: string, fetchImpl?: typeof fetch): Promise<{
    ok: boolean;
    detail: string;
}>;
/**
 * Chop a "Speaker: text" transcript into ≤maxChars chunks on speaker-turn
 * (line) boundaries; a single oversize turn splits on sentence boundaries.
 * No overlap (per-chunk extraction + downstream dedupe make it unnecessary).
 */
export declare function chunkTranscript(transcript: string, maxChars?: number): string[];
export declare function scoreInsightQuality(insight: {
    text: string;
    evidence: string;
    confidence: number;
}): number;
export type ChunkedExtractResult = {
    insights: LlmExtractedInsight[];
    model: string;
    chunks: number;
    chunksUsed: number;
    chunksFailed: number;
};
/**
 * The chunked pipeline: chunk → per-chunk forced-tool extraction (bounded
 * concurrency) → per-chunk verbatim + grounding gates → quality gate →
 * per-call dedupe → rank. A failed chunk is skipped (best-effort); only
 * all-chunks-failed throws.
 */
export declare function extractInsightsChunked(transcript: string, options: LlmCallOptions & {
    title?: string;
    maxChunks?: number;
    concurrency?: number;
}): Promise<ChunkedExtractResult>;

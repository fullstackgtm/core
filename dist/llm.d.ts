import type { ExtractedCallInsight } from "./calls.ts";
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
export type Rubric = {
    scale: number;
    dimensions: Array<{
        name: string;
        weight: number;
        rubric: string;
    }>;
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
    highlights: string[];
    missedItems: string[];
    model: string;
};
export declare function scoreCallLlm(transcript: string, rubric: Rubric, options: LlmCallOptions & {
    title?: string;
}): Promise<CallScorecard>;
export declare function parseRubric(json: string): Rubric;
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

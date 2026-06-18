import type { Rubric, ScoreBand } from "./llm.ts";
/**
 * Call-type taxonomy, a deterministic signal-based classifier, and one
 * type-specific coaching rubric per call type.
 *
 * The design mirrors the rest of the package: deterministic by default,
 * explainable, and byte-stable. `classifyCall` reads a transcript and returns
 * a ranked classification with a written reason — no LLM, no key, no network —
 * so it runs free in CI and on warehouse bulk loads. The LLM tiebreak
 * (`classifyCallLlm` in llm.ts) is opt-in, for the ambiguous middle.
 *
 * Scoring a renewal against a discovery rubric is simply wrong, so each call
 * type carries its own rubric: the dimensions that matter for *that*
 * conversation, with anchored high/low examples and evidence cues that sharpen
 * the verbatim-quote grounding the scorer already requires.
 */
export type CallType = "prospecting" | "discovery" | "demo" | "technical_validation" | "negotiation" | "closing" | "onboarding" | "check_in" | "renewal_expansion" | "qbr" | "internal" | "other";
export declare const CALL_TYPE_IDS: CallType[];
export type CallTypeDef = {
    id: CallType;
    name: string;
    phase: "pre_sale" | "post_sale" | "neither";
    definition: string;
    /** Phrases that, when present, argue *for* this type (lowercased, substring match). */
    signals: string[];
    /** Phrases that argue *against* this type even if a signal matched. */
    negativeSignals?: string[];
    /** Types this is commonly confused with — surfaced in the classifier reason. */
    confusedWith?: CallType[];
};
/**
 * Our own taxonomy. Signals are authored phrases, not lifted from any third
 * party; they are intentionally conservative (high-precision verbs and nouns
 * that rarely appear off-topic) so the deterministic pass is trustworthy and
 * the ambiguous remainder is handed to the LLM tiebreak rather than guessed.
 */
export declare const CALL_TYPES: CallTypeDef[];
export type CallClassification = {
    type: CallType;
    confidence: "high" | "low" | "none";
    reason: string;
    /** All types that matched at least one signal, strongest first. */
    candidates: Array<{
        type: CallType;
        score: number;
        matched: string[];
    }>;
    method: "deterministic";
};
/**
 * Classify a call from its transcript using authored phrase signals. Pure,
 * deterministic, key-free. Score = distinct positive signals matched minus
 * distinct negative signals; the strongest type wins. Confidence is `high`
 * only when one type clearly leads (>=2 signals and a >=2 margin over the
 * runner-up); a single weak signal yields `low`; no signal yields `other`/none.
 */
export declare function classifyCall(transcript: string): CallClassification;
/** Shared qualitative bands over a 1-5 weighted overall. */
export declare const BANDS_5: ScoreBand[];
/**
 * Pick the qualitative band for a weighted overall: the highest band whose
 * `min` the score reaches. Deterministic, client-side — same input, same band.
 */
export declare function bandForScore(score: number, bands: ScoreBand[]): ScoreBand | undefined;
/**
 * The type-specific rubric for a call type, or the generic fallback. The
 * generic rubric is intentionally discovery-leaning (the most common scored
 * call) and is what `other`/`internal`/unknown resolve to.
 */
export declare function rubricForCallType(type: CallType, fallback: Rubric): Rubric;
/** All authored presets, for `--list` and docs. */
export declare function rubricPresets(): Rubric[];

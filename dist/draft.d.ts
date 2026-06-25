import { type LlmCallOptions } from "./llm.ts";
import { type JudgeDecision } from "./judge.ts";
import { type Signal } from "./signals.ts";
import type { GtmEvidence, PatchPlan } from "./types.ts";
/**
 * The draft layer: turn a judge `send` decision into ONE trigger-grounded opener
 * per hot account, emitted as a governed `create_task` PatchOperation so it flows
 * through the existing `plans approve` → `apply` chain. This is the last thin
 * piece of the brain: signals (when) → judge (who) → DRAFT (what to say) →
 * governed apply (sent only on approval).
 *
 * GOVERNANCE — structural, forever: a draft is a PROPOSAL, never a send. `draft`
 * stages a `needs_approval` PatchPlan of `create_task` ops carrying the opener
 * text; it calls NO email/LinkedIn send API and adds none. `apply` writes the
 * draft into the CRM (as a task for a human/downstream sender to act on); it does
 * not transmit a message. `riskLevel: "low"` (a draft is reversible — it's text
 * in a task) but `approvalRequired: true` ALWAYS, so a draft is never auto-applied
 * even under a scheduled run.
 *
 * EVIDENCE GATE — structural: the opener's FIRST LINE must contain a verbatim
 * normalized-whitespace span (≥12 chars) of the decision's `whyNow` (itself a
 * verbatim span of a credited signal quote, gated by the judge). A draft whose
 * line 1 does not ground in the trigger is REJECTED, not saved — the self-discard
 * rule: "if the message could have gone out last month unchanged, throw it away."
 *
 * NO-KEY PATH — honestly degraded: without an LLM key, `draft` emits a clearly
 * labeled template stub (`[[DRAFT - no LLM key]] ...`) rather than fake authored
 * copy, so an operator without a key sees the structure but is never handed wooden
 * copy passed off as a real draft.
 */
export type DraftChannel = "email" | "linkedin" | "task";
export declare const DRAFT_CHANNELS: DraftChannel[];
/** A single authored opener for one hot account, before it becomes a patch op. */
export type Draft = {
    accountDomain: string;
    /** The full opener body. */
    opener: string;
    /** The decision this draft was authored from. */
    decision: JudgeDecision;
    /** The credited signal whose quote grounds the opener (the trigger anchor). */
    signal: Signal;
    /** "deterministic" (the labeled stub) | "llm:<provider>:<model>". */
    producedBy: string;
    /** True when the grounding signal is older than the freshness window. */
    staleTrigger: boolean;
};
/** A draft that failed the first-line evidence gate — surfaced, never saved. */
export type RejectedDraft = {
    accountDomain: string;
    opener: string;
    reason: string;
};
export type DraftResult = {
    plan: PatchPlan;
    drafts: Draft[];
    rejected: RejectedDraft[];
};
/** Stable patch-operation id for a draft op (mirrors enrich's `op_enr_<hash>`). */
export declare function draftOperationId(channel: string, accountDomain: string): string;
/** Stable evidence id for the signal a draft is grounded in. */
export declare function draftEvidenceId(signalId: string): string;
/**
 * Default freshness window for the self-discard rule. A draft whose grounding
 * signal's `firstSeen` is older than this is flagged `staleTrigger` so the human
 * reviewer catches a manufactured-relevance opener before approving it. 14 days
 * mirrors the judge's `FRESH_SIGNAL_DAYS`.
 */
export declare const DEFAULT_FRESHNESS_DAYS = 14;
export declare function isStaleTrigger(firstSeen: string, now: Date, windowDays?: number): boolean;
export declare const DEFAULT_DRAFT_PROMPT = "You are writing ONE cold opener for a single hot account, grounded in a real, fresh trigger.\nThe opener's FIRST LINE must quote the trigger back in the buyer's own words \u2014 copy a verbatim span of the why-now below into line 1. Never open with \"Hi {{firstName}}\" or any greeting placeholder.\nRules (the operator owns these \u2014 edit this prompt to change them):\n- Line 1: open on the real trigger, in the buyer's words. It MUST contain a verbatim span of the why-now quote.\n- One sentence tying the trigger to ONE problem you solve. Specific, not generic.\n- End with ONE low-friction ask. No fake urgency, no \"circling back\".\n- No em dashes. No \"Hi {{firstName}}\". Keep it short \u2014 a real trigger does not need nine sentences.";
/**
 * Strip em dashes (voice rule), collapse runs of whitespace WITHIN a line while
 * preserving line breaks (line 1 grounding depends on the first line surviving
 * intact), and trim trailing whitespace. Returns the cleaned opener.
 */
export declare function sanitizeOpener(opener: string): string;
/** The first non-empty line of an opener — the line the evidence gate checks. */
export declare function firstLine(opener: string): string;
/**
 * Does the opener's first line contain a verbatim ≥12-char normalized span of the
 * decision's whyNow? This is the self-discard gate: a draft that doesn't ground
 * line 1 in the trigger is rejected, not saved.
 */
export declare function firstLineGroundedInTrigger(opener: string, whyNow: string): boolean;
/** Reject openers that lead with a banned greeting placeholder. */
export declare function hasBannedGreeting(opener: string): boolean;
/**
 * Build a `GtmEvidence` from the signal a draft is grounded in — the trigger that
 * justified the opener. `sourceSystem` is "web" for fetched signals (ATS boards
 * via global fetch) and "manual" for ingested ones; `text` is the VERBATIM signal
 * quote (the evidence anchor reused all the way from `signals fetch`).
 */
export declare function draftEvidence(signal: Signal, capturedAt: string): GtmEvidence;
/**
 * The no-key, honestly-degraded baseline. Emits a clearly-labeled template stub
 * — NEVER fake authored copy. Line 1 is the verbatim whyNow (so the first-line
 * evidence gate passes by construction), followed by the play (if any) as the
 * "what to say" scaffold the operator fills in once they add a key.
 */
export declare function deterministicOpener(decision: JudgeDecision): string;
export declare const DRAFT_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["opener"];
    readonly properties: {
        readonly opener: {
            readonly type: "string";
            readonly description: string;
        };
    };
};
/**
 * The LLM drafter for one account. Forced tool call with `DRAFT_SCHEMA` + the
 * editable prompt; then the FIRST-LINE evidence gate: line 1 must contain a
 * verbatim ≥12-char span of the decision's whyNow. Retry once with corrective
 * feedback (the judge/market idiom), then — rather than store an ungrounded
 * opener — fall back to the deterministic stub. The brain NEVER ships an opener
 * whose first line isn't grounded in the trigger.
 */
export declare function draftOpenerLlm(decision: JudgeDecision, signal: Signal, promptTemplate: string, llm: LlmCallOptions): Promise<{
    opener: string;
    producedBy: string;
    grounded: boolean;
}>;
/**
 * Author one opener per hot account and stage them as a `needs_approval` plan of
 * `create_task` PatchOperations, each carrying a `GtmEvidence` (the signal quote)
 * on `plan.evidence` and referenced via `op.evidenceIds`. Read-only: builds the
 * plan in memory; the caller persists it via `createFilePlanStore().save(plan)`
 * only on `--save`. NEVER sends.
 *
 * - Takes decisions with `decision === "send"` and `score >= minScore`.
 * - Picks the credited signal whose quote grounds the whyNow as the trigger
 *   anchor (the evidence the opener traces back to).
 * - Authors the opener: LLM (gated, first-line evidence) when `llm` is provided,
 *   else the labeled deterministic stub.
 * - First-line evidence gate: an opener whose line 1 doesn't ground in the whyNow
 *   is REJECTED (surfaced in `rejected`, never an op). The deterministic stub and
 *   the LLM fallback are grounded by construction, so they always pass.
 * - Stale-trigger: a draft whose grounding signal is older than the freshness
 *   window gets a `staleTrigger` warning appended to the op `reason`.
 */
export declare function draft(opts: {
    decisions: JudgeDecision[];
    /** Credited signals by id — supplies the verbatim quote each opener grounds in. */
    signalsById: Map<string, Signal>;
    minScore?: number;
    channel?: DraftChannel;
    /** Pre-authored openers by accountDomain (the LLM path runs in the async caller). */
    openers?: Map<string, {
        opener: string;
        producedBy: string;
        grounded: boolean;
        signalId: string;
    }>;
    freshnessDays?: number;
    now?: Date;
}): DraftResult;
/**
 * Pick the credited signal whose quote grounds the decision's whyNow — the
 * trigger the opener traces back to. Prefers a signal whose quote verbatim
 * contains the whyNow span; falls back to the first resolvable credited signal so
 * the evidence chain is never empty when a credit exists.
 */
export declare function creditedTriggerSignal(decision: JudgeDecision, signalsById: Map<string, Signal>): Signal | undefined;
/**
 * Author openers for the hot decisions via the LLM path (or the deterministic
 * stub when no `llm` is provided), returning the map `draft()` consumes. Kept
 * separate from `draft()` so the plan-assembly stays pure/synchronous and the
 * async authoring is testable in isolation.
 */
export declare function authorOpeners(opts: {
    decisions: JudgeDecision[];
    signalsById: Map<string, Signal>;
    minScore?: number;
    promptTemplate?: string;
    llm?: LlmCallOptions;
}): Promise<Map<string, {
    opener: string;
    producedBy: string;
    grounded: boolean;
    signalId: string;
}>>;

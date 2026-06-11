import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
/**
 * Deterministic value suggestions for `requires_human_*` placeholder
 * operations. The engine never invents data: every suggestion is derived
 * from evidence already in the snapshot (account names, contact→account
 * associations, the org's user list) and carries a confidence level plus a
 * human-readable reason, so a reviewer — or an agent driving the CLI — can
 * approve in bulk at a chosen confidence threshold.
 *
 * Born from dogfooding: an audit of a real portal produced 30
 * `requires_human_account_selection` placeholders whose answers were all
 * derivable from the snapshot itself.
 */
export type SuggestionConfidence = "high" | "low" | "create" | "none";
export type ValueSuggestion = {
    operationId: string;
    objectType: string;
    objectId: string;
    /** Display name of the object the operation targets (e.g. the deal name). */
    objectName?: string;
    /** The requires_human_* placeholder being filled. */
    placeholder: string;
    /**
     * The value to approve with, or null when no evidence supports one.
     * `create:<Name>` proposes creating the missing record on apply.
     */
    suggestedValue: string | null;
    confidence: SuggestionConfidence;
    reason: string;
};
export declare function suggestValues(plan: PatchPlan, snapshot: CanonicalGtmSnapshot): ValueSuggestion[];

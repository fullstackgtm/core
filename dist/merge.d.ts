import type { CanonicalGtmSnapshot } from "./types.ts";
/**
 * Entity resolution across systems. GTM data disagrees because the same
 * real-world entity lives in several tools under different ids; merging
 * collapses canonical records onto deterministic match keys (account domain,
 * contact/user email) while every original system id survives as an identity
 * claim. Deals and activities are never merged — they are provider-unique —
 * but their references are re-pointed at the merged records.
 *
 * Merging never invents data: the first source wins for conflicting fields,
 * and every disagreement is reported, not silently resolved.
 */
export type MergeMatch = {
    type: "user" | "account" | "contact";
    primaryId: string;
    mergedIds: string[];
    matchedBy: "email" | "domain" | "name";
};
export type MergeConflict = {
    type: "user" | "account" | "contact";
    recordId: string;
    field: string;
    values: Array<{
        provider: string;
        value: unknown;
    }>;
};
/**
 * A same-name collision that was NOT auto-merged (different or absent
 * domains). Surfaced for human review rather than silently combined —
 * fabricating a merge between two real companies both named "Acme" would
 * corrupt deals, contacts, and attribution.
 */
export type MergeSuggestion = {
    type: "account";
    name: string;
    recordIds: string[];
};
export type MergeReport = {
    sources: string[];
    matches: MergeMatch[];
    conflicts: MergeConflict[];
    suggestions: MergeSuggestion[];
};
export declare function normalizeDomain(domain?: string): string | undefined;
export declare function mergeSnapshots(snapshots: CanonicalGtmSnapshot[]): {
    snapshot: CanonicalGtmSnapshot;
    report: MergeReport;
};

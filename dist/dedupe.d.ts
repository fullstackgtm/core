import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
export type DedupeOptions = {
    objectType: "account" | "contact" | "deal";
    /** identity key records are grouped by (normalized before grouping) */
    key: "domain" | "email" | "name";
    /** survivor selection — deterministic either way (default "richest") */
    keep?: "richest" | "oldest";
    reason?: string;
    /** refuse to build plans larger than this (default 500 operations) */
    maxOperations?: number;
};
/**
 * The subset of a record worth keeping as a merge-recovery artifact: its id (to
 * reference) plus every populated data field, dropping bulky/plumbing fields
 * (raw, identities, provenance) that aren't needed to recreate it by hand.
 */
export declare function recoverableFields(record: Record<string, unknown>): Record<string, unknown>;
/** Normalize a record's identity key; undefined when the field is empty. */
export declare function dedupeKey(record: Record<string, unknown>, key: DedupeOptions["key"]): string | undefined;
export declare function buildDedupePlan(snapshot: CanonicalGtmSnapshot, options: DedupeOptions): PatchPlan;

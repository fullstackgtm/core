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
/** Normalize a record's identity key; undefined when the field is empty. */
export declare function dedupeKey(record: Record<string, unknown>, key: DedupeOptions["key"]): string | undefined;
export declare function buildDedupePlan(snapshot: CanonicalGtmSnapshot, options: DedupeOptions): PatchPlan;

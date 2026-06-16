import type { CanonicalGtmSnapshot, PatchPlan, PlanGuard } from "./types.ts";
export type BulkUpdateOptions = {
    objectType: "account" | "contact" | "deal";
    /** raw --where expressions, AND-ed together; at least one is required */
    where: string[];
    /**
     * canonical field → new value; one action only. A value of the form
     * `from:<sourceField>` is resolved PER RECORD from the filter view at
     * plan time (relational pseudo-fields like account.ownerId included);
     * records whose source value is empty are skipped, not failed, and
     * counted in the plan summary.
     */
    set?: Record<string, string>;
    /** propose archive_record instead of field writes */
    archive?: boolean;
    /**
     * bypass the archive duplicate guard: by default --archive refuses when a
     * matched account/contact shares its identity key (normalized domain /
     * lowercased email) with another record — those are duplicates, and
     * archiving a duplicate discards its data where merging preserves it
     */
    forceArchiveDuplicates?: boolean;
    /** propose create_task on each matched record with this subject/body text */
    createTask?: string;
    /** explicit preconditions (field=value), re-verified at apply time */
    require?: string[];
    /**
     * plan-level guards, raw form "<objectType>:<where>[;<where>…]:<none|some>",
     * re-evaluated against a fresh snapshot at apply time; failure aborts the
     * entire plan
     */
    guard?: string[];
    reason?: string;
    /** refuse to build plans larger than this (default 500 operations) */
    maxOperations?: number;
    /**
     * Date the comparison `today` literal resolves to (ISO yyyy-mm-dd). Set from
     * the policy/--today date at the CLI; defaults to the system date. Stored on
     * plan.filter so apply-time filter re-verification resolves `today`
     * identically to plan time.
     */
    today?: string;
};
type WhereClause = {
    field: string;
    op: "eq" | "neq" | "contains" | "notcontains" | "empty" | "notempty" | "lt" | "gt" | "lte" | "gte";
    value?: string;
    raw: string;
};
export declare function parseWhere(expr: string): WhereClause;
/** True when `field` is filterable for this object type (relational pseudo-fields included). */
export declare function isFilterableField(objectType: BulkUpdateOptions["objectType"], field: string): boolean;
export declare function parseGuard(raw: string): PlanGuard;
/**
 * Ids of records matching a filter — used for apply-time filter
 * re-verification. `today` resolves the comparison `today` literal; apply-time
 * callers pass the value the plan was built with (stored on plan.filter.today)
 * so re-verification uses the SAME today, defaulting to the system date.
 */
export declare function eligibleIds(snapshot: CanonicalGtmSnapshot, objectType: BulkUpdateOptions["objectType"], where: string[], today?: string): Set<string>;
/** Evaluate a plan guard against a snapshot. Returns null when satisfied, else a failure detail. */
export declare function evaluateGuard(snapshot: CanonicalGtmSnapshot, guard: PlanGuard, today?: string): string | null;
export declare function buildBulkUpdatePlan(snapshot: CanonicalGtmSnapshot, options: BulkUpdateOptions): PatchPlan;
export {};

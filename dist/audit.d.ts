import type { CanonicalGtmSnapshot, GtmAuditRule, GtmPolicy, PatchPlan } from "./types.ts";
export declare function defaultPolicy(today?: string): GtmPolicy;
/**
 * Run every rule over the snapshot and collect the results into a single
 * dry-run patch plan. Pass custom rules to extend or replace the built-ins.
 */
export declare function auditSnapshot(snapshot: CanonicalGtmSnapshot, policy?: GtmPolicy, rules?: GtmAuditRule[]): PatchPlan;

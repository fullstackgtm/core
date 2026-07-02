import type { CanonicalGtmSnapshot, GtmAuditRule, GtmPolicy, PatchPlan } from "./types.ts";
export declare function defaultPolicy(today?: string): GtmPolicy;
/**
 * Run every rule over the snapshot and collect the results into a single
 * dry-run patch plan. Pass custom rules to extend or replace the built-ins.
 * `onRule` reports per-rule progress (presentation only — a throwing callback
 * never fails the audit).
 */
export declare function auditSnapshot(snapshot: CanonicalGtmSnapshot, policy?: GtmPolicy, rules?: GtmAuditRule[], onRule?: (ruleId: string, phase: "start" | "done", findings?: number) => void): PatchPlan;

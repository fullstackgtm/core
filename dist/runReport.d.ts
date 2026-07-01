/**
 * Per-row finding for the hosted run timeline. IDs + issue type ONLY — no field
 * values ever leave the CLI, keeping the audit's row data on the operator's side
 * while still giving the dashboard navigable, filterable detail.
 */
export type RunFinding = {
    objectType: string;
    objectId: string;
    severity: string;
    ruleId: string;
    field?: string;
    operation?: string;
};
/**
 * Where a run's findings live in the source CRM, so the dashboard can deep-link
 * each record. `recordUrlBase` is the provider's record URL prefix; the
 * dashboard appends the per-object path. Just an URL prefix — no record data.
 */
export type RunCrm = {
    provider: string;
    recordUrlBase: string;
};
/** A command annotates its headline metrics (merged). */
export declare function reportCounts(values: Record<string, unknown>): void;
/** A command reports per-row findings (IDs + issue type, no values). */
export declare function reportFindings(values: RunFinding[]): void;
/** A command reports the source CRM's record-URL base for dashboard deep-links. */
export declare function reportCrm(value: RunCrm): void;
/** A command annotates a structured event (plan saved, meter charged, …). */
export declare function reportEvent(type: string, detail?: string): void;
/**
 * Send the run record if the CLI is paired. Best-effort: a 4s-capped POST that
 * swallows every error. Call once per process from the entry point.
 */
export declare function flushRunReport(args: string[], status: "success" | "partial" | "error", startedAt: number, error?: string): Promise<void>;

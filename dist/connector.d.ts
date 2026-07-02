import type { GtmConnector, PatchPlan, PatchPlanRun } from "./types.ts";
export type ApplyPatchPlanOptions = {
    /**
     * Explicit allow-list of operation ids the human approved. Operations not
     * listed are skipped without any provider call. An empty list rejects the
     * whole run.
     */
    approvedOperationIds: string[];
    /**
     * Concrete values supplied at approval time for operations whose
     * `afterValue` is a `requires_human_*` placeholder, keyed by operation id.
     */
    valueOverrides?: Record<string, unknown>;
    /**
     * Compare-and-set: before each field write, read the live provider value
     * and refuse the write (`conflict` result) if it no longer matches the
     * plan's `beforeValue`. Defaults to on when the connector supports
     * `readField`.
     */
    checkConflicts?: boolean;
    /**
     * For plans carrying a filter or guards: re-run the snapshot checks after
     * the first applied write and then every N applied writes, so a record
     * edited mid-apply is conflicted out instead of overwritten. Default 25.
     */
    recheckEvery?: number;
    /**
     * Per-operation progress as the run executes (presentation only — a
     * throwing callback never affects the run). `completed` counts every
     * resolved operation including skips and conflicts; `total` is the plan's
     * full operation count.
     */
    onOperation?: (progress: ApplyProgress) => void;
};
export type ApplyProgress = {
    completed: number;
    total: number;
    applied: number;
    failed: number;
    conflicts: number;
    skipped: number;
};
/**
 * Apply an approved subset of a patch plan through a connector.
 *
 * The safety contract lives here, not in connectors:
 * - nothing is written unless the operation id was explicitly approved
 * - placeholder values are never written; they require an override
 * - every operation produces a result, and the run is the audit record
 */
export declare function applyPatchPlan(connector: GtmConnector, plan: PatchPlan, options: ApplyPatchPlanOptions): Promise<PatchPlanRun>;

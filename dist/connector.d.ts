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

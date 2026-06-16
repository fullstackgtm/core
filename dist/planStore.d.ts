import type { ApprovalStatus, PatchPlan, PatchPlanRun } from "./types.ts";
/**
 * Durable patch-plan workflow. A plan is an immutable proposal; the store
 * tracks the mutable lifecycle around it — which operations a human approved,
 * the concrete values they supplied, and every apply run. The hosted app's
 * Convex tables and this file store are two implementations of the same
 * contract.
 */
export type StoredPlan = {
    plan: PatchPlan;
    status: ApprovalStatus;
    approvedOperationIds: string[];
    valueOverrides: Record<string, unknown>;
    /**
     * HMAC of each approved operation's content at approval time (see
     * integrity.ts). Apply re-verifies these so a post-approval edit to the plan
     * file is caught instead of written. Absent on plans approved before 0.26.0.
     */
    approvalDigests?: Record<string, string>;
    runs: PatchPlanRun[];
    createdAt: string;
    updatedAt: string;
};
export interface PlanStore {
    save(plan: PatchPlan): Promise<StoredPlan>;
    get(planId: string): Promise<StoredPlan | null>;
    list(status?: ApprovalStatus): Promise<StoredPlan[]>;
    approveOperations(planId: string, operationIds: string[], valueOverrides?: Record<string, unknown>): Promise<StoredPlan>;
    reject(planId: string): Promise<StoredPlan>;
    recordRun(planId: string, run: PatchPlanRun): Promise<StoredPlan>;
}
/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export declare function createFilePlanStore(directory?: string): PlanStore;

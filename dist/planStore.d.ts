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
    /** Monotonic store revision used to make lifecycle changes explicit. */
    revision: number;
    /** Present only while one process owns the right to apply this plan. */
    applyClaim?: {
        id: string;
        claimedAt: string;
        revision: number;
        hostedClaimId?: string;
    };
    /** Durable journal of apply ownership. An unresolved entry must never be replayed automatically. */
    applyAttempts?: ApplyAttempt[];
    runs: PatchPlanRun[];
    createdAt: string;
    updatedAt: string;
};
export type ApplyAttempt = {
    id: string;
    claimedAt: string;
    provider: string;
    source: "cli" | "fix" | "mcp";
    status: "in_progress" | "preflight_aborted" | "completed" | "uncertain";
    resolvedAt?: string;
    /** Deliberately generic: provider errors can contain CRM data or credentials. */
    note?: string;
    hostedClaimId?: string;
};
export interface PlanStore {
    save(plan: PatchPlan): Promise<StoredPlan>;
    get(planId: string): Promise<StoredPlan | null>;
    list(status?: ApprovalStatus): Promise<StoredPlan[]>;
    approveOperations(planId: string, operationIds: string[], valueOverrides?: Record<string, unknown>): Promise<StoredPlan>;
    reject(planId: string): Promise<StoredPlan>;
    claimApply(planId: string, metadata?: Pick<ApplyAttempt, "provider" | "source">): Promise<{
        stored: StoredPlan;
        claimId: string;
    }>;
    recordHostedClaim(planId: string, claimId: string, hostedClaimId: string): Promise<StoredPlan>;
    recordRun(planId: string, run: PatchPlanRun, claimId: string): Promise<StoredPlan>;
    abortApplyPreflight(planId: string, claimId: string, note: string): Promise<StoredPlan>;
    markApplyUncertain(planId: string, claimId: string): Promise<StoredPlan>;
    recoverApply(planId: string): Promise<StoredPlan>;
    reconcileReplica(planId: string, remote: ReplicaPlanState): Promise<{
        stored: StoredPlan;
        changed: boolean;
    }>;
}
/** A validated lifecycle snapshot received from another plan replica. */
export type ReplicaPlanState = {
    status: "approved" | "rejected" | "applied";
    approvedOperationIds: string[];
    valueOverrides?: Record<string, unknown>;
    run?: PatchPlanRun;
};
/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export declare function createFilePlanStore(directory?: string): PlanStore;

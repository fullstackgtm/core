import type { PlanStore, StoredPlan } from "./planStore.ts";
import type { PatchOperation, PatchPlan, PatchPlanRun } from "./types.ts";
type Options = {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
};
export type HostedPlanState = {
    patchPlanId: string;
    externalPlanId: string;
    documentSha256: string;
    status: string;
    approvedOperationIds: string[];
    valueOverrides: Record<string, unknown>;
    updatedAt: number;
    runRecord?: PatchPlanRun;
    url: string;
};
export type HostedPlanResult = {
    status: "unpaired";
} | {
    status: "missing";
} | {
    status: "found" | "saved";
    state: HostedPlanState;
} | {
    status: "conflict";
    reason: string;
} | {
    status: "unavailable";
    reason: string;
};
/** Review document intentionally omits evidence/findings and all mutable store security state. */
export declare function hostedReviewDocument(plan: PatchPlan): {
    guards?: import("./types.ts").PlanGuard[] | undefined;
    filter?: {
        objectType: "account" | "contact" | "deal";
        where: string[];
        today?: string;
    } | undefined;
    id: string;
    title: string;
    createdAt: string;
    status: string;
    dryRun: boolean;
    summary: string;
    operations: PatchOperation[];
};
export declare function hostedPlanDigest(plan: PatchPlan): string;
export declare function uploadHostedPatchPlan(stored: StoredPlan, options?: Options): Promise<HostedPlanResult>;
export declare function readHostedPatchPlan(planId: string, options?: Options): Promise<HostedPlanResult>;
export type HostedReconcileResult = {
    status: "unchanged" | "unpaired" | "missing";
} | {
    status: "updated";
    stored: StoredPlan;
    remoteStatus: string;
} | {
    status: "conflict" | "unavailable";
    reason: string;
};
/** Pull a peer's newer lifecycle into the local replica without weakening local integrity gates. */
export declare function reconcileHostedPatchPlan(store: PlanStore, stored: StoredPlan, options?: Options): Promise<HostedReconcileResult>;
export declare function reportHostedPlanLifecycle(stored: StoredPlan, options?: Options & {
    claimId?: string;
}): Promise<HostedPlanResult>;
export type HostedApplyClaimResult = {
    status: "unpaired";
} | {
    status: "claimed";
    claimId: string;
    expiresAt?: number;
} | {
    status: "applied";
} | {
    status: "conflict" | "unavailable";
    reason: string;
};
/** Coordinate online replicas before provider I/O; provider idempotency remains the offline fallback. */
export declare function claimHostedPlanApply(stored: StoredPlan, options?: Options): Promise<HostedApplyClaimResult>;
/** Release a shared CLI claim only when preflight aborts before provider I/O. */
export declare function releaseHostedPlanApply(stored: StoredPlan, claimId: string, reason: string, options?: Options): Promise<{
    status: "released" | "unpaired";
} | {
    status: "conflict" | "unavailable";
    reason: string;
}>;
export {};

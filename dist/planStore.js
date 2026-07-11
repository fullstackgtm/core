import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.js";
import { computeApprovalDigests, loadOrCreateSigningKey } from "./integrity.js";
import { assertNoSymlinkComponents, readSecureRegularFile, UnsafeManagedPathError } from "./secureFile.js";
/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export function createFilePlanStore(directory) {
    const dir = directory ?? join(credentialsDir(), "plans");
    function ensurePlanDirectory() {
        assertNoSymlinkComponents(dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        assertNoSymlinkComponents(dir);
    }
    function pathFor(planId) {
        if (!/^[\w.-]+$/.test(planId))
            throw new Error(`Invalid plan id: ${planId}`);
        return join(dir, `${planId}.json`);
    }
    function read(planId) {
        try {
            assertNoSymlinkComponents(dir);
            return JSON.parse(readSecureRegularFile(pathFor(planId)));
        }
        catch (error) {
            if (error instanceof UnsafeManagedPathError)
                throw error;
            return null;
        }
    }
    function write(stored) {
        // Plan files contain real CRM before/after values; keep them owner-only.
        // When the store lives under the default home, lock that down too —
        // otherwise an `audit --save` before any `login` would create the home
        // directory world-readable.
        if (!directory)
            ensureSecureHomeDir();
        ensurePlanDirectory();
        try {
            chmodSync(dir, 0o700);
        }
        catch {
            // Non-POSIX filesystems ignore chmod.
        }
        const next = {
            ...stored,
            revision: (stored.revision ?? 0) + 1,
            updatedAt: new Date().toISOString(),
        };
        writeSecureFile(pathFor(stored.plan.id), `${JSON.stringify(next, null, 2)}\n`);
        return next;
    }
    function mustRead(planId) {
        const stored = read(planId);
        if (!stored)
            throw new Error(`No stored plan with id ${planId}.`);
        return stored;
    }
    function withPlanLock(planId, action) {
        ensurePlanDirectory();
        const lockPath = `${pathFor(planId)}.lock`;
        let fd;
        try {
            fd = openSync(lockPath, "wx", 0o600);
        }
        catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
            if (code === "EEXIST") {
                throw new Error(`Plan ${planId} is being updated by another process; retry after it finishes.`);
            }
            throw error;
        }
        try {
            return action();
        }
        finally {
            closeSync(fd);
            try {
                unlinkSync(lockPath);
            }
            catch { /* a missing lock is already released */ }
        }
    }
    return {
        async save(plan) {
            return withPlanLock(plan.id, () => {
                const existing = read(plan.id);
                if (existing && ["approved", "applying", "applied"].includes(existing.status)) {
                    throw new Error(`Plan ${plan.id} is already ${existing.status}; refusing to replace its approval or apply history.`);
                }
                const now = new Date().toISOString();
                return write({
                    plan,
                    status: plan.status,
                    approvedOperationIds: [],
                    valueOverrides: {},
                    revision: 0,
                    runs: [],
                    createdAt: now,
                    updatedAt: now,
                });
            });
        },
        async get(planId) {
            return read(planId);
        },
        async list(status) {
            assertNoSymlinkComponents(dir);
            let entries = [];
            try {
                entries = readdirSync(dir);
            }
            catch {
                return [];
            }
            const plans = entries
                .filter((entry) => entry.endsWith(".json"))
                .map((entry) => read(entry.slice(0, -".json".length)))
                .filter((stored) => stored !== null)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            return status ? plans.filter((stored) => stored.status === status) : plans;
        },
        async approveOperations(planId, operationIds, valueOverrides = {}) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status === "applied") {
                    throw new Error(`Plan ${planId} has already been applied.`);
                }
                if (stored.status === "rejected") {
                    throw new Error(`Plan ${planId} was rejected; re-run the audit for a fresh plan.`);
                }
                if (stored.status === "applying" || stored.applyClaim) {
                    throw new Error(`Plan ${planId} is applying; approvals are frozen until the attempt is resolved.`);
                }
                const known = new Set(stored.plan.operations.map((operation) => operation.id));
                for (const operationId of operationIds) {
                    if (!known.has(operationId)) {
                        throw new Error(`Plan ${planId} has no operation ${operationId}.`);
                    }
                }
                const approvedOperationIds = Array.from(new Set([...stored.approvedOperationIds, ...operationIds]));
                const mergedOverrides = { ...stored.valueOverrides, ...valueOverrides };
                // Bind the approval to the operation content so apply can detect a
                // post-approval edit. Recompute over ALL approved ops (a later approve
                // call may add overrides that change an earlier op's resolved value).
                const approvalDigests = computeApprovalDigests(stored.plan.operations, approvedOperationIds, mergedOverrides, loadOrCreateSigningKey());
                return write({
                    ...stored,
                    status: "approved",
                    approvedOperationIds,
                    valueOverrides: mergedOverrides,
                    approvalDigests,
                });
            });
        },
        async reject(planId) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status === "applied") {
                    throw new Error(`Plan ${planId} has already been applied.`);
                }
                if (stored.status === "applying" || stored.applyClaim) {
                    throw new Error(`Plan ${planId} is applying and cannot be rejected until the attempt is resolved.`);
                }
                return write({ ...stored, status: "rejected", approvedOperationIds: [], applyClaim: undefined });
            });
        },
        async claimApply(planId, metadata) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status === "applying" || stored.applyClaim) {
                    throw new Error(`Plan ${planId} is already applying; inspect its recorded attempts before any retry.`);
                }
                if (stored.status !== "approved") {
                    throw new Error(`Plan ${planId} is ${stored.status}; only an approved plan can be claimed for apply.`);
                }
                const claimId = randomUUID();
                const claimedAt = new Date().toISOString();
                const claimed = write({
                    ...stored,
                    status: "applying",
                    applyClaim: {
                        id: claimId,
                        claimedAt,
                        revision: stored.revision ?? 0,
                    },
                    applyAttempts: [...(stored.applyAttempts ?? []), {
                            id: claimId,
                            claimedAt,
                            provider: metadata?.provider ?? "unknown",
                            source: metadata?.source ?? "cli",
                            status: "in_progress",
                        }],
                });
                return { stored: claimed, claimId };
            });
        },
        async recordRun(planId, run, claimId) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status !== "applying" || stored.applyClaim?.id !== claimId) {
                    throw new Error(`Refusing to record run for plan ${planId}: apply claim is missing or does not match.`);
                }
                return write({
                    ...stored,
                    status: run.status === "applied" || run.status === "partial" ? "applied" : "approved",
                    applyClaim: undefined,
                    applyAttempts: (stored.applyAttempts ?? []).map((attempt) => attempt.id === claimId
                        ? { ...attempt, status: "completed", resolvedAt: new Date().toISOString() }
                        : attempt),
                    runs: [...stored.runs, run],
                });
            });
        },
        async recordHostedClaim(planId, claimId, hostedClaimId) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status !== "applying" || stored.applyClaim?.id !== claimId) {
                    throw new Error(`Refusing to attach hosted claim for plan ${planId}: local apply claim does not match.`);
                }
                return write({
                    ...stored,
                    applyClaim: { ...stored.applyClaim, hostedClaimId },
                    applyAttempts: (stored.applyAttempts ?? []).map((attempt) => attempt.id === claimId ? { ...attempt, hostedClaimId } : attempt),
                });
            });
        },
        async abortApplyPreflight(planId, claimId, note) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status !== "applying" || stored.applyClaim?.id !== claimId) {
                    throw new Error(`Refusing to abort preflight for plan ${planId}: apply claim is missing or does not match.`);
                }
                return write({
                    ...stored,
                    status: "approved",
                    applyClaim: undefined,
                    applyAttempts: (stored.applyAttempts ?? []).map((attempt) => attempt.id === claimId
                        ? { ...attempt, status: "preflight_aborted", resolvedAt: new Date().toISOString(), note }
                        : attempt),
                });
            });
        },
        async markApplyUncertain(planId, claimId) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status !== "applying" || stored.applyClaim?.id !== claimId)
                    return stored;
                return write({
                    ...stored,
                    applyAttempts: (stored.applyAttempts ?? []).map((attempt) => attempt.id === claimId
                        ? { ...attempt, status: "uncertain", note: "Apply exited without a completed run; some provider writes may have landed." }
                        : attempt),
                });
            });
        },
        async recoverApply(planId) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status !== "applying" || !stored.applyClaim) {
                    throw new Error(`Plan ${planId} has no unresolved apply attempt.`);
                }
                // Recovery is deliberately privilege-decaying: discard the old approval.
                // An operator must inspect the provider, then explicitly approve a fresh attempt.
                return write({
                    ...stored,
                    status: "needs_approval",
                    applyClaim: undefined,
                    approvedOperationIds: [],
                    valueOverrides: {},
                    approvalDigests: undefined,
                    applyAttempts: (stored.applyAttempts ?? []).map((attempt) => attempt.id === stored.applyClaim.id
                        ? { ...attempt, status: "uncertain", resolvedAt: new Date().toISOString(), note: "Operator acknowledged uncertain provider state; approval cleared before any retry." }
                        : attempt),
                });
            });
        },
        async reconcileReplica(planId, remote) {
            return withPlanLock(planId, () => {
                const stored = mustRead(planId);
                if (stored.status === "applying" || stored.applyClaim) {
                    throw new Error(`Plan ${planId} is applying locally; replica reconciliation will retry after it finishes.`);
                }
                const known = new Set(stored.plan.operations.map((operation) => operation.id));
                const approvedOperationIds = Array.from(new Set(remote.approvedOperationIds));
                if (approvedOperationIds.some((id) => !known.has(id))) {
                    throw new Error(`Replica state for ${planId} contains an unknown operation.`);
                }
                // Terminal receipts are monotonic. A delayed approval or rejection can
                // never roll an already-applied local replica backwards.
                if (stored.status === "applied" && remote.status !== "applied") {
                    return { stored, changed: false };
                }
                if (remote.status === "rejected") {
                    if (stored.status === "rejected")
                        return { stored, changed: false };
                    return { stored: write({
                            ...stored, status: "rejected", approvedOperationIds: [], valueOverrides: {},
                            approvalDigests: undefined, applyClaim: undefined,
                        }), changed: true };
                }
                if (approvedOperationIds.length === 0) {
                    throw new Error(`Replica ${remote.status} state for ${planId} has no approved operations.`);
                }
                const valueOverrides = remote.valueOverrides ?? {};
                const approvalDigests = computeApprovalDigests(stored.plan.operations, approvedOperationIds, valueOverrides, loadOrCreateSigningKey());
                if (remote.status === "approved") {
                    const unchanged = stored.status === "approved"
                        && JSON.stringify(stored.approvedOperationIds) === JSON.stringify(approvedOperationIds)
                        && JSON.stringify(stored.valueOverrides) === JSON.stringify(valueOverrides);
                    if (unchanged)
                        return { stored, changed: false };
                    return { stored: write({
                            ...stored, status: "approved", approvedOperationIds, valueOverrides, approvalDigests,
                        }), changed: true };
                }
                if (!remote.run || remote.run.planId !== planId) {
                    throw new Error(`Replica applied state for ${planId} is missing a matching execution receipt.`);
                }
                if (remote.run.results.some((result) => !known.has(result.operationId))) {
                    throw new Error(`Replica execution receipt for ${planId} contains an unknown operation.`);
                }
                const runKey = (run) => `${run.startedAt}\0${run.finishedAt}\0${run.provider}`;
                const alreadyRecorded = stored.runs.some((run) => runKey(run) === runKey(remote.run));
                if (stored.status === "applied" && alreadyRecorded)
                    return { stored, changed: false };
                return { stored: write({
                        ...stored,
                        status: "applied",
                        approvedOperationIds,
                        valueOverrides,
                        approvalDigests,
                        applyClaim: undefined,
                        runs: alreadyRecorded ? stored.runs : [...stored.runs, remote.run],
                    }), changed: true };
            });
        },
    };
}

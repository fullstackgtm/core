import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import { computeApprovalDigests, loadOrCreateSigningKey } from "./integrity.ts";
import { assertNoSymlinkComponents, readSecureRegularFile, UnsafeManagedPathError } from "./secureFile.ts";
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
};

export interface PlanStore {
  save(plan: PatchPlan): Promise<StoredPlan>;
  get(planId: string): Promise<StoredPlan | null>;
  list(status?: ApprovalStatus): Promise<StoredPlan[]>;
  approveOperations(
    planId: string,
    operationIds: string[],
    valueOverrides?: Record<string, unknown>,
  ): Promise<StoredPlan>;
  reject(planId: string): Promise<StoredPlan>;
  claimApply(planId: string, metadata?: Pick<ApplyAttempt, "provider" | "source">): Promise<{ stored: StoredPlan; claimId: string }>;
  recordRun(planId: string, run: PatchPlanRun, claimId: string): Promise<StoredPlan>;
  abortApplyPreflight(planId: string, claimId: string, note: string): Promise<StoredPlan>;
  markApplyUncertain(planId: string, claimId: string): Promise<StoredPlan>;
  recoverApply(planId: string): Promise<StoredPlan>;
}

/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export function createFilePlanStore(directory?: string): PlanStore {
  const dir = directory ?? join(credentialsDir(), "plans");

  function ensurePlanDirectory(): void {
    assertNoSymlinkComponents(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(dir);
  }

  function pathFor(planId: string) {
    if (!/^[\w.-]+$/.test(planId)) throw new Error(`Invalid plan id: ${planId}`);
    return join(dir, `${planId}.json`);
  }

  function read(planId: string): StoredPlan | null {
    try {
      assertNoSymlinkComponents(dir);
      return JSON.parse(readSecureRegularFile(pathFor(planId))) as StoredPlan;
    } catch (error) {
      if (error instanceof UnsafeManagedPathError) throw error;
      return null;
    }
  }

  function write(stored: StoredPlan): StoredPlan {
    // Plan files contain real CRM before/after values; keep them owner-only.
    // When the store lives under the default home, lock that down too —
    // otherwise an `audit --save` before any `login` would create the home
    // directory world-readable.
    if (!directory) ensureSecureHomeDir();
    ensurePlanDirectory();
    try {
      chmodSync(dir, 0o700);
    } catch {
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

  function mustRead(planId: string): StoredPlan {
    const stored = read(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    return stored;
  }

  function withPlanLock<T>(planId: string, action: () => T): T {
    ensurePlanDirectory();
    const lockPath = `${pathFor(planId)}.lock`;
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      if (code === "EEXIST") {
        throw new Error(`Plan ${planId} is being updated by another process; retry after it finishes.`);
      }
      throw error;
    }
    try {
      return action();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* a missing lock is already released */ }
    }
  }

  return {
    async save(plan) {
      return withPlanLock(plan.id, () => {
        const existing = read(plan.id);
        if (existing && ["approved", "applying", "applied"].includes(existing.status)) {
          throw new Error(
            `Plan ${plan.id} is already ${existing.status}; refusing to replace its approval or apply history.`,
          );
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
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      const plans = entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => read(entry.slice(0, -".json".length)))
        .filter((stored): stored is StoredPlan => stored !== null)
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
        const approvedOperationIds = Array.from(
          new Set([...stored.approvedOperationIds, ...operationIds]),
        );
        const mergedOverrides = { ...stored.valueOverrides, ...valueOverrides };
        // Bind the approval to the operation content so apply can detect a
        // post-approval edit. Recompute over ALL approved ops (a later approve
        // call may add overrides that change an earlier op's resolved value).
        const approvalDigests = computeApprovalDigests(
          stored.plan.operations,
          approvedOperationIds,
          mergedOverrides,
          loadOrCreateSigningKey(),
        );
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
          throw new Error(
            `Plan ${planId} is already applying; inspect its recorded attempts before any retry.`,
          );
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
          applyAttempts: (stored.applyAttempts ?? []).map((attempt) =>
            attempt.id === claimId
              ? { ...attempt, status: "completed" as const, resolvedAt: new Date().toISOString() }
              : attempt),
          runs: [...stored.runs, run],
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
          applyAttempts: (stored.applyAttempts ?? []).map((attempt) =>
            attempt.id === claimId
              ? { ...attempt, status: "preflight_aborted" as const, resolvedAt: new Date().toISOString(), note }
              : attempt),
        });
      });
    },

    async markApplyUncertain(planId, claimId) {
      return withPlanLock(planId, () => {
        const stored = mustRead(planId);
        if (stored.status !== "applying" || stored.applyClaim?.id !== claimId) return stored;
        return write({
          ...stored,
          applyAttempts: (stored.applyAttempts ?? []).map((attempt) =>
            attempt.id === claimId
              ? { ...attempt, status: "uncertain" as const, note: "Apply exited without a completed run; some provider writes may have landed." }
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
          applyAttempts: (stored.applyAttempts ?? []).map((attempt) =>
            attempt.id === stored.applyClaim!.id
              ? { ...attempt, status: "uncertain" as const, resolvedAt: new Date().toISOString(), note: "Operator acknowledged uncertain provider state; approval cleared before any retry." }
              : attempt),
        });
      });
    },
  };
}

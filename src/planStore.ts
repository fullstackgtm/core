import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import { computeApprovalDigests, loadOrCreateSigningKey } from "./integrity.ts";
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
  approveOperations(
    planId: string,
    operationIds: string[],
    valueOverrides?: Record<string, unknown>,
  ): Promise<StoredPlan>;
  reject(planId: string): Promise<StoredPlan>;
  recordRun(planId: string, run: PatchPlanRun): Promise<StoredPlan>;
}

/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export function createFilePlanStore(directory?: string): PlanStore {
  const dir = directory ?? join(credentialsDir(), "plans");

  function pathFor(planId: string) {
    if (!/^[\w.-]+$/.test(planId)) throw new Error(`Invalid plan id: ${planId}`);
    return join(dir, `${planId}.json`);
  }

  function read(planId: string): StoredPlan | null {
    try {
      return JSON.parse(readFileSync(pathFor(planId), "utf8")) as StoredPlan;
    } catch {
      return null;
    }
  }

  function write(stored: StoredPlan): StoredPlan {
    // Plan files contain real CRM before/after values; keep them owner-only.
    // When the store lives under the default home, lock that down too —
    // otherwise an `audit --save` before any `login` would create the home
    // directory world-readable.
    if (!directory) ensureSecureHomeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Non-POSIX filesystems ignore chmod.
    }
    const next = { ...stored, updatedAt: new Date().toISOString() };
    writeSecureFile(pathFor(stored.plan.id), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  function mustRead(planId: string): StoredPlan {
    const stored = read(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    return stored;
  }

  return {
    async save(plan) {
      const now = new Date().toISOString();
      return write({
        plan,
        status: plan.status,
        approvedOperationIds: [],
        valueOverrides: {},
        runs: [],
        createdAt: now,
        updatedAt: now,
      });
    },

    async get(planId) {
      return read(planId);
    },

    async list(status) {
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
      const stored = mustRead(planId);
      if (stored.status === "applied") {
        throw new Error(`Plan ${planId} has already been applied.`);
      }
      if (stored.status === "rejected") {
        throw new Error(`Plan ${planId} was rejected; re-run the audit for a fresh plan.`);
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
    },

    async reject(planId) {
      const stored = mustRead(planId);
      if (stored.status === "applied") {
        throw new Error(`Plan ${planId} has already been applied.`);
      }
      return write({ ...stored, status: "rejected", approvedOperationIds: [] });
    },

    async recordRun(planId, run) {
      const stored = mustRead(planId);
      return write({
        ...stored,
        status: run.status === "applied" || run.status === "partial" ? "applied" : stored.status,
        runs: [...stored.runs, run],
      });
    },
  };
}

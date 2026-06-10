import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.js";
/**
 * Plans as JSON files in a directory (default `$FSGTM_HOME/plans`), one file
 * per plan id. Filesystem-shaped on purpose: greppable, diffable, and any
 * file-based tooling composes with it.
 */
export function createFilePlanStore(directory) {
    const dir = directory ?? join(credentialsDir(), "plans");
    function pathFor(planId) {
        if (!/^[\w.-]+$/.test(planId))
            throw new Error(`Invalid plan id: ${planId}`);
        return join(dir, `${planId}.json`);
    }
    function read(planId) {
        try {
            return JSON.parse(readFileSync(pathFor(planId), "utf8"));
        }
        catch {
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
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            chmodSync(dir, 0o700);
        }
        catch {
            // Non-POSIX filesystems ignore chmod.
        }
        const next = { ...stored, updatedAt: new Date().toISOString() };
        writeSecureFile(pathFor(stored.plan.id), `${JSON.stringify(next, null, 2)}\n`);
        return next;
    }
    function mustRead(planId) {
        const stored = read(planId);
        if (!stored)
            throw new Error(`No stored plan with id ${planId}.`);
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
            return write({
                ...stored,
                status: "approved",
                approvedOperationIds: Array.from(new Set([...stored.approvedOperationIds, ...operationIds])),
                valueOverrides: { ...stored.valueOverrides, ...valueOverrides },
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

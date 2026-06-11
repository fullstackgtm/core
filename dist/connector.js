import { requiresHumanInput } from "./rules.js";
const FIELD_WRITE_OPERATIONS = new Set(["set_field", "clear_field", "link_record"]);
function normalizeForComparison(value) {
    if (value === undefined || value === null || value === "")
        return null;
    return String(value);
}
/**
 * Apply an approved subset of a patch plan through a connector.
 *
 * The safety contract lives here, not in connectors:
 * - nothing is written unless the operation id was explicitly approved
 * - placeholder values are never written; they require an override
 * - every operation produces a result, and the run is the audit record
 */
export async function applyPatchPlan(connector, plan, options) {
    if (!connector.applyOperation) {
        throw new Error(`The ${connector.provider} connector is read-only.`);
    }
    const startedAt = new Date().toISOString();
    const approved = new Set(options.approvedOperationIds);
    const checkConflicts = options.checkConflicts ?? typeof connector.readField === "function";
    const results = [];
    let attempted = 0;
    let applied = 0;
    let appliedSinceRecheck = 0;
    // Pass 0 — snapshot-backed checks: plan-level guards and per-record
    // filter re-verification, both against a FRESH snapshot. Cross-record
    // eligibility ("the account still has no open contractsent deal") cannot
    // be checked through per-operation field reads.
    //
    // These checks are NOT one-shot: a concurrent edit can land mid-apply,
    // after the initial verification but before later writes (the TOCTOU
    // window). Providers offer no compare-and-swap, so the window cannot be
    // closed — but it can be shrunk: re-run the snapshot checks after the
    // first write and every `recheckEvery` writes, conflicting out any
    // operation whose record went stale mid-run.
    const needsSnapshot = ((plan.guards && plan.guards.length > 0) || plan.filter) && connector.fetchSnapshot;
    const recheckEvery = Math.max(1, options.recheckEvery ?? 25);
    const staleIds = new Set();
    let guardFailure = null;
    const refreshSnapshotChecks = async () => {
        if (!needsSnapshot)
            return;
        const { evaluateGuard, eligibleIds } = await import("./bulkUpdate.js");
        const liveSnapshot = await connector.fetchSnapshot();
        if (plan.filter) {
            const stillEligible = eligibleIds(liveSnapshot, plan.filter.objectType, plan.filter.where);
            staleIds.clear();
            for (const operation of plan.operations) {
                if (!stillEligible.has(operation.objectId))
                    staleIds.add(operation.objectId);
            }
        }
        for (const guard of plan.guards ?? []) {
            const failure = evaluateGuard(liveSnapshot, guard);
            if (failure) {
                guardFailure = failure;
                return;
            }
        }
    };
    await refreshSnapshotChecks();
    if (guardFailure) {
        for (const operation of plan.operations) {
            results.push({
                operationId: operation.id,
                status: approved.has(operation.id) ? "conflict" : "skipped",
                detail: approved.has(operation.id)
                    ? `${guardFailure} No operation in this plan was applied — re-plan against current data.`
                    : "Operation was not approved.",
            });
        }
        return {
            planId: plan.id,
            provider: connector.provider,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "rejected",
            results,
        };
    }
    const staleByFilter = plan.filter ? staleIds : null;
    // Pass 1 — conflict detection. Re-read the written field (beforeValue
    // compare-and-set) and any explicit preconditions. A conflicted operation
    // never writes; if it carries a groupId, the whole group is poisoned so
    // multi-record changes stay all-or-nothing.
    const conflicts = new Map();
    const poisonedGroups = new Set();
    if (staleByFilter && staleByFilter.size > 0) {
        for (const operation of plan.operations) {
            if (!approved.has(operation.id) || !staleByFilter.has(operation.objectId))
                continue;
            conflicts.set(operation.id, {
                operationId: operation.id,
                status: "conflict",
                detail: `Record ${operation.objectType}/${operation.objectId} no longer matches the plan's filter [${plan.filter.where.join(" AND ")}] — it changed since the plan was built. Re-plan against current data.`,
            });
            if (operation.groupId)
                poisonedGroups.add(operation.groupId);
        }
    }
    if (checkConflicts && connector.readField) {
        for (const operation of plan.operations) {
            if (!approved.has(operation.id) || conflicts.has(operation.id))
                continue;
            let conflict = null;
            if (operation.field && FIELD_WRITE_OPERATIONS.has(operation.operation)) {
                const current = await connector.readField(operation.objectType, operation.objectId, operation.field);
                const expected = normalizeForComparison(operation.beforeValue);
                const found = normalizeForComparison(current);
                if (expected !== found) {
                    conflict = {
                        operationId: operation.id,
                        status: "conflict",
                        detail: `Value drifted since the plan was proposed: expected ${expected ?? "∅"}, found ${found ?? "∅"}. Re-run the audit.`,
                        providerData: { currentValue: current ?? null },
                    };
                }
            }
            if (!conflict && operation.preconditions) {
                for (const precondition of operation.preconditions) {
                    const current = await connector.readField(operation.objectType, operation.objectId, precondition.field);
                    const expected = normalizeForComparison(precondition.expectedValue);
                    const found = normalizeForComparison(current);
                    if (expected !== found) {
                        conflict = {
                            operationId: operation.id,
                            status: "conflict",
                            detail: `Precondition failed: ${precondition.field} was ${expected ?? "∅"} when the plan was built, found ${found ?? "∅"} now. The record changed — re-plan before writing.`,
                            providerData: { preconditionField: precondition.field, currentValue: current ?? null },
                        };
                        break;
                    }
                }
            }
            if (conflict) {
                conflicts.set(operation.id, conflict);
                if (operation.groupId)
                    poisonedGroups.add(operation.groupId);
            }
        }
    }
    for (const operation of plan.operations) {
        if (!approved.has(operation.id)) {
            results.push({
                operationId: operation.id,
                status: "skipped",
                detail: "Operation was not approved.",
            });
            continue;
        }
        const override = options.valueOverrides?.[operation.id];
        if (requiresHumanInput(operation.afterValue) && override === undefined) {
            results.push({
                operationId: operation.id,
                status: "skipped",
                detail: "Operation needs a concrete value; supply a value override.",
            });
            continue;
        }
        if (guardFailure) {
            results.push({
                operationId: operation.id,
                status: "conflict",
                detail: `${guardFailure} Detected mid-apply — this and all remaining operations were not applied.`,
            });
            continue;
        }
        const conflict = conflicts.get(operation.id);
        if (conflict) {
            results.push(conflict);
            continue;
        }
        if (staleByFilter && staleByFilter.has(operation.objectId)) {
            results.push({
                operationId: operation.id,
                status: "conflict",
                detail: `Record ${operation.objectType}/${operation.objectId} no longer matches the plan's filter [${plan.filter.where.join(" AND ")}] (changed mid-apply). Not applied — re-plan against current data.`,
            });
            if (operation.groupId)
                poisonedGroups.add(operation.groupId);
            continue;
        }
        if (operation.groupId && poisonedGroups.has(operation.groupId)) {
            results.push({
                operationId: operation.id,
                status: "skipped",
                detail: `Skipped: another operation in group ${operation.groupId} hit a conflict — the group applies all-or-nothing.`,
            });
            continue;
        }
        const resolved = override === undefined ? operation : { ...operation, afterValue: override };
        attempted += 1;
        try {
            const result = await connector.applyOperation(resolved);
            results.push(result);
            if (result.status === "applied") {
                applied += 1;
                appliedSinceRecheck += 1;
                // shrink the TOCTOU window: first write fires a re-check (a
                // concurrent editor reacting to our changes shows up immediately),
                // then re-check on a fixed cadence
                if (applied === 1 || appliedSinceRecheck >= recheckEvery) {
                    appliedSinceRecheck = 0;
                    await refreshSnapshotChecks();
                }
            }
        }
        catch (error) {
            results.push({
                operationId: operation.id,
                status: "failed",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return {
        planId: plan.id,
        provider: connector.provider,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: runStatus(attempted, applied),
        results,
    };
}
function runStatus(attempted, applied) {
    if (attempted === 0)
        return "rejected";
    if (applied === attempted)
        return "applied";
    if (applied > 0)
        return "partial";
    return "failed";
}

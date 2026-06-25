import { dedupeKey } from "./dedupe.js";
import { requiresHumanInput } from "./rules.js";
const IRREVERSIBLE_OPERATIONS = new Set(["merge_records", "archive_record"]);
const IDENTITY_KEY_BY_TYPE = {
    account: "domain",
    contact: "email",
};
/** snapshot collection for an object type */
function collectionFor(objectType) {
    if (objectType === "account")
        return "accounts";
    if (objectType === "contact")
        return "contacts";
    if (objectType === "deal")
        return "deals";
    return null;
}
/**
 * Drift/safety check for the two IRREVERSIBLE operations against a fresh
 * snapshot. Returns a conflict detail string, or null if the op is safe to
 * apply. These operations get NO field compare-and-set (there is no single
 * field to compare), so this snapshot check is their only guard.
 */
function checkIrreversibleOp(operation, snapshot) {
    const collection = collectionFor(operation.objectType);
    if (!collection)
        return null;
    const records = snapshot[collection];
    const byId = (id) => records.find((record) => String(record.id) === id);
    if (operation.operation === "archive_record") {
        if (!byId(operation.objectId)) {
            return `Record ${operation.objectType}/${operation.objectId} no longer exists (already archived or merged). Re-plan against current data.`;
        }
        // Archiving a duplicate discards data a merge would keep — refuse unless the
        // human explicitly forced it. This catches every archive_record path (agent,
        // hand-edited plan, audit), not just `bulk-update --archive`.
        if (!operation.forceArchiveDuplicate) {
            const keyName = IDENTITY_KEY_BY_TYPE[operation.objectType];
            if (keyName) {
                const target = byId(operation.objectId);
                const key = dedupeKey(target, keyName);
                if (key) {
                    const sharers = records.filter((record) => String(record.id) !== operation.objectId && dedupeKey(record, keyName) === key);
                    if (sharers.length > 0) {
                        return (`Refusing to archive ${operation.objectType}/${operation.objectId}: it shares ${keyName} "${key}" with ` +
                            `${sharers.length} other record(s) — that's a duplicate, and archiving discards its data where merging keeps it. ` +
                            `Merge with \`fullstackgtm dedupe ${operation.objectType} --key ${keyName}\` instead, or rebuild the op with --force-archive-duplicates.`);
                    }
                }
            }
        }
        return null;
    }
    if (operation.operation === "merge_records") {
        if (!byId(operation.objectId)) {
            return `Merge survivor ${operation.objectType}/${operation.objectId} no longer exists (archived or merged away since the plan was built). Re-plan — merges are irreversible.`;
        }
        const groupIds = Array.isArray(operation.beforeValue) ? operation.beforeValue.map(String) : [];
        const losersStillPresent = groupIds.filter((id) => id !== operation.objectId && byId(id));
        if (groupIds.length > 0 && losersStillPresent.length === 0) {
            return `Every record to merge into ${operation.objectType}/${operation.objectId} is already gone (merge already applied?). Nothing to do — re-plan if duplicates remain.`;
        }
        return null;
    }
    return null;
}
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
    // Irreversible ops (merge/archive) need a fresh snapshot too — it is their
    // only drift/safety guard (no field to compare-and-set). Respect a caller's
    // explicit checkConflicts:false opt-out (a stub/known-stale snapshot).
    const hasIrreversibleApproved = checkConflicts &&
        plan.operations.some((operation) => approved.has(operation.id) && IRREVERSIBLE_OPERATIONS.has(operation.operation));
    const needsSnapshot = ((plan.guards && plan.guards.length > 0) || plan.filter || hasIrreversibleApproved) &&
        connector.fetchSnapshot;
    const recheckEvery = Math.max(1, options.recheckEvery ?? 25);
    const staleIds = new Set();
    const irreversibleStale = new Map();
    let guardFailure = null;
    const refreshSnapshotChecks = async () => {
        if (!needsSnapshot)
            return;
        const { evaluateGuard, eligibleIds } = await import("./bulkUpdate.js");
        const liveSnapshot = await connector.fetchSnapshot();
        if (plan.filter) {
            // Resolve the comparison `today` literal to the date the plan was built
            // with (stored on plan.filter), so apply-time re-verification of a
            // `closeDate<today`-style filter agrees with plan time. eligibleIds
            // defaults to the system date when the plan predates comparison ops.
            const stillEligible = eligibleIds(liveSnapshot, plan.filter.objectType, plan.filter.where, plan.filter.today);
            staleIds.clear();
            for (const operation of plan.operations) {
                if (!stillEligible.has(operation.objectId))
                    staleIds.add(operation.objectId);
            }
        }
        irreversibleStale.clear();
        if (checkConflicts) {
            for (const operation of plan.operations) {
                if (!approved.has(operation.id) || !IRREVERSIBLE_OPERATIONS.has(operation.operation))
                    continue;
                const detail = checkIrreversibleOp(operation, liveSnapshot);
                if (detail)
                    irreversibleStale.set(operation.id, detail);
            }
        }
        for (const guard of plan.guards ?? []) {
            const failure = evaluateGuard(liveSnapshot, guard, plan.filter?.today);
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
    // Bulk fast-path: route independent, approved create_record CONTACT ops
    // through the connector's batch API (batched resolve-first read + batched
    // writes) instead of one round-trip per record. Only ops that are safe to
    // batch are eligible — every other op (grouped, needs an override, carries a
    // company association, conflicted, or any non-create op) stays on the serial
    // path below, so the safety contract is unchanged. Results are merged in by
    // id; the serial loop short-circuits anything already resolved here.
    const batched = new Map();
    if (connector.applyCreateContactsBatch && !guardFailure) {
        const eligible = plan.operations.filter((operation) => approved.has(operation.id) &&
            operation.operation === "create_record" &&
            operation.objectType === "contact" &&
            options.valueOverrides?.[operation.id] === undefined &&
            !requiresHumanInput(operation.afterValue) &&
            !operation.groupId &&
            !operation.afterValue?.associateCompanyName &&
            !conflicts.has(operation.id) &&
            !irreversibleStale.has(operation.id) &&
            !(staleByFilter && staleByFilter.has(operation.objectId)));
        // Only worth the batch machinery for more than a couple of creates.
        if (eligible.length > 2) {
            const batchResults = await connector.applyCreateContactsBatch(eligible);
            for (const result of batchResults)
                batched.set(result.operationId, result);
        }
    }
    for (const operation of plan.operations) {
        const batchedResult = batched.get(operation.id);
        if (batchedResult) {
            results.push(batchedResult);
            attempted += 1;
            if (batchedResult.status === "applied")
                applied += 1;
            continue;
        }
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
        const irreversibleConflict = irreversibleStale.get(operation.id);
        if (irreversibleConflict) {
            results.push({ operationId: operation.id, status: "conflict", detail: irreversibleConflict });
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

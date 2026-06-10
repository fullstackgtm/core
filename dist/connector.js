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
        if (checkConflicts &&
            connector.readField &&
            operation.field &&
            FIELD_WRITE_OPERATIONS.has(operation.operation)) {
            const current = await connector.readField(operation.objectType, operation.objectId, operation.field);
            const expected = normalizeForComparison(operation.beforeValue);
            const found = normalizeForComparison(current);
            if (expected !== found) {
                results.push({
                    operationId: operation.id,
                    status: "conflict",
                    detail: `Value drifted since the plan was proposed: expected ${expected ?? "∅"}, found ${found ?? "∅"}. Re-run the audit.`,
                    providerData: { currentValue: current ?? null },
                });
                continue;
            }
        }
        const resolved = override === undefined ? operation : { ...operation, afterValue: override };
        attempted += 1;
        try {
            const result = await connector.applyOperation(resolved);
            results.push(result);
            if (result.status === "applied")
                applied += 1;
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

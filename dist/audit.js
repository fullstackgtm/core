import { buildSnapshotIndex, builtinAuditRules, stableHash } from "./rules.js";
const DEFAULT_POLICY = {
    staleDealDays: 30,
    requireDealOwner: true,
    requireAccountForDeal: true,
};
/**
 * Wall clock for the plan's stdout-bound `createdAt`, honoring the
 * SOURCE_DATE_EPOCH reproducible-build convention (seconds since the Unix
 * epoch). When set, `audit --demo --json` is byte-deterministic across
 * re-runs — golden tests and CI diffs can pin the payload. Unset (normal
 * use) it is the real clock, exactly as before.
 */
function nowIso() {
    const epoch = process.env.SOURCE_DATE_EPOCH;
    if (epoch && /^\d+$/.test(epoch))
        return new Date(Number(epoch) * 1000).toISOString();
    return new Date().toISOString();
}
export function defaultPolicy(today = new Date().toISOString().slice(0, 10)) {
    return {
        ...DEFAULT_POLICY,
        today,
    };
}
/**
 * Run every rule over the snapshot and collect the results into a single
 * dry-run patch plan. Pass custom rules to extend or replace the built-ins.
 * `onRule` reports per-rule progress (presentation only — a throwing callback
 * never fails the audit).
 */
export function auditSnapshot(snapshot, policy = defaultPolicy(), rules = builtinAuditRules, onRule) {
    const context = { snapshot, policy, index: buildSnapshotIndex(snapshot) };
    const findings = [];
    const operations = [];
    for (const rule of rules) {
        try {
            onRule?.(rule.id, "start");
        }
        catch {
            // progress is presentation-only
        }
        const result = rule.evaluate(context);
        findings.push(...result.findings);
        operations.push(...result.operations);
        try {
            onRule?.(rule.id, "done", result.findings.length);
        }
        catch {
            // progress is presentation-only
        }
    }
    const evidence = buildEvidence(snapshot, findings, policy.today);
    const pipelineFindings = buildPipelineFindings(findings, operations, evidence, policy.today);
    linkOperationContext(operations, findings, evidence);
    return {
        id: `patch_plan_${stableHash(`${snapshot.provider}:${snapshot.generatedAt}:${findings.length}:${operations.length}`)}`,
        title: "GTM hygiene audit patch plan",
        createdAt: nowIso(),
        status: operations.length > 0 ? "needs_approval" : "draft",
        dryRun: true,
        summary: `${findings.length} findings and ${operations.length} proposed dry-run operations.`,
        findings,
        pipelineFindings,
        evidence,
        operations,
    };
}
function daysBetween(start, end) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
        return 0;
    return Math.floor((endMs - startMs) / 86_400_000);
}
function buildEvidence(snapshot, findings, today) {
    const recordsByKey = buildRecordIndex(snapshot);
    return findings.map((finding) => {
        const source = recordsByKey.get(`${finding.objectType}:${finding.objectId}`);
        const provider = source && "provider" in source && typeof source.provider === "string"
            ? source.provider
            : snapshot.provider;
        const lastSyncAt = source && "lastSyncAt" in source && typeof source.lastSyncAt === "string"
            ? source.lastSyncAt
            : undefined;
        const lastActivityAt = source && "lastActivityAt" in source && typeof source.lastActivityAt === "string"
            ? source.lastActivityAt
            : undefined;
        const sourceObjectId = source && "crmId" in source && typeof source.crmId === "string"
            ? source.crmId
            : finding.objectId;
        return {
            id: evidenceId(finding.ruleId, finding.objectId),
            sourceSystem: sourceSystem(provider),
            sourceObjectType: finding.objectType,
            sourceObjectId,
            objectType: finding.objectType,
            objectId: finding.objectId,
            title: finding.title,
            text: evidenceText(finding, source),
            observedAt: lastActivityAt ?? lastSyncAt,
            capturedAt: snapshot.generatedAt,
            freshness: freshness(lastSyncAt ?? lastActivityAt, today),
            metadata: {
                ruleId: finding.ruleId,
                generatedAt: snapshot.generatedAt,
            },
        };
    });
}
function buildPipelineFindings(findings, operations, evidence, today) {
    const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    return findings
        .map((finding) => {
        const type = finding.type ?? findingType(finding.ruleId);
        if (!type)
            return null;
        const operation = operationsById.get(operationIdFromFindingId(finding.id));
        const evidenceItem = evidenceById.get(evidenceIdFromFindingId(finding.id));
        const evidenceIds = evidenceItem ? [evidenceItem.id] : [];
        return {
            id: finding.id,
            type,
            objectType: finding.objectType,
            objectId: finding.objectId,
            severity: finding.severity,
            status: operation ? "planned" : "open",
            title: finding.title,
            summary: finding.summary,
            recommendation: finding.recommendation,
            evidenceIds,
            currentCrmValue: finding.currentCrmValue ?? operation?.beforeValue,
            proposedValue: finding.proposedValue ?? operation?.afterValue,
            freshness: finding.freshness ?? evidenceItem?.freshness ?? freshness(undefined, today),
            patchEligibility: {
                eligible: Boolean(operation),
                operation: operation?.operation ?? "none",
                field: operation?.field,
                reason: operation
                    ? "A typed patch operation can be reviewed before writeback."
                    : "No supported patch operation exists yet.",
                approvalRequired: operation?.approvalRequired ?? true,
            },
        };
    })
        .filter((finding) => finding !== null);
}
function linkOperationContext(operations, findings, evidence) {
    const findingIdsByOperationId = new Map();
    for (const finding of findings) {
        const operationIdForFinding = operationIdFromFindingId(finding.id);
        const ids = findingIdsByOperationId.get(operationIdForFinding) ?? [];
        ids.push(finding.id);
        findingIdsByOperationId.set(operationIdForFinding, ids);
    }
    const evidenceIdSet = new Set(evidence.map((item) => item.id));
    for (const operation of operations) {
        operation.findingIds = findingIdsByOperationId.get(operation.id) ?? [];
        operation.evidenceIds = operation.findingIds
            .map((findingId) => evidenceIdFromFindingId(findingId))
            .filter((id) => evidenceIdSet.has(id));
        operation.verification = {
            status: "not_started",
            expectedValue: operation.afterValue,
            auditText: "Dry-run audit only; verification starts after an approved provider/local write.",
        };
    }
}
function operationIdFromFindingId(findingId) {
    return findingId.replace(/^finding_/, "op_");
}
function evidenceIdFromFindingId(findingId) {
    return findingId.replace(/^finding_/, "ev_");
}
function buildRecordIndex(snapshot) {
    const recordsByKey = new Map();
    for (const row of snapshot.accounts)
        recordsByKey.set(`account:${row.id}`, row);
    for (const row of snapshot.contacts)
        recordsByKey.set(`contact:${row.id}`, row);
    for (const row of snapshot.deals)
        recordsByKey.set(`deal:${row.id}`, row);
    for (const row of snapshot.users)
        recordsByKey.set(`user:${row.id}`, row);
    for (const row of snapshot.activities)
        recordsByKey.set(`activity:${row.id}`, row);
    return recordsByKey;
}
function evidenceText(finding, source) {
    const name = source && typeof source === "object" && "name" in source ? String(source.name) : finding.objectId;
    return `${finding.ruleId}: ${name}. ${finding.summary}`;
}
function sourceSystem(value) {
    if (value === "salesforce" ||
        value === "hubspot" ||
        value === "gong" ||
        value === "chorus" ||
        value === "fathom" ||
        value === "manual" ||
        value === "csv" ||
        value === "mock") {
        return value;
    }
    return "unknown";
}
function freshness(sourceUpdatedAt, today) {
    const ageDays = sourceUpdatedAt ? daysBetween(sourceUpdatedAt, today) : undefined;
    return {
        state: ageDays === undefined ? "unknown" : ageDays > 30 ? "stale" : "fresh",
        checkedAt: today,
        sourceUpdatedAt,
        ageDays,
    };
}
function findingType(ruleId) {
    if (ruleId === "missing-deal-owner")
        return "deal_missing_owner";
    if (ruleId === "missing-deal-account")
        return "deal_missing_account";
    if (ruleId === "past-close-date")
        return "deal_past_close_date";
    if (ruleId === "stale-deal")
        return "deal_stale_activity";
    return undefined;
}
function evidenceId(ruleId, objectId) {
    return `ev_${stableHash(`${ruleId}:${objectId}`)}`;
}

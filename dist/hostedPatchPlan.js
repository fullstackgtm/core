/** Broker-authenticated mirror for locally governed patch plans. */
import { createHash } from "node:crypto";
import { getCredential } from "./credentials.js";
const ENDPOINT = "/api/cli/patch-plan";
const TIMEOUT_MS = 5000;
function broker() {
    const value = getCredential("broker");
    if (!value?.baseUrl || !value.accessToken)
        return null;
    try {
        const url = new URL(value.baseUrl);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
            return null;
        return { baseUrl: url.href.replace(/\/+$/, ""), token: value.accessToken };
    }
    catch {
        return null;
    }
}
/** Review document intentionally omits evidence/findings and all mutable store security state. */
export function hostedReviewDocument(plan) {
    return {
        id: plan.id,
        title: plan.title,
        createdAt: plan.createdAt,
        status: "needs_approval",
        dryRun: true,
        summary: plan.summary,
        operations: plan.operations,
        ...(plan.filter ? { filter: plan.filter } : {}),
        ...(plan.guards ? { guards: plan.guards } : {}),
    };
}
export function hostedPlanDigest(plan) {
    return createHash("sha256").update(JSON.stringify(hostedReviewDocument(plan))).digest("hex");
}
function mapOperation(op) {
    return {
        packageOpId: op.id,
        objectType: op.objectType,
        ...(op.objectId ? { objectId: op.objectId } : {}),
        fieldOrAction: op.field ?? op.operation,
        beforeValue: op.beforeValue ?? null,
        afterValue: op.afterValue ?? null,
        ...(op.reason ? { reason: op.reason } : {}),
        ...(op.sourceRuleOrPolicy ? { sourceRuleOrPolicy: op.sourceRuleOrPolicy } : {}),
        riskLevel: op.riskLevel,
        approvalRequired: op.approvalRequired,
        ...(op.rollback ? { rollback: op.rollback } : {}),
    };
}
function parseState(value, baseUrl) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    const id = typeof row.patchPlanId === "string" ? row.patchPlanId : null;
    if (!id)
        return null;
    const approvedOperationIds = Array.isArray(row.approvedOperationIds) ? row.approvedOperationIds.filter((id) => typeof id === "string") : [];
    const runRecord = parseRunRecord(row.runRecord, row.operationReceipts, row.externalPlanId, row.updatedAt);
    return {
        patchPlanId: id,
        externalPlanId: typeof row.externalPlanId === "string" ? row.externalPlanId : "",
        documentSha256: typeof row.documentSha256 === "string" ? row.documentSha256 : "",
        status: typeof row.status === "string" ? row.status : "pending_approval",
        approvedOperationIds,
        valueOverrides: row.valueOverrides && typeof row.valueOverrides === "object" && !Array.isArray(row.valueOverrides) ? row.valueOverrides : {},
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
        ...(runRecord ? { runRecord } : {}),
        url: `${baseUrl}/dashboard/patch-plans?plan=${encodeURIComponent(id)}`,
    };
}
function parseRunRecord(value, receiptsValue, externalPlanId, updatedAt) {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    const planId = typeof row?.planId === "string" ? row.planId : typeof externalPlanId === "string" ? externalPlanId : undefined;
    if (!planId)
        return undefined;
    const rawResults = Array.isArray(row?.results) ? row.results : Array.isArray(receiptsValue) ? receiptsValue : [];
    const results = rawResults.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const receipt = entry;
        const operationId = typeof receipt.operationId === "string" ? receipt.operationId : typeof receipt.packageOpId === "string" ? receipt.packageOpId : undefined;
        const rawStatus = receipt.status;
        const status = rawStatus === "applied" || rawStatus === "failed" || rawStatus === "skipped" || rawStatus === "conflict" ? rawStatus : undefined;
        if (!operationId || !status)
            return [];
        return [{ operationId, status, ...(typeof receipt.detail === "string" ? { detail: receipt.detail } : typeof receipt.error === "string" ? { detail: receipt.error } : {}), ...(receipt.providerData !== undefined ? { providerData: receipt.providerData } : {}) }];
    });
    if (results.length === 0)
        return undefined;
    const timestamp = typeof updatedAt === "number" ? new Date(updatedAt).toISOString() : new Date().toISOString();
    const provider = typeof row?.provider === "string" ? row.provider : "mock";
    const status = row?.status === "applied" || row?.status === "partial" || row?.status === "failed" || row?.status === "rejected"
        ? row.status : results.every((result) => result.status === "applied" || result.status === "skipped") ? "applied" : "partial";
    return {
        planId, provider,
        startedAt: typeof row?.startedAt === "string" ? row.startedAt : timestamp,
        finishedAt: typeof row?.finishedAt === "string" ? row.finishedAt : timestamp,
        status,
        results,
    };
}
function failure(status) {
    if (status === 409)
        return { status: "conflict", reason: "hosted mirror has different immutable content" };
    if (status === 401 || status === 403)
        return { status: "unavailable", reason: "hosted authentication was rejected; pair the CLI again" };
    return { status: "unavailable", reason: `hosted plan request failed (HTTP ${status})` };
}
export async function uploadHostedPatchPlan(stored, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    const document = hostedReviewDocument(stored.plan);
    const digest = hostedPlanDigest(stored.plan);
    const riskOrder = { low: 0, medium: 1, high: 2 };
    const riskLevel = stored.plan.operations.reduce((risk, op) => riskOrder[op.riskLevel] > riskOrder[risk] ? op.riskLevel : risk, "low");
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                externalPlanId: stored.plan.id, documentSha256: digest, externalRevision: stored.revision,
                title: stored.plan.title, summary: stored.plan.summary, riskLevel, document,
                operations: stored.plan.operations.map(mapOperation), createdAt: Date.parse(stored.plan.createdAt),
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok)
            return failure(response.status);
        const raw = await response.json();
        const state = parseState({ ...raw, externalPlanId: stored.plan.id, documentSha256: digest, approvedOperationIds: [], valueOverrides: {}, updatedAt: Date.now() }, paired.baseUrl);
        return state ? { status: "saved", state } : { status: "unavailable", reason: "hosted plan response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted plan request was unavailable" };
    }
}
export async function readHostedPatchPlan(planId, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}?externalPlanId=${encodeURIComponent(planId)}`, {
            headers: { Authorization: `Bearer ${paired.token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (response.status === 404)
            return { status: "missing" };
        if (!response.ok)
            return failure(response.status);
        const state = parseState(await response.json(), paired.baseUrl);
        return state ? { status: "found", state } : { status: "unavailable", reason: "hosted plan response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted plan request was unavailable" };
    }
}
/** Pull a peer's newer lifecycle into the local replica without weakening local integrity gates. */
export async function reconcileHostedPatchPlan(store, stored, options = {}) {
    const hosted = await readHostedPatchPlan(stored.plan.id, options);
    if (hosted.status === "unpaired" || hosted.status === "missing")
        return { status: hosted.status };
    if (hosted.status === "unavailable" || hosted.status === "conflict")
        return hosted;
    if (hosted.state.documentSha256 !== hostedPlanDigest(stored.plan)) {
        return { status: "conflict", reason: "hosted review content does not match the immutable local plan" };
    }
    if (!["approved", "rejected", "applied"].includes(hosted.state.status))
        return { status: "unchanged" };
    try {
        const reconciled = await store.reconcileReplica(stored.plan.id, {
            status: hosted.state.status,
            approvedOperationIds: hosted.state.approvedOperationIds,
            valueOverrides: hosted.state.valueOverrides,
            ...(hosted.state.runRecord ? { run: hosted.state.runRecord } : {}),
        });
        return reconciled.changed
            ? { status: "updated", stored: reconciled.stored, remoteStatus: hosted.state.status }
            : { status: "unchanged" };
    }
    catch (error) {
        return { status: "conflict", reason: error instanceof Error ? error.message : "replica reconciliation failed" };
    }
}
export async function reportHostedPlanLifecycle(stored, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    const status = stored.status === "applied" ? "applied" : stored.status === "rejected" ? "rejected" : "approved";
    const runRecord = status === "applied" ? stored.runs.at(-1) : undefined;
    // The hosted terminal transition is authority-bound to the exact approved
    // subset. Local runs also record excluded operations as `skipped` for a
    // complete human audit trail; those are not execution receipts and must not
    // be echoed as though they were authorized provider work.
    const approved = new Set(stored.approvedOperationIds);
    const operationReceipts = runRecord?.results.filter((result) => approved.has(result.operationId)).map((result) => ({
        packageOpId: result.operationId,
        status: result.status,
        ...(result.detail ? { error: result.detail.slice(0, 1000) } : {}),
        ...(result.providerData !== undefined ? { providerData: result.providerData } : {}),
        updatedAt: Date.parse(runRecord.finishedAt),
    }));
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST", headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "lifecycle", externalPlanId: stored.plan.id, documentSha256: hostedPlanDigest(stored.plan), status, approvedOperationIds: stored.approvedOperationIds, ...(options.claimId ? { claimId: options.claimId } : {}), ...(runRecord ? { runRecord, operationReceipts } : {}) }),
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok)
            return failure(response.status);
        const raw = await response.json();
        const state = parseState({ ...raw, externalPlanId: stored.plan.id, documentSha256: hostedPlanDigest(stored.plan), approvedOperationIds: stored.approvedOperationIds, valueOverrides: stored.valueOverrides, updatedAt: Date.now() }, paired.baseUrl);
        return state ? { status: "saved", state } : { status: "unavailable", reason: "hosted lifecycle response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted lifecycle request was unavailable" };
    }
}
/** Coordinate online replicas before provider I/O; provider idempotency remains the offline fallback. */
export async function claimHostedPlanApply(stored, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST", headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "claim", externalPlanId: stored.plan.id, documentSha256: hostedPlanDigest(stored.plan) }),
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok)
            return failure(response.status);
        const row = await response.json();
        if (row.alreadyApplied === true || row.status === "applied")
            return { status: "applied" };
        if (row.status === "claimed" && typeof row.claimId === "string") {
            return { status: "claimed", claimId: row.claimId, ...(typeof row.expiresAt === "number" ? { expiresAt: row.expiresAt } : {}) };
        }
        return { status: "unavailable", reason: "hosted apply claim response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted apply claim request was unavailable" };
    }
}
/** Release a shared CLI claim only when preflight aborts before provider I/O. */
export async function releaseHostedPlanApply(stored, claimId, reason, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "release_claim",
                externalPlanId: stored.plan.id,
                documentSha256: hostedPlanDigest(stored.plan),
                claimId,
                reason,
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok)
            return failure(response.status);
        const row = await response.json();
        return row.released === true
            ? { status: "released" }
            : { status: "unavailable", reason: "hosted apply claim release response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted apply claim release was unavailable" };
    }
}

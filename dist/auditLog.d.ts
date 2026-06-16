import type { PatchPlanRun } from "./types.ts";
import type { StoredPlan } from "./planStore.ts";
/**
 * Exportable, tamper-evident audit log.
 *
 * Every apply run is already recorded per-plan in the store, but a compliance /
 * change-management process needs ONE portable artifact it can archive and
 * later prove was not edited. `audit-log export` flattens every run across all
 * plans into a hash-chained sequence: each entry carries the hash of the
 * previous entry, so removing, reordering, or editing any entry breaks the
 * chain at that point and `audit-log verify` reports exactly where. When a
 * per-install signing key exists, the chain head is also HMAC-signed, so the
 * export can be attributed to this installation, not just shown internally
 * consistent.
 *
 * This is a point-in-time attestation of the stored run history; it is not a
 * real-time append-only journal (that is future work). It answers "give me an
 * auditable record of every change this tool applied, that my auditor can
 * verify hasn't been doctored."
 */
export type AuditLogEntry = {
    seq: number;
    planId: string;
    planTitle: string;
    provider: string;
    startedAt: string;
    finishedAt: string;
    status: PatchPlanRun["status"];
    trigger: string;
    /** operationId → status, the per-operation outcome of this run */
    operations: Array<{
        operationId: string;
        status: string;
        detail?: string;
    }>;
    prevHash: string;
    hash: string;
};
export type AuditLogExport = {
    version: 1;
    generatedAt: string;
    entryCount: number;
    chainHead: string;
    /** HMAC of chainHead with the per-install key, or null when no key exists. */
    signature: string | null;
    entries: AuditLogEntry[];
};
/** Flatten all runs from the stored plans, oldest first, into chained entries. */
export declare function buildAuditLog(plans: StoredPlan[], generatedAt: string): AuditLogExport;
export type AuditLogVerification = {
    ok: boolean;
    /** seq of the first entry whose hash does not verify, or null if the chain holds */
    brokenAt: number | null;
    signatureOk: boolean | null;
    detail: string;
};
/** Recompute the chain (and the signature if a key is available). */
export declare function verifyAuditLog(log: AuditLogExport): AuditLogVerification;

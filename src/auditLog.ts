import { createHash, createHmac } from "node:crypto";
import { loadOrCreateSigningKey, loadSigningKey } from "./integrity.ts";
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
  operations: Array<{ operationId: string; status: string; detail?: string }>;
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

const GENESIS = "0".repeat(64);

/** The content that the chain hash covers — everything but prevHash/hash. */
function entryContent(entry: Omit<AuditLogEntry, "prevHash" | "hash">): string {
  return JSON.stringify([
    entry.seq,
    entry.planId,
    entry.planTitle,
    entry.provider,
    entry.startedAt,
    entry.finishedAt,
    entry.status,
    entry.trigger,
    entry.operations,
  ]);
}

function chainHash(prevHash: string, content: string): string {
  return createHash("sha256").update(prevHash).update("\n").update(content).digest("hex");
}

/** Flatten all runs from the stored plans, oldest first, into chained entries. */
export function buildAuditLog(plans: StoredPlan[], generatedAt: string): AuditLogExport {
  const runs: Array<{ stored: StoredPlan; run: PatchPlanRun }> = [];
  for (const stored of plans) {
    for (const run of stored.runs ?? []) runs.push({ stored, run });
  }
  runs.sort((a, b) => a.run.finishedAt.localeCompare(b.run.finishedAt));

  const entries: AuditLogEntry[] = [];
  let prevHash = GENESIS;
  runs.forEach(({ stored, run }, index) => {
    const base = {
      seq: index,
      planId: run.planId,
      planTitle: stored.plan.title,
      provider: run.provider,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      trigger: (run as { trigger?: string }).trigger ?? "manual",
      operations: run.results.map((result) => ({
        operationId: result.operationId,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      })),
    };
    const hash = chainHash(prevHash, entryContent(base));
    entries.push({ ...base, prevHash, hash });
    prevHash = hash;
  });

  // Always sign — an unsigned export's keyless sha256 chain is self-recomputable
  // (an attacker can edit entries and rebuild the chain from the public genesis),
  // so the per-install HMAC is the only real tamper barrier. Bind the header
  // fields into the signed material so metadata can't be altered either.
  const key = loadOrCreateSigningKey();
  const entryCount = entries.length;
  return {
    version: 1,
    generatedAt,
    entryCount,
    chainHead: prevHash,
    signature: signHead(key, 1, generatedAt, entryCount, prevHash),
    entries,
  };
}

function signHead(key: Buffer, version: number, generatedAt: string, entryCount: number, chainHead: string): string {
  return createHmac("sha256", key).update(JSON.stringify([version, generatedAt, entryCount, chainHead])).digest("hex");
}

export type AuditLogVerification = {
  ok: boolean;
  /** seq of the first entry whose hash does not verify, or null if the chain holds */
  brokenAt: number | null;
  signatureOk: boolean | null; // null = no signature present / no key to check
  detail: string;
};

/** Recompute the chain (and the signature if a key is available). */
export function verifyAuditLog(log: AuditLogExport): AuditLogVerification {
  let prevHash = GENESIS;
  for (const entry of log.entries) {
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenAt: entry.seq, signatureOk: null, detail: `Chain breaks at entry ${entry.seq}: prevHash does not match the previous entry's hash (an entry was removed, reordered, or edited).` };
    }
    const expected = chainHash(prevHash, entryContent(entry));
    if (expected !== entry.hash) {
      return { ok: false, brokenAt: entry.seq, signatureOk: null, detail: `Chain breaks at entry ${entry.seq}: its content was edited after export (hash mismatch).` };
    }
    prevHash = entry.hash;
  }
  if (prevHash !== log.chainHead) {
    return { ok: false, brokenAt: log.entries.length, signatureOk: null, detail: "The recorded chainHead does not match the recomputed chain." };
  }
  // The keyless chain alone is self-recomputable, so a missing/stripped signature
  // means the export is forgeable — refuse it. (Current exports are always
  // signed; a null signature is an old/unsigned or a downgraded export.)
  if (!log.signature) {
    return {
      ok: false,
      brokenAt: null,
      signatureOk: false,
      detail: "Unsigned export: the hash chain alone is self-recomputable, so this log cannot be trusted (the signature is absent or was stripped). Re-export on the issuing install.",
    };
  }
  const key = loadSigningKey();
  if (!key) {
    // A third party without the issuing install's key cannot verify attribution.
    // The chain is internally consistent, but that is not proof of authenticity.
    return {
      ok: false,
      brokenAt: null,
      signatureOk: null,
      detail: "Chain is internally consistent, but this machine has no signing key to verify the signature — authenticity is unattributed. Verify on the issuing install.",
    };
  }
  const signatureOk = signHead(key, log.version, log.generatedAt, log.entryCount, prevHash) === log.signature;
  if (!signatureOk) {
    return { ok: false, brokenAt: null, signatureOk: false, detail: "Signature does not match this installation's key — the log was exported elsewhere, or its entries/metadata were altered after signing." };
  }
  return { ok: true, brokenAt: null, signatureOk: true, detail: `Verified ${log.entries.length} entries; chain intact and signature valid.` };
}

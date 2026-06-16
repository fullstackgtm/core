import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.js";
/**
 * Approval integrity.
 *
 * The plan store records WHICH operation ids a human approved, but the apply
 * path re-reads the operation BODIES fresh from the (user-editable) plan file.
 * Nothing bound the approval to the content: an approved op's afterValue or
 * objectId could be changed on disk between `plans approve` and `apply` — by a
 * compromised dependency, a co-tenant, or a plan file synced/edited on another
 * machine — and the changed value would be written under the prior approval.
 *
 * Fix: at approval time, HMAC-sign each approved operation's security-relevant
 * content (including the approved value override) with a per-install secret key
 * stored 0600 alongside the credentials. At apply time, recompute and verify.
 * Any post-approval edit to the operations or the approved overrides changes the
 * signature; a tamper must now also forge an HMAC it cannot compute without the
 * key. The key never leaves the machine, so a plan approved here and applied
 * elsewhere fails closed ("re-approve on this machine") rather than open.
 *
 * This raises the bar from "trust the plan JSON" to "trust the plan JSON only
 * insofar as it still matches what was signed with the local key." It is not a
 * defense against an attacker who already holds the signing key (same-dir, same
 * permissions as the credential store) — that is the documented boundary.
 */
const SIGNING_KEY_FILE = ".plan-signing-key";
function signingKeyPath() {
    return join(credentialsDir(), SIGNING_KEY_FILE);
}
/** Read the signing key, or null if it has not been created yet. */
export function loadSigningKey() {
    const path = signingKeyPath();
    if (!existsSync(path))
        return null;
    try {
        return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    }
    catch {
        return null;
    }
}
/** Read the signing key, creating a fresh 32-byte one (0600) on first use. */
export function loadOrCreateSigningKey() {
    const existing = loadSigningKey();
    if (existing && existing.length >= 32)
        return existing;
    ensureSecureHomeDir();
    const key = randomBytes(32);
    writeSecureFile(signingKeyPath(), `${key.toString("hex")}\n`);
    return key;
}
/**
 * Canonical, stable string of the operation content an approval binds to. Only
 * the fields that determine WHAT gets written: changing any of them must
 * invalidate the approval. `override` is the approved value override for this op
 * (the value actually written when set), so tampering with stored overrides is
 * caught too.
 */
function canonicalApprovalContent(operation, override) {
    return JSON.stringify([
        operation.id,
        operation.operation,
        operation.objectType,
        operation.objectId,
        operation.field ?? null,
        operation.beforeValue ?? null,
        operation.afterValue ?? null,
        operation.groupId ?? null,
        // Safety-relevant fields too: editing a precondition could relax a drift
        // guard, and forging forceArchiveDuplicate could suppress the archive-of-
        // duplicate refusal — the signed approval must pin apply BEHAVIOR, not just
        // the written value. `reason` is human-reviewed AND written verbatim into
        // create_task bodies (afterValue ?? reason fallback in the connectors), so a
        // create_task with a null afterValue would otherwise let a disk edit to
        // reason write unapproved text under a still-valid digest.
        operation.preconditions ?? null,
        operation.forceArchiveDuplicate ?? false,
        operation.reason ?? null,
        override === undefined ? null : ["__override__", override],
    ]);
}
/** HMAC-SHA256 signature of one operation's approved content. */
export function signApproval(operation, override, key) {
    return createHmac("sha256", key).update(canonicalApprovalContent(operation, override)).digest("hex");
}
/**
 * Compute the approval signature map for a set of approved operation ids,
 * resolving each op from the plan and its (approved) value override.
 */
export function computeApprovalDigests(operations, approvedOperationIds, valueOverrides, key) {
    const byId = new Map(operations.map((operation) => [operation.id, operation]));
    const digests = {};
    for (const id of approvedOperationIds) {
        const operation = byId.get(id);
        if (!operation)
            continue;
        digests[id] = signApproval(operation, valueOverrides[id], key);
    }
    return digests;
}
/**
 * Verify that every approved operation still matches what was signed. Returns
 * ok:true when there are no stored digests (a pre-integrity plan — nothing to
 * verify), when all match, or fails with the list of operation ids whose
 * content changed since approval.
 */
export function verifyApprovalDigests(operations, approvedOperationIds, valueOverrides, storedDigests) {
    if (!storedDigests || Object.keys(storedDigests).length === 0)
        return { ok: true };
    const key = loadSigningKey();
    if (!key)
        return { ok: false, reason: "no_key", tampered: approvedOperationIds };
    const byId = new Map(operations.map((operation) => [operation.id, operation]));
    const tampered = [];
    for (const id of approvedOperationIds) {
        const operation = byId.get(id);
        const expected = storedDigests[id];
        if (!operation || !expected) {
            tampered.push(id);
            continue;
        }
        if (signApproval(operation, valueOverrides[id], key) !== expected)
            tampered.push(id);
    }
    return tampered.length === 0 ? { ok: true } : { ok: false, reason: "mismatch", tampered };
}

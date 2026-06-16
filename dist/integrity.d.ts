import type { PatchOperation } from "./types.ts";
/** Read the signing key, or null if it has not been created yet. */
export declare function loadSigningKey(): Buffer | null;
/** Read the signing key, creating a fresh 32-byte one (0600) on first use. */
export declare function loadOrCreateSigningKey(): Buffer;
/** HMAC-SHA256 signature of one operation's approved content. */
export declare function signApproval(operation: PatchOperation, override: unknown, key: Buffer): string;
/**
 * Compute the approval signature map for a set of approved operation ids,
 * resolving each op from the plan and its (approved) value override.
 */
export declare function computeApprovalDigests(operations: PatchOperation[], approvedOperationIds: string[], valueOverrides: Record<string, unknown>, key: Buffer): Record<string, string>;
export type ApprovalVerification = {
    ok: true;
} | {
    ok: false;
    reason: "no_key";
    tampered: string[];
} | {
    ok: false;
    reason: "mismatch";
    tampered: string[];
};
/**
 * Verify that every approved operation still matches what was signed. Returns
 * ok:true when there are no stored digests (a pre-integrity plan — nothing to
 * verify), when all match, or fails with the list of operation ids whose
 * content changed since approval.
 */
export declare function verifyApprovalDigests(operations: PatchOperation[], approvedOperationIds: string[], valueOverrides: Record<string, unknown>, storedDigests: Record<string, string> | undefined): ApprovalVerification;

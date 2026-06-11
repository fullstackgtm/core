import type { CanonicalGtmSnapshot } from "./types.ts";
/**
 * The resolve gate — the Prevent layer of the CRM-health lifecycle.
 *
 * Before any writer (sync job, webhook handler, agent, this CLI's own
 * `create:` path) creates a record, it should ask: does this record already
 * exist? The gate answers deterministically from a snapshot using the same
 * identity keys the audit and merge engines use:
 *
 *   account → normalized domain (exact), then normalized name
 *   contact → normalized email (exact), then full name
 *   deal    → open-deal key: (accountId | "unlinked") + normalized name
 *
 * Verdicts are gate-shaped: `exists` (link to it, don't create),
 * `ambiguous` (a human must pick — do NOT blind-create), `safe_to_create`.
 */
export type ResolveCandidate = {
    objectType: "account" | "contact" | "deal";
    name?: string;
    domain?: string;
    email?: string;
    /** For deals: scope the duplicate key to an account. */
    accountId?: string;
};
export type ResolveMatch = {
    id: string;
    name: string;
    matchedBy: "domain" | "email" | "name" | "deal_key";
    detail: string;
};
export type ResolveResult = {
    objectType: ResolveCandidate["objectType"];
    verdict: "exists" | "ambiguous" | "safe_to_create";
    matches: ResolveMatch[];
    reason: string;
};
export declare function resolveRecord(snapshot: CanonicalGtmSnapshot, candidate: ResolveCandidate): ResolveResult;

import { type AssignmentPolicy } from "./assign.ts";
import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
/**
 * Lead-to-account matching and routing recipes.
 *
 * This is the first packaged Traction-Complete-style workflow in the OSS CLI:
 * take ownerless/unmatched leads, deterministically match them to accounts, and
 * emit normal approval-gated patch operations. No writes happen here.
 */
export type LeadRouteOptions = {
    /** Match contact email domains to account domains. Default true. */
    matchByDomain?: boolean;
    /** Also try raw company/name fields against account names when domain misses. */
    matchByCompanyName?: boolean;
    /** When an ownerless contact matches an owned account, set contact ownerId to the account owner. Default true. */
    inheritAccountOwner?: boolean;
    /** Reassign contacts that already have an owner when the matched account owner differs. Default false. */
    reassignExistingOwner?: boolean;
    /** Optional fallback policy for contacts that still do not have an owner. */
    assignmentPolicy?: AssignmentPolicy;
    /** Refuse to build larger plans unless explicitly raised. Default 500. */
    maxOperations?: number;
    reason?: string;
};
export type LeadRouteCounts = {
    contactsScanned: number;
    /** Contacts that ended with an unambiguous account context (existing link, domain match, or company-name match). */
    matchedContacts: number;
    matchedExistingAccount: number;
    matchedByDomain: number;
    matchedByCompanyName: number;
    ambiguousAccountMatches: number;
    skippedFreeEmail: number;
    linkOperations: number;
    /** Owner set_field operations proposed (account-owner inheritance + policy fallback). */
    ownerOperations: number;
    /** Alias for ownerOperations, named for reports that talk about owner-assigned leads. */
    ownerAssigned: number;
    policyAssigned: number;
    unmatched: number;
};
export type LeadRouteResult = {
    plan: PatchPlan;
    counts: LeadRouteCounts;
};
export declare function buildLeadRoutePlan(snapshot: CanonicalGtmSnapshot, options?: LeadRouteOptions): LeadRouteResult;

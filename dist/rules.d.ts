import type { CanonicalGtmSnapshot, GtmAuditRule, GtmSnapshotIndex } from "./types.ts";
/**
 * Placeholder used as `afterValue` when the right value is a human decision
 * (e.g. which owner to assign). Apply orchestration refuses to write these
 * unless an explicit override value is supplied at approval time.
 */
export declare const REQUIRES_HUMAN_PREFIX = "requires_human_";
export declare function requiresHumanInput(value: unknown): boolean;
/**
 * Attribution for duplicate groups: when the provider exposes record-source
 * provenance (RecordProvenance), name the writer(s) that created the group —
 * the fix for recurring dupes is upstream in the writer, not in the records.
 */
export declare function provenanceSummary(records: Array<{
    provenance?: {
        source?: string;
        sourceLabel?: string;
        sourceId?: string;
    };
}>): string;
export declare function auditFindingId(ruleId: string, objectId: string): string;
export declare function patchOperationId(ruleId: string, objectId: string): string;
export declare function stableHash(value: string): string;
export declare function buildSnapshotIndex(snapshot: CanonicalGtmSnapshot): GtmSnapshotIndex;
export declare const orphanAccountRule: GtmAuditRule;
export declare const missingDealOwnerRule: GtmAuditRule;
export declare const missingDealAccountRule: GtmAuditRule;
export declare const pastCloseDateRule: GtmAuditRule;
export declare const staleDealRule: GtmAuditRule;
export declare const missingDealAmountRule: GtmAuditRule;
export declare const duplicateAccountDomainRule: GtmAuditRule;
export declare const duplicateContactEmailRule: GtmAuditRule;
export declare const duplicateOpenDealRule: GtmAuditRule;
export declare const activeDealAccountWithoutContactsRule: GtmAuditRule;
export declare const closingSoonInactiveRule: GtmAuditRule;
export declare const accountSingleSourceRule: GtmAuditRule;
export declare const builtinAuditRules: GtmAuditRule[];

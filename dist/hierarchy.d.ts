import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
export type AccountHierarchyNode = {
    accountId: string;
    name: string;
    domain?: string;
    parentAccountId?: string;
    parentReason?: string;
    children: AccountHierarchyNode[];
};
export type AccountHierarchyConflict = {
    type: "duplicate_domain" | "related_shared_domain" | "ambiguous_parent" | "cycle";
    accountIds: string[];
    key: string;
    detail: string;
};
export type AccountHierarchyReport = {
    generatedAt: string;
    roots: AccountHierarchyNode[];
    orphanAccounts: string[];
    conflicts: AccountHierarchyConflict[];
    counts: {
        accounts: number;
        roots: number;
        linkedChildren: number;
        conflicts: number;
    };
};
export declare function buildAccountHierarchy(snapshot: CanonicalGtmSnapshot): AccountHierarchyReport;
export type ParentLinkPlanOptions = {
    childAccountId: string;
    parentAccountId: string;
    reason?: string;
};
/** Build one governed parent-link proposal. Existing different parents are
 * intentionally refused: re-parenting needs a separate operation that can
 * preserve provider-specific association labels. */
export declare function buildParentLinkPlan(snapshot: CanonicalGtmSnapshot, options: ParentLinkPlanOptions): PatchPlan;
export declare function accountHierarchyToMarkdown(report: AccountHierarchyReport): string;

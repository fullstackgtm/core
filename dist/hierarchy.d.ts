import type { CanonicalGtmSnapshot } from "./types.ts";
export type AccountHierarchyNode = {
    accountId: string;
    name: string;
    domain?: string;
    parentAccountId?: string;
    parentReason?: string;
    children: AccountHierarchyNode[];
};
export type AccountHierarchyConflict = {
    type: "duplicate_domain" | "ambiguous_parent" | "cycle";
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
export declare function accountHierarchyToMarkdown(report: AccountHierarchyReport): string;

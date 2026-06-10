import type { AuditFinding, CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
export type FieldChange = {
    field: string;
    before: unknown;
    after: unknown;
};
export type RecordChange = {
    id: string;
    label: string;
    changes: FieldChange[];
};
export type CollectionDiff = {
    added: Array<{
        id: string;
        label: string;
    }>;
    removed: Array<{
        id: string;
        label: string;
    }>;
    changed: RecordChange[];
};
export type SnapshotDiff = {
    before: {
        provider: string;
        generatedAt: string;
    };
    after: {
        provider: string;
        generatedAt: string;
    };
    users: CollectionDiff;
    accounts: CollectionDiff;
    contacts: CollectionDiff;
    deals: CollectionDiff;
    activities: CollectionDiff;
};
export declare function diffSnapshots(before: CanonicalGtmSnapshot, after: CanonicalGtmSnapshot): SnapshotDiff;
export type FindingsDrift = {
    newFindings: AuditFinding[];
    resolvedFindings: AuditFinding[];
    persistingCount: number;
};
/** Hygiene drift between two plans, keyed on stable finding ids. */
export declare function diffFindings(before: PatchPlan, after: PatchPlan): FindingsDrift;
export declare function diffToMarkdown(diff: SnapshotDiff, drift?: FindingsDrift): string;

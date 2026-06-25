/**
 * Canonical GTM data model.
 *
 * Amounts are expressed in major currency units (e.g. dollars), matching what
 * CRM providers return natively. Adapters that store minor units (cents) must
 * convert at their own boundary.
 */
export type CrmProvider = "salesforce" | "hubspot" | "mock" | "unknown" | (string & {});
export type RiskLevel = "low" | "medium" | "high";
export type ApprovalStatus = "draft" | "needs_approval" | "approved" | "rejected" | "applied";
export type GtmObjectType = "account" | "contact" | "deal" | "user" | "activity";
export type GtmEvidenceSourceSystem = "salesforce" | "hubspot" | "gong" | "chorus" | "fathom" | "manual" | "csv" | "mock" | "web" | "unknown";
export type PatchOperationType = "set_field" | "clear_field" | "link_record" | "archive_record" | "create_task" | "create_record" | "merge_records";
/**
 * The afterValue of a `create_record` operation. The connector re-resolves on
 * `matchKey`/`matchValue` at apply time and creates only on a confirmed miss.
 * `estCostUsd` is the acquire meter's per-record charge, recorded against the
 * budget on a successful create.
 */
export type CreateRecordPayload = {
    properties: Record<string, string>;
    matchKey: string;
    matchValue: string;
    source: string;
    estCostUsd?: number;
    associateCompanyName?: string;
    /**
     * The company's domain, when known. The connector resolves the account by
     * DOMAIN first (the accurate key), creates it with the domain, and fills the
     * domain on an existing account that lacks one — so the lead's account is a
     * real, signal-watchable record (`signals`/`icp judge` key on account domain).
     */
    associateCompanyDomain?: string;
    /**
     * Owner to stamp on the new record (canonical owner id). The connector maps
     * it to the CRM's owner property (HubSpot `hubspot_owner_id`) at create time
     * so a lead is never born ownerless. Absent = leave unassigned.
     */
    ownerId?: string;
    /** Audit label for how the owner was chosen (e.g. "fixed", "territory:0"). */
    assignedBy?: string;
};
export type AuditFindingSeverity = "info" | "warning" | "critical";
/**
 * One claim that a canonical record exists in an external system. A record
 * merged from several providers carries one identity per provider.
 */
export type ProviderIdentity = {
    provider: CrmProvider;
    externalId: string;
};
export type PipelineFindingType = "call_next_step_not_reflected_in_crm" | "deal_missing_next_step" | "deal_stale_activity" | "deal_past_close_date" | "deal_missing_owner" | "deal_missing_account";
export type PipelineFindingStatus = "open" | "planned" | "approved" | "applied" | "verified" | "dismissed" | "stale";
export type SourceFreshness = {
    state: "fresh" | "stale" | "unknown";
    checkedAt: string;
    sourceUpdatedAt?: string;
    ageDays?: number;
};
export type GtmEvidence = {
    id: string;
    sourceSystem: GtmEvidenceSourceSystem;
    sourceObjectType: string;
    sourceObjectId: string;
    objectType?: GtmObjectType;
    objectId?: string;
    title?: string;
    text: string;
    observedAt?: string;
    capturedAt?: string;
    freshness?: SourceFreshness;
    metadata?: Record<string, unknown>;
};
export type PipelineFinding = {
    id: string;
    type: PipelineFindingType;
    objectType: GtmObjectType;
    objectId: string;
    severity: AuditFindingSeverity;
    status: PipelineFindingStatus;
    title: string;
    summary: string;
    recommendation: string;
    evidenceIds: string[];
    currentCrmValue?: unknown;
    proposedValue?: unknown;
    freshness: SourceFreshness;
    patchEligibility: {
        eligible: boolean;
        operation?: PatchOperationType | "none";
        field?: string;
        reason: string;
        approvalRequired: boolean;
    };
};
export type PatchVerification = {
    status: "not_started" | "pending" | "verified" | "failed" | "skipped";
    checkedAt?: string;
    sourceSystem?: GtmEvidenceSourceSystem;
    expectedValue?: unknown;
    observedValue?: unknown;
    providerResult?: unknown;
    auditText?: string;
};
export type CanonicalUser = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
    name: string;
    email?: string;
    title?: string;
    active?: boolean;
};
/**
 * Who created a record, per the provider's read-only record-source fields
 * (HubSpot: hs_object_source / _label / _id). Populated on read; used to
 * attribute duplicate findings to the writer that produced them.
 */
export type RecordProvenance = {
    /** Provider source code, e.g. INTEGRATION, API, CRM_UI, IMPORT, FORM. */
    source?: string;
    /** Human label, e.g. an integration's name. */
    sourceLabel?: string;
    /** Provider-side id of the source (e.g. app id, import id). */
    sourceId?: string;
};
export type CanonicalAccount = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
    provenance?: RecordProvenance;
    name: string;
    domain?: string;
    industry?: string;
    ownerId?: string;
    employeeCount?: number;
    annualRevenue?: number;
    lastActivityAt?: string;
    lastSyncAt?: string;
    /** Provider-native payload escape hatch. Never read by audit rules. */
    raw?: unknown;
};
export type CanonicalContact = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
    provenance?: RecordProvenance;
    accountId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    title?: string;
    /** LinkedIn profile URL — the strongest cross-system identity key for dedup. */
    linkedin?: string;
    ownerId?: string;
    lastActivityAt?: string;
    lastSyncAt?: string;
    /** Provider-native payload escape hatch. Never read by audit rules. */
    raw?: unknown;
};
export type CanonicalDeal = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
    provenance?: RecordProvenance;
    accountId?: string;
    ownerId?: string;
    name: string;
    amount?: number;
    currency?: string;
    stage?: string;
    closeDate?: string;
    /** Provider-native deal type string (e.g. HubSpot `dealtype`), unmapped. */
    dealType?: string;
    forecastCategory?: string;
    nextStep?: string;
    probability?: number;
    isClosed?: boolean;
    isWon?: boolean;
    lastActivityAt?: string;
    lastSyncAt?: string;
    /** Provider-native payload escape hatch. Never read by audit rules. */
    raw?: unknown;
};
export type CanonicalActivity = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
    accountId?: string;
    contactId?: string;
    dealId?: string;
    ownerId?: string;
    type: "call" | "email" | "meeting" | "note" | "task" | "other";
    occurredAt: string;
    subject?: string;
};
export type CanonicalGtmSnapshot = {
    generatedAt: string;
    provider: CrmProvider;
    users: CanonicalUser[];
    accounts: CanonicalAccount[];
    contacts: CanonicalContact[];
    deals: CanonicalDeal[];
    activities: CanonicalActivity[];
};
export type GtmPolicy = {
    staleDealDays: number;
    requireDealOwner: boolean;
    requireAccountForDeal: boolean;
    today: string;
    /** Flag open deals without an amount (default true). */
    requireDealAmount?: boolean;
    /** Window ahead of today that counts as "closing soon" (default 14 days). */
    closingSoonDays?: number;
    /** Idle days that make a closing-soon deal a finding (default 7). */
    closingSoonIdleDays?: number;
};
export type AuditFinding = {
    id: string;
    objectType: GtmObjectType;
    objectId: string;
    ruleId: string;
    title: string;
    severity: AuditFindingSeverity;
    summary: string;
    recommendation: string;
    type?: PipelineFindingType;
    evidenceIds?: string[];
    currentCrmValue?: unknown;
    proposedValue?: unknown;
    freshness?: SourceFreshness;
    patchEligible?: boolean;
};
export type PatchOperation = {
    id: string;
    objectType: GtmObjectType;
    objectId: string;
    operation: PatchOperationType;
    field?: string;
    beforeValue?: unknown;
    afterValue?: unknown;
    reason: string;
    riskLevel: RiskLevel;
    approvalRequired: boolean;
    sourceRuleOrPolicy?: string;
    rollback?: string;
    evidenceIds?: string[];
    findingIds?: string[];
    verification?: PatchVerification;
    /**
     * Compare-and-set guards beyond the written field: each precondition is
     * re-read at apply time and a mismatch turns the operation into a
     * conflict instead of a write. Guards against a record drifting on a
     * DIFFERENT field than the one being written (e.g. stage changed while
     * an owner write was pending).
     */
    preconditions?: Array<{
        field: string;
        expectedValue: unknown;
    }>;
    /**
     * Operations sharing a groupId are all-or-nothing at apply time: a
     * conflict (beforeValue or precondition) on any member skips every
     * member of the group.
     */
    groupId?: string;
    /**
     * Set only when a human explicitly chose to archive a record that shares an
     * identity key with another (`bulk-update --archive --force-archive-duplicates`).
     * Without it, apply refuses to archive_record a record the live snapshot still
     * sees as a duplicate — archiving a duplicate discards data that merging keeps,
     * and an agent on a dedupe task must not silently substitute archive for merge.
     */
    forceArchiveDuplicate?: boolean;
    /**
     * For irreversible operations (merge_records, archive_record): the field
     * values of the records that will be destroyed, captured at plan-build time.
     * Merges and archives cannot be undone on any provider, so this is the
     * recovery artifact a human uses to recreate a record by hand if a merge or
     * archive was wrong — the plan file IS the backup.
     */
    recoverySnapshot?: Record<string, unknown>[];
};
/**
 * A patch plan is always a dry-run proposal. Applying a plan never mutates
 * the plan itself; the outcome is recorded separately as a `PatchPlanRun`.
 */
export type PatchPlan = {
    id: string;
    title: string;
    createdAt: string;
    status: ApprovalStatus;
    dryRun: true;
    summary: string;
    /** The COMPLETE, object-typed findings list — every account/contact/deal
     *  finding, each carrying its `objectType`. This is the canonical set. */
    findings: AuditFinding[];
    /** A deal/sales-PIPELINE projection of `findings` (deal-level + the
     *  call-next-step type) for the pipeline-trust queue — intentionally a subset.
     *  Account/contact hygiene findings are NOT here; read `findings` for those. */
    pipelineFindings?: PipelineFinding[];
    evidence?: GtmEvidence[];
    operations: PatchOperation[];
    /**
     * The filter this plan's operations were selected by. Re-evaluated per
     * record against a FRESH snapshot at apply time: any operation whose
     * record no longer matches is reported as a conflict instead of applied.
     * Unlike per-operation preconditions, this enforces the FULL filter —
     * negations and relational pseudo-fields included.
     */
    filter?: {
        objectType: "account" | "contact" | "deal";
        where: string[];
        /**
         * The date the filter's comparison `today` literal resolves to (ISO
         * yyyy-mm-dd). Stored so apply-time re-verification resolves `today`
         * identically to plan time; absent on plans built before comparison ops.
         */
        today?: string;
    };
    /**
     * Plan-level guards re-evaluated against a FRESH snapshot at apply time.
     * If any guard fails, NO operation in the plan is applied. This is how a
     * plan expresses cross-record eligibility ("apply only while the account
     * still has no open deal in contractsent") that per-operation
     * preconditions cannot reach.
     */
    guards?: PlanGuard[];
};
export type PlanGuard = {
    objectType: "account" | "contact" | "deal";
    /** filter expressions in bulk-update --where grammar, AND-ed */
    where: string[];
    /** none: guard passes when ZERO records match; some: when at least one matches */
    expect: "none" | "some";
    description?: string;
};
/** Pre-computed lookups shared by all rules so each rule stays O(n). */
export type GtmSnapshotIndex = {
    usersById: Map<string, CanonicalUser>;
    accountsById: Map<string, CanonicalAccount>;
    contactsByAccountId: Map<string, CanonicalContact[]>;
    dealsByAccountId: Map<string, CanonicalDeal[]>;
    activitiesByDealId: Map<string, CanonicalActivity[]>;
};
export type GtmRuleContext = {
    snapshot: CanonicalGtmSnapshot;
    policy: GtmPolicy;
    index: GtmSnapshotIndex;
};
export type GtmRuleResult = {
    findings: AuditFinding[];
    operations: PatchOperation[];
};
/**
 * A deterministic audit rule. Rules read the snapshot through the context and
 * return findings plus dry-run patch operations; they never perform writes.
 */
export type GtmAuditRule = {
    id: string;
    title: string;
    description: string;
    /** Grouping for docs and discovery, e.g. "hygiene", "forecast", "coverage". */
    category?: string;
    evaluate: (context: GtmRuleContext) => GtmRuleResult;
};
export type PatchOperationResult = {
    operationId: string;
    /** `conflict`: the provider value drifted since the plan was proposed; nothing was written. */
    status: "applied" | "failed" | "skipped" | "conflict";
    detail?: string;
    providerData?: unknown;
};
export type PatchPlanRunStatus = "applied" | "partial" | "failed" | "rejected";
/** The record of one attempt to apply an approved patch plan. */
export type PatchPlanRun = {
    planId: string;
    provider: CrmProvider;
    startedAt: string;
    finishedAt: string;
    status: PatchPlanRunStatus;
    results: PatchOperationResult[];
};
/**
 * The provider contract. Reads produce a canonical snapshot; writes accept a
 * single patch operation and report the outcome. Connectors without
 * `applyOperation` are read-only.
 */
export type GtmConnector = {
    provider: CrmProvider;
    fetchSnapshot: () => Promise<CanonicalGtmSnapshot>;
    applyOperation?: (operation: PatchOperation) => Promise<PatchOperationResult>;
    /**
     * Bulk fast-path for independent `create_record` contact ops: batch the
     * resolve-first read and the create writes instead of one round-trip per
     * record (orders of magnitude fewer API calls for lead acquisition). The
     * caller (`applyPatchPlan`) only routes ops here that are safe to batch —
     * approved, no group, no value override, no company association — and falls
     * back to `applyOperation` for the rest. Implementations MUST preserve
     * resolve-first (never create over an existing match) and return exactly one
     * result per input op. Optional: connectors without it use `applyOperation`.
     */
    applyCreateContactsBatch?: (operations: PatchOperation[]) => Promise<PatchOperationResult[]>;
    /**
     * Read the live value of one canonical field, used for compare-and-set:
     * apply orchestration refuses to write over values that drifted since the
     * plan was proposed.
     */
    readField?: (objectType: GtmObjectType, objectId: string, field: string) => Promise<unknown>;
    /**
     * Records modified since the given ISO timestamp, as a partial snapshot —
     * the incremental alternative to `fetchSnapshot` for frequent syncs.
     * Provider change feeds may omit cross-record associations; consumers
     * merging deltas must preserve associations from the last full snapshot.
     */
    fetchChanges?: (sinceIso: string) => Promise<CanonicalGtmSnapshot>;
};

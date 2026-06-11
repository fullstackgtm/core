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
export type GtmEvidenceSourceSystem = "salesforce" | "hubspot" | "gong" | "chorus" | "fathom" | "manual" | "csv" | "mock" | "unknown";
export type PatchOperationType = "set_field" | "clear_field" | "link_record" | "archive_record" | "create_task" | "merge_records";
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
export type CanonicalAccount = {
    id: string;
    provider?: CrmProvider;
    crmId?: string;
    identities?: ProviderIdentity[];
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
    accountId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    title?: string;
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
    findings: AuditFinding[];
    pipelineFindings?: PipelineFinding[];
    evidence?: GtmEvidence[];
    operations: PatchOperation[];
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

export { auditSnapshot, defaultPolicy } from "./audit.ts";
export {
  CONFIG_FILE_NAME,
  loadConfig,
  mergePolicy,
  resolveConfiguredRules,
  type FullstackgtmConfig,
  type LoadedConfig,
} from "./config.ts";
export { applyPatchPlan, type ApplyPatchPlanOptions } from "./connector.ts";
export { createHubspotConnector, type HubspotConnectorOptions } from "./connectors/hubspot.ts";
export {
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_OAUTH_SCOPES,
  exchangeHubspotCode,
  refreshHubspotToken,
  runHubspotLoopbackLogin,
  validateHubspotToken,
  type HubspotTokenSet,
  type LoopbackLoginOptions,
} from "./connectors/hubspotAuth.ts";
export {
  createSalesforceConnector,
  type SalesforceConnection,
  type SalesforceConnectorOptions,
} from "./connectors/salesforce.ts";
export {
  pollSalesforceDeviceLogin,
  refreshSalesforceToken,
  startSalesforceDeviceLogin,
  validateSalesforceToken,
  type SalesforceDeviceAuthorization,
  type SalesforceTokenSet,
} from "./connectors/salesforceAuth.ts";
export { createStripeConnector, type StripeConnectorOptions } from "./connectors/stripe.ts";
export {
  activeProfile,
  credentialsDir,
  credentialsPath,
  DEFAULT_PROFILE,
  deleteCredential,
  getCredential,
  listProfiles,
  resolveHubspotAccessToken,
  resolveHubspotConnection,
  setActiveProfile,
  storeCredential,
  type HubspotConnection,
  type StoredCredential,
} from "./credentials.ts";
export { generateDemoSnapshot, type DemoSnapshotOptions } from "./demo.ts";
export {
  diffFindings,
  diffSnapshots,
  diffToMarkdown,
  type CollectionDiff,
  type FieldChange,
  type FindingsDrift,
  type RecordChange,
  type SnapshotDiff,
} from "./diff.ts";
export {
  mergeSnapshots,
  type MergeConflict,
  type MergeMatch,
  type MergeReport,
  type MergeSuggestion,
} from "./merge.ts";
export { createFilePlanStore, type PlanStore, type StoredPlan } from "./planStore.ts";
export { formatPatchPlanRun, patchPlanToMarkdown } from "./format.ts";
export { auditReportToHtml, auditReportToMarkdown, type ReportOptions } from "./report.ts";
export {
  HUBSPOT_DEFAULT_FIELD_MAPPINGS,
  SALESFORCE_DEFAULT_FIELD_MAPPINGS,
  mappedField,
  mappedFields,
  normalizeFieldMappings,
  readMappedValue,
  type CrmObjectType,
  type FieldMappings,
} from "./mappings.ts";
export {
  accountSingleSourceRule,
  activeDealAccountWithoutContactsRule,
  auditFindingId,
  buildSnapshotIndex,
  builtinAuditRules,
  closingSoonInactiveRule,
  duplicateAccountDomainRule,
  duplicateContactEmailRule,
  duplicateOpenDealRule,
  missingDealAccountRule,
  missingDealAmountRule,
  missingDealOwnerRule,
  orphanAccountRule,
  pastCloseDateRule,
  patchOperationId,
  requiresHumanInput,
  staleDealRule,
} from "./rules.ts";
export {
  extractCallInsights,
  normalizeTranscript,
  parseCall,
  parseTranscript,
  suggestCallDeal,
  summarizeInsights,
  type CallDealSuggestion,
  type CallInsightType,
  type ExtractedCallInsight,
  type ParsedCall,
  type ParsedTranscriptSegment,
} from "./calls.ts";
export { sampleSnapshot } from "./sampleData.ts";
export {
  DEFAULT_MODELS,
  DEFAULT_RUBRIC,
  detectProviderFromKey,
  extractInsightsLlm,
  parseRubric,
  resolveLlmCredential,
  scoreCallLlm,
  validateLlmKey,
  type CallScorecard,
  type LlmCredential,
  type LlmExtractedInsight,
  type LlmProvider,
  type Rubric,
  type ScoredDimension,
} from "./llm.ts";
export { suggestValues, type SuggestionConfidence, type ValueSuggestion } from "./suggest.ts";
export type {
  ApprovalStatus,
  AuditFinding,
  AuditFindingSeverity,
  CanonicalAccount,
  CanonicalActivity,
  CanonicalContact,
  CanonicalDeal,
  CanonicalGtmSnapshot,
  CanonicalUser,
  CrmProvider,
  GtmAuditRule,
  GtmConnector,
  GtmEvidence,
  GtmEvidenceSourceSystem,
  GtmObjectType,
  GtmPolicy,
  GtmRuleContext,
  GtmRuleResult,
  GtmSnapshotIndex,
  PatchOperation,
  PatchOperationResult,
  PatchOperationType,
  PatchPlan,
  PatchPlanRun,
  PatchPlanRunStatus,
  PatchVerification,
  PipelineFinding,
  PipelineFindingStatus,
  PipelineFindingType,
  ProviderIdentity,
  RiskLevel,
  SourceFreshness,
} from "./types.ts";

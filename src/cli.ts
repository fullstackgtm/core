import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "./audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.ts";
import { applyPatchPlan } from "./connector.ts";
import { diffFindings, diffSnapshots, diffToMarkdown } from "./diff.ts";
import { createHubspotConnector } from "./connectors/hubspot.ts";
import {
  DEFAULT_LOOPBACK_PORT,
  openInBrowser,
  runHubspotLoopbackLogin,
  validateHubspotToken,
} from "./connectors/hubspotAuth.ts";
import { createSalesforceConnector } from "./connectors/salesforce.ts";
import { createStripeConnector } from "./connectors/stripe.ts";
import {
  pollSalesforceDeviceLogin,
  startSalesforceDeviceLogin,
  validateSalesforceToken,
} from "./connectors/salesforceAuth.ts";
import {
  activeProfile,
  credentialsPath,
  DEFAULT_PROFILE,
  deleteCredential,
  getCredential,
  listProfiles,
  resolveHubspotConnection,
  resolveSalesforceConnection,
  setActiveProfile,
  storeCredential,
  type StoredCredential,
} from "./credentials.ts";
import { generateDemoSnapshot } from "./demo.ts";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.ts";
import {
  appendHealthEntry,
  computeHealth,
  healthToMarkdown,
  readHealthTimeline,
  saveWorkspaceSnapshot,
  summarizeHealth,
  activeWorkspaceProfile,
} from "./health.ts";
import { mergeSnapshots } from "./merge.ts";
import { verifyApprovalDigests } from "./integrity.ts";
import { buildAuditLog, verifyAuditLog } from "./auditLog.ts";
import { createFilePlanStore } from "./planStore.ts";
import { auditReportToHtml, auditReportToMarkdown, type ReportOptions } from "./report.ts";
import { builtinAuditRules } from "./rules.ts";
import { sampleSnapshot } from "./sampleData.ts";
import { normalizeTranscript, parseCall, suggestCallDeal, type ExtractedCallInsight, type ParsedCall } from "./calls.ts";
import {
  classifyCall,
  rubricForCallType,
  rubricPresets,
  CALL_TYPES,
  CALL_TYPE_IDS,
  type CallType,
} from "./callTypes.ts";
import {
  captureMarket,
  computeFrontStates,
  createFileObservationStore,
  diffFrontStates,
  loadCaptureTexts,
  loadMarketConfig,
  starterMarketConfig,
  validateObservationSet,
  verifyEvidenceSpans,
  type ObservationSet,
} from "./market.ts";
import { assessAxes, axesReportToText } from "./marketAxes.ts";
import {
  computeDirectives,
  computeOverlayStats,
  directivesToPlan,
  overlayToMarkdown,
  type CallDocument,
} from "./marketOverlay.ts";
import { computeScaleIndex, scaleReportToText } from "./marketScale.ts";
import { suggestMarketConfig } from "./marketTaxonomy.ts";
import { buildWorksheet, classifyMarket } from "./marketClassify.ts";
import { marketMapToHtml, marketMapToMarkdown } from "./marketReport.ts";
import {
  DEFAULT_RUBRIC,
  classifyCallLlm,
  detectProviderFromKey,
  extractInsightsLlm,
  parseRubric,
  resolveLlmCredential,
  scoreCallLlm,
  validateLlmKey,
  type CallScorecard,
  type LlmProvider,
  type Rubric,
} from "./llm.ts";
import {
  buildAcquirePlan,
  buildEnrichPlan,
  createFileEnrichRunStore,
  DEFAULT_STALE_DAYS,
  ENRICH_CONFIG_FILE_NAME,
  builtinAcquirePreset,
  builtinEnrichPreset,
  enrichRunId,
  inferIngestObjectType,
  latestStamps,
  loadEnrichConfig,
  parseCsv,
  resolveCrmField,
  selectStaleWork,
  stagedSourceRecords,
  staleDaysFor,
  type EnrichConfig,
  type EnrichCounts,
  type EnrichObjectType,
  type EnrichRun,
  type EnrichRunStore,
  type EnrichSourceRecord,
} from "./enrich.ts";
import {
  loadMeter,
  recordConsumption,
  remaining,
  type AcquireRemaining,
} from "./acquireMeter.ts";
import {
  crmContactKeys,
  fetchExploriumProspects,
  fetchPipe0CrustdataProspects,
  partitionFreshProspects,
  pipe0ResolveWorkEmails,
  prospectIdentityKeys,
  type Prospect,
} from "./connectors/prospectSources.ts";
import { loadSeen, recordSeen } from "./acquireSeen.ts";
import {
  fitThreshold,
  icpFromAnswers,
  icpToCrustdataFilters,
  icpToExploriumFilters,
  parseIcp,
  scoreProspectAgainstIcp,
  INTERVIEW_SPEC,
  type Icp,
} from "./icp.ts";
import {
  apolloPullKeysForAppend,
  apolloPullKeysForRefresh,
  createApolloClient,
  pullApolloRecords,
  type ApolloPullKey,
} from "./enrichApollo.ts";
import {
  computeMissedFirings,
  createFileScheduleRunStore,
  createFileScheduleStore,
  nextCronFiring,
  parseCron,
  renderManagedBlock,
  replaceManagedBlock,
  assertSingleLineLabel,
  hasControlChar,
  scheduleId,
  systemCrontabIo,
  tokenizeCommand,
  validateSchedulableArgv,
  type ScheduleEntry,
  type ScheduleRunRecord,
  type ScheduleRunTrigger,
} from "./schedule.ts";
import { resolveRecord, type ResolveCandidate } from "./resolve.ts";
import { buildBulkUpdatePlan } from "./bulkUpdate.ts";
import { buildDedupePlan, type DedupeOptions } from "./dedupe.ts";
import { buildReassignPlans, type ReassignObjectType } from "./reassign.ts";
import { suggestValues, type ValueSuggestion } from "./suggest.ts";
import type { FieldMappings } from "./mappings.ts";
import type {
  AuditFindingSeverity,
  CanonicalGtmSnapshot,
  CreateRecordPayload,
  GtmConnector,
  PatchOperation,
  PatchPlan,
} from "./types.ts";

function usage() {
  return `FullStackGTM — audit GTM data across providers, propose reviewable patch plans,
and apply only explicitly approved operations.

Usage:
  fullstackgtm login --via <hosted url>        pair with a team deployment (recommended)
  fullstackgtm login hubspot [--no-validate]
  fullstackgtm login hubspot --oauth --client-id <id> [--port ${DEFAULT_LOOPBACK_PORT}] [--scopes a,b]
  fullstackgtm login salesforce --device --client-id <consumer key> [--login-url <url>]
  fullstackgtm login salesforce --instance-url <url> [--no-validate]
  fullstackgtm login stripe [--no-validate]
  fullstackgtm login anthropic | openai        store an LLM API key for call parse/score
  fullstackgtm login apollo                    store an Apollo API key for enrich pulls\n  fullstackgtm login pipe0 | explorium         store a discovery-provider key for enrich acquire\n  fullstackgtm logout <hubspot|salesforce|stripe|anthropic|openai|apollo|pipe0|explorium|broker>

  Secrets (tokens, client secrets) are NEVER passed as flags — they leak via
  the process list and shell history. Pipe them on stdin or enter them at the
  interactive prompt:
    echo "$HUBSPOT_TOKEN" | fullstackgtm login hubspot
  fullstackgtm snapshot [source options] [--since <iso>] [--out <path> | --archive <dir>]
  fullstackgtm audit [source options] [audit options] [--save]
  fullstackgtm report [source options] [audit options] [report options]
  fullstackgtm diff --before <a.json> --after <b.json> [--json] [--fail-on-new-findings]
  fullstackgtm merge --input <a.json> --input <b.json> [...] --out <merged.json> [--json]
  fullstackgtm call parse --transcript <file> [--title t] [--source fathom|granola|...] [--model m] [--deterministic] [--json|--ndjson] [--out <path>]
  fullstackgtm call classify --transcript <file>|--call <parsed.json> [--llm] [--deterministic] [--json]
  fullstackgtm call score --transcript <file>|--call <parsed.json> [--call-type <t>] [--rubric <rubric.json>] [--model m] [--json|--out <path>]
  fullstackgtm call link --attendees <a@x.com,...> | --domain <x.com>  [source options] [--json]
  fullstackgtm call plan --transcript <file>|--call <parsed.json> --deal <id> [source options] [--save|--json]
                                               calls become evidence: LLM extraction by default (bring your own
                                               Anthropic or OpenAI key — captured once on first use, or
                                               ANTHROPIC_API_KEY/OPENAI_API_KEY, or \`login anthropic|openai\`);
                                               --deterministic uses the free keyword baseline. Then link the call
                                               to its deal and propose governed next-step writes.
  fullstackgtm resolve <account|contact|deal> [--name N] [--domain D] [--email E] [--account-id A] [source options] [--json]
                                               the create gate: exit 0 = safe to create, exit 2 = match
                                               found (exists/ambiguous) — call before ANY record creation
  fullstackgtm market init --category <name>   start a market map: vendors + claim taxonomy as reviewable config
  fullstackgtm market capture [--config <path>] [--run <label>]
  fullstackgtm market classify [--run <label>] [--vendor <id>] [--model m] [--out <path>]
  fullstackgtm market worksheet --vendor <id> [--out <path>]
  fullstackgtm market observe --from <observations.json> [--unverified]
  fullstackgtm market fronts [--run <label>] [--diff <prior-run>] [--json]
  fullstackgtm market axes [--run <label>] [--json]
  fullstackgtm market report [--run <label>] [--format md|html] [--out <path>]
  fullstackgtm market overlay --snapshot <crm.json> [--calls <files>] [--save]
  fullstackgtm market scale [--json]
  fullstackgtm market refresh [--run <label>] [--model m]
                                               the live competitive map: capture vendor pages (content-addressed),
                                               classify intensity per claim (LLM bring-your-own-key, or fill the
                                               worksheet with any agent) — every quoted span is verified verbatim
                                               against the stored capture it cites before it's accepted — then
                                               compute deterministic front states and drift, render the field
                                               report. refresh = capture → classify → drift → report in one step
  fullstackgtm enrich append [--source apollo] [--objects companies,contacts] [--save] [--config <path>] [source options]
  fullstackgtm enrich refresh [--source apollo] [--stale-days <n>] [--save] [--config <path>] [source options]
  fullstackgtm enrich ingest <file.csv|payload.json> --source clay [--run-label <label>]
  fullstackgtm enrich status [--runs] [--source <id>] [--json]
                                               governed enrichment: pull (Apollo) or stage (Clay) third-party
                                               data, match it to CRM records deterministically, and emit a
                                               fill-blanks-only patch plan through the normal dry-run →
                                               approve → apply gate. refresh re-checks stale stamped fields
                                               and proposes updates only where the source value changed.
  fullstackgtm bulk-update <account|contact|deal> --where <expr> [--where …] (--set <field>=<value> [--set …] | --archive [--force-archive-duplicates] | --create-task <text>) [--require <field>=<value> …] [--guard <object>:<where>[;<where>]:<none|some> …] [source options] [--save] [--json] [--out <path>]
                                               governed generic writes: filter the snapshot
                                               (field=value, field!=value, field~substr, field!~substr,
                                               field:empty, field:notempty, '|' = any-of; canonical fields
                                               like ownerId, stage, closeDate, amount; relational
                                               pseudo-fields account.name/domain/ownerId/contactCount/
                                               openDealStages on deals and contacts, contactCount/
                                               openDealCount/openDealStages on accounts) into a dry-run
                                               patch plan. The full filter is re-verified per record at
                                               apply time (incl. mid-apply rechecks); equality filters
                                               double as preconditions; per-record ops apply
                                               all-or-nothing; guards assert cross-record conditions.
                                               --set <field>=from:<sourceField> derives the value PER
                                               RECORD from the snapshot (relational sources like
                                               account.ownerId included); records whose source is empty
                                               are skipped and counted, never guessed. --archive refuses
                                               records that share their identity key (account domain /
                                               contact email) with another record — merge those with
                                               \`dedupe\` instead, or --force-archive-duplicates.
  fullstackgtm dedupe <account|contact|deal> --key <domain|email|name> [--keep richest|oldest] [source options] [--reason <text>] [--max-operations <n>] [--save] [--json] [--out <path>]
                                               find duplicate groups by normalized identity key and build
                                               a dry-run plan of merge_records operations — one per group,
                                               deterministic survivor (richest = most populated data
                                               fields, ties to lowest id; oldest = lowest id). Approve and
                                               apply like any plan; merges are IRREVERSIBLE on apply.
  fullstackgtm reassign --from <ownerId> --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--except-deal-stage <stage>] [--include-closed-deals] [source options] [--save] [--json] [--out <path>]
                                               ownership handoff playbook: one bulk-update-style plan per
                                               object type (ownerId=<from> → <to>). Extra --where scoping
                                               is account-lifted for deals/contacts (domain~.de becomes
                                               account.domain~.de); --except-deal-stage <stage> excludes
                                               deals in that stage AND every record whose account has an
                                               open deal in it, re-verified per record at apply time.
                                               Deal plans cover open deals only unless
                                               --include-closed-deals.
  fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--today <iso>] [--yes]
                                               one-shot composite: audit ONE rule → save the plan →
                                               suggest values → approve only suggestion-backed operations
                                               meeting the confidence bar (plus operations that need no
                                               value) → with --yes, apply through the provider and print a
                                               stage-by-stage summary. Without --yes it stops after
                                               approval and prints the apply command.
  fullstackgtm schedule add "<command>" --cron "<expr>" [--label <name>] [--provider local]
  fullstackgtm schedule list | remove <id> | enable <id> | disable <id> | run <id>
  fullstackgtm schedule install | uninstall [--provider local]
  fullstackgtm schedule status [<id>] [--runs <n>]
                                               declare a cadence for any read/plan-side command (audit,
                                               snapshot, enrich append|refresh, market capture|refresh,
                                               suggest, report, doctor); install materializes enabled
                                               entries into a sentinel-delimited managed crontab block.
                                               Scheduling never auto-approves: apply is schedulable only
                                               as apply --plan-id <id>, re-checked approved at run time.
  fullstackgtm suggest --plan-id <id> | --plan <path>  [source options] [--json] [--out <path>]
                                               derive values for requires_human_* placeholders
                                               from snapshot evidence, with confidence + reasons
  fullstackgtm plans list [--status <s>] | show <id> | reject <id>
  fullstackgtm plans approve <id> --operations <ids|all> [--value <opId>=<v>]
  fullstackgtm plans approve <id> --values-from <suggestions.json> [--min-confidence high|low] [--include-creates]
  fullstackgtm apply --plan-id <id> --provider <name>
  fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [options]
  fullstackgtm audit-log export [--out <path>] | verify --in <path>   tamper-evident apply-run record
  fullstackgtm rules [--json]
  fullstackgtm profiles [--json]               list credential profiles
  fullstackgtm doctor [--json]                 check install, credentials, and next step

Profiles (multi-organization use):
  --profile <name>       Scope credentials AND stored plans to a named profile
                         (also: FULLSTACKGTM_PROFILE). One profile per client
                         org keeps logins isolated and prevents a plan proposed
                         against one CRM from being applied through another's
                         credentials. Omitted = the default profile.

Plan lifecycle:
  audit --save persists the dry-run plan to ~/.fullstackgtm/plans. Approve
  specific operations (optionally with --value <opId>=<v> for placeholders),
  then apply by id — the store enforces approval and records every run.

Authentication (checked in order):
  1. --token-env <name>        explicit env var for this invocation (hubspot)
  2. ambient env               HUBSPOT_ACCESS_TOKEN, or SALESFORCE_ACCESS_TOKEN +
                               SALESFORCE_INSTANCE_URL (CI, agent sandboxes)
  3. stored provider login     fullstackgtm login <provider>; kept in ~/.fullstackgtm
                               (hubspot: private app token or loopback OAuth;
                               salesforce: device flow — code on any device, no
                               secret, silent refresh)
  4. broker pairing            fullstackgtm login --via <url>: the team connects the
                               CRM once in the hosted dashboard; every paired CLI
                               uses those stored sync credentials from then on

Source options (snapshot and audit):
  --sample               Built-in minimal mock CRM data (default)
  --demo                 Realistic generated mid-market CRM with injected hygiene issues
  --seed <n>             Demo PRNG seed (default 7; same seed, same data)
  --input <path>         Canonical GTM snapshot JSON file
  --provider <name>      Live provider snapshot: hubspot | salesforce | stripe (read-only)
  --token-env <name>     Env var holding the provider access token

Audit options:
  --config <path>        Config file (default: ./fullstackgtm.config.json if present)
                         { "policy": {...}, "rules": {"enabled":[],"disabled":[]},
                           "rulePackages": ["./team-rules.mjs"] }
  --rules <ids>          Comma-separated rule ids to run (default: all; see \`rules\`)
  --json                 Print the JSON patch plan instead of markdown
  --out <path>           Also write the JSON patch plan to a file
  --today <date>         Override today's date for deterministic audits
  --stale-days <n>       Days without activity before an open deal is stale
  --fail-on <severity>   Exit 2 if any finding is at or above info|warning|critical

Report options (report renders the audit as a client-ready deliverable):
  --plan <path>          Render an existing plan JSON instead of re-auditing
                         (add --input <snapshot.json> for record counts)
  --client <name>        Organization name shown in the heading and summary
  --title <text>         Report heading (default "GTM Data Health Report")
  --prepared-by <name>   Attribution shown in the footer
  --format <fmt>         markdown (default) or html (self-contained, printable;
                         inferred from an --out path ending in .html)
  --max-examples <n>     Example records listed per rule (default 10)
  --out <path>           Write the report to a file instead of stdout

Apply options:
  --plan <path>          Patch plan JSON produced by \`audit --out\`
  --provider hubspot     Connector to apply through
  --token-env <name>     Env var holding the provider access token
  --approve <ids|all>    Comma-separated operation ids to apply, or "all"
  --value <opId>=<v>     Concrete value for a requires_human_* placeholder (repeatable)
  --json                 Print the JSON run record instead of markdown

Exit codes:
  0 success · 1 error · 2 audit findings at/above the --fail-on threshold

Safety:
  Audits are read-only. Apply writes only operations you explicitly approve,
  and never writes requires_human_* placeholders without a --value override.`;
}

// ── Progressive-disclosure help ─────────────────────────────────────────────
// usage() above is the full reference (`fullstackgtm help --full`). The default
// front door is shortUsage() — a lifecycle-grouped map, one line per verb — and
// commandHelp() gives focused per-verb help so `<verb> --help` zooms in instead
// of dumping the whole 22-verb / 87-flag surface. See docs/dx-punch-list.md
// (F1/F3). Commands with their own rich help (call/market/enrich/bulk-update/
// schedule) print it themselves; here they carry a one-line pointer.

type HelpEntry = {
  summary: string; // one line, shown in the grouped map
  phase: string; // where the verb sits in Prevent→Detect→Remediate→Verify
  synopsis: string[]; // invocation form(s)
  detail?: string; // a sentence or two on behavior
  options?: Array<[string, string]>; // the flags that matter most
  seeAlso?: string[]; // related verbs to chain
};

const HELP: Record<string, HelpEntry> = {
  // Setup & health
  login: {
    summary: "connect a provider or LLM key (secrets via stdin/env, never argv)",
    phase: "Setup",
    synopsis: [
      "fullstackgtm login --via <hosted url>            pair with a team deployment",
      "fullstackgtm login hubspot | salesforce | stripe",
      "fullstackgtm login anthropic | openai | apollo",
    ],
    detail:
      "Secrets are NEVER passed as flags (they leak via the process list and shell history) — pipe on stdin or enter at the prompt: `echo \"$TOKEN\" | fullstackgtm login hubspot`.",
    seeAlso: ["doctor", "logout", "profiles"],
  },
  logout: {
    summary: "remove stored credentials for a provider",
    phase: "Setup",
    synopsis: ["fullstackgtm logout <hubspot|salesforce|stripe|anthropic|openai|apollo|pipe0|explorium|broker>"],
    seeAlso: ["login", "doctor"],
  },
  doctor: {
    summary: "check install, credentials, and the next step",
    phase: "Setup",
    synopsis: ["fullstackgtm doctor [--json]"],
    detail: "Verifies Node version, the credential store, MCP peers, and prints what to run next.",
    seeAlso: ["login", "audit"],
  },
  profiles: {
    summary: "list credential profiles (one per client org)",
    phase: "Setup",
    synopsis: ["fullstackgtm profiles [--json]"],
    detail:
      "`--profile <name>` (or FULLSTACKGTM_PROFILE) scopes credentials AND stored plans per org, so a plan proposed against one CRM can't be applied through another's credentials.",
    seeAlso: ["login", "plans", "health"],
  },
  health: {
    summary: "CRM health score + trend for the active profile (read-only)",
    phase: "Detect",
    synopsis: ["fullstackgtm health [--json]"],
    detail:
      "The engagement-workspace rollup. Each `audit --save` stamps a deterministic 0–100 hygiene score (100 / (1 + severity-weighted findings per record)) onto the profile's timeline; `health` reports the current score, the change since the last audit, and per-rule deltas — turning episodic audits into a continuous record. Scope per client with `--profile <name>`.",
    seeAlso: ["audit", "profiles", "report"],
  },

  // Detect — read-only
  snapshot: {
    summary: "pull a canonical GTM snapshot (read-only)",
    phase: "Detect",
    synopsis: ["fullstackgtm snapshot [source options] [--since <iso>] [--out <path> | --archive <dir>]"],
    detail: "Materializes the provider's records as canonical JSON — the input every audit and write verb reads.",
    options: [
      ["--provider <name>", "hubspot | salesforce | stripe (read-only)"],
      ["--demo", "realistic generated CRM with injected hygiene issues"],
      ["--out <path>", "write the snapshot JSON to a file"],
    ],
    seeAlso: ["audit", "diff"],
  },
  audit: {
    summary: "read-only hygiene audit → reviewable dry-run patch plan",
    phase: "Detect",
    synopsis: ["fullstackgtm audit [source options] [audit options] [--save]"],
    detail:
      "The Detect layer of the loop. Runs deterministic rules over a snapshot and proposes a typed patch plan — nothing is written. Prints a summary (rule table + counts) by default; `--full` shows every operation. `--save` persists the plan for the suggest → approve → apply spine. For a client-ready writeup use `report`; for machine output add `--json`.",
    options: [
      ["--provider <name>", "live snapshot: hubspot | salesforce | stripe"],
      ["--demo", "try it with zero credentials on a messy generated CRM"],
      ["--full", "show every operation, not just the rule summary"],
      ["--rules <ids>", "comma-separated rule ids (default: all; see `rules`)"],
      ["--fail-on <sev>", "exit 2 if any finding ≥ info|warning|critical"],
      ["--save", "persist the dry-run plan for approve → apply"],
      ["--json / --out <p>", "machine-readable plan to stdout / file"],
    ],
    seeAlso: ["report", "suggest", "plans", "apply", "diff"],
  },
  report: {
    summary: "render an audit as a client-ready deliverable (md/html)",
    phase: "Detect",
    synopsis: ["fullstackgtm report [source options] [audit options] [report options]"],
    detail: "The human-readable counterpart to `audit` — a clean summary instead of the full per-operation dump.",
    options: [
      ["--plan <path>", "render an existing plan JSON instead of re-auditing"],
      ["--client <name>", "organization name in the heading/summary"],
      ["--format <fmt>", "markdown (default) or self-contained html"],
      ["--out <path>", "write to a file (html inferred from .html)"],
    ],
    seeAlso: ["audit"],
  },
  diff: {
    summary: "compare two snapshots/plans; gate on new findings",
    phase: "Detect",
    synopsis: ["fullstackgtm diff --before <a.json> --after <b.json> [--json] [--fail-on-new-findings]"],
    detail:
      "The regression primitive. Exit 2 when a (rule, record) pair fires that didn't before — wire it into CI to catch CRM rot.",
    seeAlso: ["audit", "snapshot", "merge"],
  },
  rules: {
    summary: "list the audit rule registry",
    phase: "Detect",
    synopsis: ["fullstackgtm rules [--json]"],
    seeAlso: ["audit"],
  },

  // Prevent — gate writes before they happen
  resolve: {
    summary: "the create gate: exit 0 = safe to create, 2 = match exists",
    phase: "Prevent",
    synopsis: ["fullstackgtm resolve <account|contact|deal> [--name N] [--domain D] [--email E] [source options] [--json]"],
    detail:
      "Prevention, not cleanup. Call before ANY record creation — a sync job, webhook, agent, or script. Returns exists/ambiguous/safe_to_create with matches and reasons; exit 2 = do not create.",
    seeAlso: ["dedupe", "audit"],
  },

  // Remediate — governed writes (all produce plans; nothing writes outside approve → apply)
  fix: {
    summary: "one-shot composite: audit one rule → suggest → approve → apply",
    phase: "Remediate",
    synopsis: ["fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--yes]"],
    detail:
      "The whole governed loop for a single rule in one command. Without `--yes` it stops after approval and prints the apply command; with `--yes` it applies suggestion-backed operations meeting the confidence bar and prints a stage-by-stage summary.",
    seeAlso: ["audit", "suggest", "plans", "apply"],
  },
  dedupe: {
    summary: "merge duplicate groups by identity key (irreversible on apply)",
    phase: "Remediate",
    synopsis: ["fullstackgtm dedupe <account|contact|deal> --key <domain|email|name> [--keep richest|oldest] [--save] [--json]"],
    detail:
      "Builds a dry-run plan of one merge_records op per duplicate group with a deterministic survivor (richest = most populated fields; oldest = lowest id). Approve and apply like any plan; merges are IRREVERSIBLE on apply.",
    seeAlso: ["resolve", "plans", "apply"],
  },
  reassign: {
    summary: "ownership handoff: one plan per object type",
    phase: "Remediate",
    synopsis: ["fullstackgtm reassign --from <ownerId> --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--save] [--json]"],
    detail:
      "Extra `--where` scoping is account-lifted for deals/contacts. `--except-deal-stage <stage>` excludes that stage and any record whose account has an open deal in it, re-verified per record at apply.",
    seeAlso: ["bulk-update", "plans", "apply"],
  },
  enrich: {
    summary: "governed third-party enrichment (Apollo/Clay), fill-blanks-only",
    phase: "Remediate",
    synopsis: ["fullstackgtm enrich append|refresh|ingest|status …  (run `enrich --help` for full options)"],
    detail:
      "Pull (Apollo) or stage (Clay) data, match it to CRM records deterministically, and emit a fill-blanks-only patch plan through the normal dry-run → approve → apply gate. `refresh` re-checks stale stamped fields.",
    seeAlso: ["plans", "apply", "schedule"],
  },

  // Calls → evidence
  call: {
    summary: "transcripts → evidence, rubric scores, deal links, governed writes",
    phase: "Remediate",
    synopsis: ["fullstackgtm call parse|classify|score|link|plan …  (run `call --help` for full options)"],
    detail:
      "`parse` normalizes any transcript into canonical segments + evidence (LLM by default, bring your own key; `--deterministic` for the free baseline). `classify` picks the call type, `score` rates it against the type's rubric, `link` finds the deal, `plan` proposes governed next-step writes.",
    seeAlso: ["plans", "apply"],
  },

  // Govern — the plan/apply spine
  suggest: {
    summary: "derive values for requires_human_* placeholders (evidence-backed)",
    phase: "Govern",
    synopsis: ["fullstackgtm suggest --plan-id <id> | --plan <path> [source options] [--json] [--out <path>]"],
    detail:
      "Read-only. Proposes concrete values with confidence + reasons from snapshot evidence; feed the output to `plans approve --values-from`. Never guesses — low/create/none-confidence entries are left to the human.",
    seeAlso: ["audit", "plans", "apply"],
  },
  plans: {
    summary: "plan lifecycle: list / show / approve / reject saved plans",
    phase: "Govern",
    synopsis: [
      "fullstackgtm plans list [--status <s>] | show <id> | reject <id>",
      "fullstackgtm plans approve <id> --operations <ids|all> [--value <opId>=<v>]",
      "fullstackgtm plans approve <id> --values-from <suggestions.json> [--min-confidence high|low]",
    ],
    detail: "Approval is explicit and per-operation; placeholders need a concrete --value or a suggestion to be approvable.",
    seeAlso: ["audit", "suggest", "apply"],
  },
  apply: {
    summary: "write ONLY explicitly approved operations to a provider",
    phase: "Govern / Verify",
    synopsis: [
      "fullstackgtm apply --plan-id <id> --provider <name>",
      "fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [--value <opId>=<v>]",
    ],
    detail:
      "The only verb that mutates a CRM. Writes only operations approved via `plans approve` or `--approve`, with compare-and-set and readback. Never writes requires_human_* placeholders without a --value override.",
    seeAlso: ["plans", "suggest", "audit-log"],
  },
  "audit-log": {
    summary: "tamper-evident record of apply runs (export / verify)",
    phase: "Verify",
    synopsis: ["fullstackgtm audit-log export [--out <path>] | verify --in <path>"],
    detail: "The Verify/Attribute layer — a signed, append-only record of every applied write.",
    seeAlso: ["apply"],
  },
  merge: {
    summary: "merge multiple plan/snapshot JSONs into one",
    phase: "Govern",
    synopsis: ["fullstackgtm merge --input <a.json> --input <b.json> [...] --out <merged.json> [--json]"],
    seeAlso: ["diff", "audit"],
  },

  // Continuous
  schedule: {
    summary: "declare a cadence for read/plan-side commands (never auto-approves)",
    phase: "Continuous",
    synopsis: ["fullstackgtm schedule add|list|remove|enable|disable|run|install|status …  (run `schedule --help` for full options)"],
    detail:
      "Makes the loop continuous instead of episodic. Read/plan-side allowlist only (audit, snapshot, enrich, market, suggest, report, doctor). Scheduling NEVER auto-approves: apply is schedulable only as `apply --plan-id <id>`, re-checked approved at run time.",
    seeAlso: ["audit", "enrich", "apply"],
  },

  // Market intelligence
  market: {
    summary: "live competitive category map (capture → classify → drift → report)",
    phase: "Intelligence",
    synopsis: ["fullstackgtm market init|capture|classify|worksheet|observe|fronts|axes|overlay|scale|report|refresh …  (run `market --help` for full options)"],
    detail:
      "Capture vendor pages (content-addressed), classify intensity per claim (LLM bring-your-own-key, or fill the worksheet with any agent), then compute deterministic front states and drift. Every quoted span is verified verbatim against the stored capture before it's accepted.",
    seeAlso: [],
  },
};

// Verbs that print their own richer multi-subcommand help; runCli routes their
// `--help` to themselves, so commandHelp() only renders these via `help <verb>`.
const BESPOKE_HELP = ["call", "market", "enrich", "bulk-update", "schedule"];

// Lifecycle-grouped front door. One line per verb, organized by the
// Prevent→Detect→Remediate→Verify loop so a new user sees ~6 jobs, not 22 verbs.
function shortUsage() {
  const groups: Array<[string, string[]]> = [
    ["Setup & health", ["login", "logout", "doctor", "profiles", "health"]],
    ["Detect — read-only", ["audit", "report", "snapshot", "diff", "rules"]],
    ["Prevent — gate writes", ["resolve"]],
    ["Remediate — governed writes", ["fix", "bulk-update", "dedupe", "reassign", "enrich"]],
    ["Calls → evidence", ["call"]],
    ["Govern — the plan/apply spine", ["suggest", "plans", "apply", "audit-log", "merge"]],
    ["Market intelligence", ["market"]],
    ["Schedule — make it continuous", ["schedule"]],
  ];
  const pad = Math.max(...Object.keys(HELP).map((k) => k.length)) + 2;
  const lines = [
    "FullStackGTM — plan/apply for your GTM stack.",
    "Audit CRM data, propose reviewable patch plans, apply only what you approve.",
    "",
    "Usage: fullstackgtm <command> [options]",
    "",
  ];
  for (const [title, cmds] of groups) {
    lines.push(`${title}:`);
    for (const cmd of cmds) {
      const entry = HELP[cmd];
      if (!entry) continue;
      lines.push(`  ${cmd.padEnd(pad)}${entry.summary}`);
    }
    lines.push("");
  }
  lines.push(
    "Zoom in:  fullstackgtm <command> --help        focused help for one command",
    "Full ref: fullstackgtm help --full             every flag and option",
    "Try it:   fullstackgtm audit --demo            zero-credential demo CRM",
    "",
    "Safety: audits are read-only; apply writes only operations you approve.",
  );
  return lines.join("\n");
}

// Focused help for a single command. Falls back to shortUsage() for anything
// unknown so `--help` never dead-ends on the full wall.
function commandHelp(command: string) {
  const entry = HELP[command];
  if (!entry) return shortUsage();
  const lines = [`fullstackgtm ${command} — ${entry.summary}`, "", "Usage:"];
  for (const s of entry.synopsis) lines.push(`  ${s}`);
  if (entry.detail) lines.push("", entry.detail);
  if (entry.options?.length) {
    lines.push("", "Options:");
    const pad = Math.max(...entry.options.map(([f]) => f.length)) + 2;
    for (const [flag, desc] of entry.options) lines.push(`  ${flag.padEnd(pad)}${desc}`);
  }
  lines.push("", `Lifecycle phase: ${entry.phase}`);
  if (entry.seeAlso?.length) lines.push(`See also: ${entry.seeAlso.join(", ")}`);
  if (BESPOKE_HELP.includes(command)) lines.push("", `Run \`fullstackgtm ${command} --help\` for the full subcommand reference.`);
  lines.push("", "Full reference: fullstackgtm help --full");
  return lines.join("\n");
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function repeatedOption(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function numericOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

async function hubspotConnection(args: string[]) {
  const tokenEnv = option(args, "--token-env");
  if (tokenEnv) {
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`${tokenEnv} is not set.`);
    return { accessToken: token };
  }
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    return { accessToken: process.env.HUBSPOT_ACCESS_TOKEN };
  }
  const stored = await resolveHubspotConnection();
  if (stored) return stored;
  throw new Error(
    "No HubSpot credentials. Run `fullstackgtm login hubspot`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set HUBSPOT_ACCESS_TOKEN. (`fullstackgtm doctor` shows credential status; see the README's \"Connect your CRM\" section for the private-app scopes to grant.)",
  );
}

async function salesforceConnection() {
  if (process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL) {
    return {
      accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
    };
  }
  const stored = await resolveSalesforceConnection();
  if (stored) return stored;
  throw new Error(
    "No Salesforce credentials. Run `fullstackgtm login salesforce`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL. (`fullstackgtm doctor` shows credential status; device-flow login needs an admin-created Connected App — see the README's \"Connect your CRM\" section.)",
  );
}

async function connectorFor(provider: string, args: string[]): Promise<GtmConnector> {
  if (provider === "hubspot") {
    const connection = await hubspotConnection(args);
    return createHubspotConnector({
      getAccessToken: () => connection.accessToken,
      fieldMappings: (connection.fieldMappings as FieldMappings | undefined) ?? undefined,
      // Point at a mock/proxy HubSpot (tests, evals, request-recording).
      apiBaseUrl: process.env.HUBSPOT_API_BASE_URL,
    });
  }
  if (provider === "salesforce") {
    const connection = await salesforceConnection();
    return createSalesforceConnector({
      getConnection: () => connection,
      fieldMappings:
        ((connection as { fieldMappings?: unknown }).fieldMappings as
          | FieldMappings
          | undefined) ?? undefined,
    });
  }
  if (provider === "stripe") {
    const key =
      process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
    if (!key) {
      throw new Error(
        "No Stripe credentials. Run `echo \"$STRIPE_KEY\" | fullstackgtm login stripe` or set STRIPE_SECRET_KEY. A restricted key with read access to Customers and Subscriptions is enough. (`fullstackgtm doctor` shows credential status.)",
      );
    }
    return createStripeConnector({ getApiKey: () => key });
  }
  throw new Error(
    `Unknown provider: ${provider}. Supported providers: hubspot, salesforce, stripe`,
  );
}

async function readSnapshot(args: string[]): Promise<CanonicalGtmSnapshot> {
  const provider = option(args, "--provider");
  if (provider) {
    const connector = await connectorFor(provider, args);
    return connector.fetchSnapshot();
  }
  if (args.includes("--demo")) {
    return generateDemoSnapshot({
      seed: numericOption(args, "--seed"),
      today: option(args, "--today") ?? undefined,
    });
  }
  if (args.includes("--sample")) return sampleSnapshot;
  const input = option(args, "--input");
  if (!input) {
    throw new Error(
      "No data source. Pass one of: --provider <hubspot|salesforce|stripe> (live, read-only), " +
        "--input <snapshot.json> (a saved snapshot), --demo (a generated messy CRM), or " +
        "--sample (the tiny built-in fixture). Refusing to silently audit sample data.",
    );
  }
  const path = resolve(process.cwd(), input);
  return JSON.parse(readFileSync(path, "utf8")) as CanonicalGtmSnapshot;
}

function selectedRules(args: string[], baseRules = builtinAuditRules) {
  const requested = option(args, "--rules");
  if (!requested) return baseRules;
  const ids = requested.split(",").map((id) => id.trim()).filter(Boolean);
  const known = new Map(baseRules.map((rule) => [rule.id, rule]));
  const rules = ids.map((id) => {
    const rule = known.get(id);
    if (!rule) {
      throw new Error(
        `Unknown rule: ${id}. Available rules: ${baseRules.map((r) => r.id).join(", ")}`,
      );
    }
    return rule;
  });
  return rules;
}

const SEVERITY_RANK: Record<AuditFindingSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function failOnThreshold(args: string[]): AuditFindingSeverity | null {
  const value = option(args, "--fail-on");
  if (!value) return null;
  if (value !== "info" && value !== "warning" && value !== "critical") {
    throw new Error("--fail-on must be one of: info, warning, critical");
  }
  return value;
}

async function snapshotCommand(args: string[]) {
  const since = option(args, "--since");
  let snapshot: CanonicalGtmSnapshot;
  if (since) {
    const provider = option(args, "--provider");
    if (!provider) throw new Error("--since requires --provider <name>");
    const connector = await connectorFor(provider, args);
    if (!connector.fetchChanges) {
      throw new Error(`The ${provider} connector does not support incremental fetch.`);
    }
    snapshot = await connector.fetchChanges(since);
  } else {
    snapshot = await readSnapshot(args);
  }
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const archive = option(args, "--archive");
  if (archive) {
    const dir = resolve(process.cwd(), archive);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const fileName = `${snapshot.provider}-${snapshot.generatedAt.replace(/[:.]/g, "-")}.json`;
    const path = resolve(dir, fileName);
    writeFileSync(path, serialized);
    console.log(`Archived snapshot to ${path}`);
    return;
  }
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), serialized);
    console.log(
      `Wrote snapshot (${snapshot.users.length} users, ${snapshot.accounts.length} accounts, ` +
        `${snapshot.contacts.length} contacts, ${snapshot.deals.length} deals, ` +
        `${snapshot.activities.length} activities) to ${out}`,
    );
  } else {
    console.log(serialized.trimEnd());
  }
}

// #2 (dx-punch-list): every read verb points forward. `audit` is the keystone —
// `audit --demo` is the most-run first command and used to dead-end on a blank
// line. Context-aware guidance mirrors doctor's "Next step" and fix's chaining,
// stepping the user along Detect → Govern → apply. Printed to stderr so stdout
// stays clean for pipes/--out; suppressed under --json (machine/agent context).
function auditNextStep(args: string[], plan: PatchPlan): string {
  const provider = option(args, "--provider");
  const usingLiveData = Boolean(provider) || Boolean(option(args, "--input"));
  const saved = args.includes("--save");
  const count = plan.findings.length;

  if (count === 0) {
    return [
      "✓ No findings — this snapshot is clean. Nothing to apply.",
      "  Keep it clean: gate new records with `fullstackgtm resolve`,",
      "  and schedule a recurring check with `fullstackgtm schedule add ...`.",
    ].join("\n");
  }

  const head = `${count} finding${count === 1 ? "" : "s"} — a dry-run plan. Nothing was written.`;
  if (!usingLiveData) {
    return [
      head,
      "Next:",
      "  • Client-ready writeup:  fullstackgtm report --demo",
      "  • Run on your CRM:       fullstackgtm login hubspot  →  fullstackgtm audit --provider hubspot --save",
    ].join("\n");
  }
  if (!saved) {
    return [
      head,
      "Next: persist it with --save, then suggest → approve → apply:",
      `  fullstackgtm audit --provider ${provider ?? "<name>"} --save`,
    ].join("\n");
  }
  // --save already confirmed the plan id above; chain the governed spine.
  const providerFlag = provider ? ` --provider ${provider}` : "";
  return [
    head,
    "Next: derive values, approve the safe ones, apply:",
    `  fullstackgtm suggest --plan-id ${plan.id}${providerFlag} --out suggestions.json`,
    `  fullstackgtm plans approve ${plan.id} --values-from suggestions.json`,
    `  fullstackgtm apply --plan-id ${plan.id}${providerFlag}`,
  ].join("\n");
}

async function audit(args: string[]) {
  const threshold = failOnThreshold(args);
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded));
  const snapshot = await readSnapshot(args);

  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;
  const staleDealDays = numericOption(args, "--stale-days");
  if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;

  const plan = auditSnapshot(snapshot, policy, rules);
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (args.includes("--save")) {
    await createFilePlanStore().save(plan);
    // Engagement workspace: stamp the per-profile health timeline + snapshot so
    // the org accrues a continuous record from the verb people already run.
    // Honor --today (audit is deterministic under it); fall back to wall-clock.
    const health = computeHealth(plan, snapshot, today ?? new Date().toISOString());
    appendHealthEntry(health);
    saveWorkspaceSnapshot(plan.id, snapshot);
    console.error(
      `Saved plan ${plan.id}. Health ${health.score}/100 recorded (\`fullstackgtm health\`). ` +
        `Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`.`,
    );
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    // Default to the summary view (rule table + counts); the full per-operation
    // dump is opt-in via --full or, for a deliverable, `report`. (dx-punch-list #3)
    console.log(patchPlanToMarkdown(plan, { summary: !args.includes("--full") }));
    console.error(`\n${auditNextStep(args, plan)}`);
  }

  if (
    threshold &&
    plan.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])
  ) {
    process.exitCode = 2;
  }
}

/**
 * Roll up the active profile's health timeline (accrued by `audit --save`):
 * current deterministic score, change since the last audit, and per-rule
 * deltas. Read-only — it only reads `health.jsonl`, never re-audits.
 */
function healthCommand(args: string[]) {
  const profile = activeWorkspaceProfile();
  const rollup = summarizeHealth(readHealthTimeline(), profile);
  if (!rollup) {
    if (args.includes("--json")) {
      console.log(JSON.stringify({ profile, auditCount: 0 }, null, 2));
    } else {
      console.log(
        `No audits recorded yet for profile "${profile}".\n` +
          "Start the timeline: `fullstackgtm audit --provider <name> --save`" +
          (profile === "default" ? "" : ` --profile ${profile}`) +
          ".",
      );
    }
    return;
  }
  console.log(args.includes("--json") ? JSON.stringify(rollup, null, 2) : healthToMarkdown(rollup));
}

/**
 * Render an audit as a client-facing deliverable. Same sources and audit
 * options as `audit`; `--plan` instead renders an existing plan JSON without
 * re-fetching (useful for a plan produced earlier or by another machine).
 */
async function reportCommand(args: string[]) {
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const configuredRules = await resolveConfiguredRules(loaded);

  let plan: PatchPlan;
  let snapshot: CanonicalGtmSnapshot | undefined;
  const planPath = option(args, "--plan");
  if (planPath) {
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8")) as PatchPlan;
    const input = option(args, "--input");
    if (input) {
      snapshot = JSON.parse(
        readFileSync(resolve(process.cwd(), input), "utf8"),
      ) as CanonicalGtmSnapshot;
    }
  } else {
    snapshot = await readSnapshot(args);
    const policy = mergePolicy(defaultPolicy(), loaded?.config);
    const today = option(args, "--today");
    if (today) policy.today = today;
    const staleDealDays = numericOption(args, "--stale-days");
    if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;
    plan = auditSnapshot(snapshot, policy, selectedRules(args, configuredRules));
  }

  const reportOptions: ReportOptions = {
    title: option(args, "--title") ?? undefined,
    clientName: option(args, "--client") ?? undefined,
    preparedBy: option(args, "--prepared-by") ?? undefined,
    date: option(args, "--today") ?? undefined,
    maxExamplesPerRule: numericOption(args, "--max-examples"),
    rules: configuredRules,
    snapshot,
  };

  const out = option(args, "--out");
  const format = option(args, "--format") ?? (out?.endsWith(".html") ? "html" : "markdown");
  if (format !== "markdown" && format !== "html") {
    throw new Error("--format must be markdown or html");
  }
  const rendered =
    format === "html"
      ? auditReportToHtml(plan, reportOptions)
      : auditReportToMarkdown(plan, reportOptions);

  if (out) {
    writeFileSync(resolve(process.cwd(), out), rendered);
    console.log(`Wrote ${format} report (${plan.findings.length} findings) to ${out}`);
  } else {
    console.log(rendered.trimEnd());
  }
}

async function rulesCommand(args: string[]) {
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = await resolveConfiguredRules(loaded);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        rules.map(({ id, title, description, category }) => ({
          id,
          title,
          description,
          category: category ?? "uncategorized",
        })),
        null,
        2,
      ),
    );
    return;
  }
  for (const rule of rules) {
    console.log(`${rule.id} [${rule.category ?? "uncategorized"}]\n  ${rule.title}\n  ${rule.description}\n`);
  }
}

/**
 * Provider error bodies can echo request parameters (including secrets) and
 * land in logs. Surface only the status and, when present, a known-safe error
 * description field — never the raw body.
 */
function safeStatus(response: Response): string {
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

function parseValueOverrides(args: string[]) {
  const valueOverrides: Record<string, unknown> = {};
  for (const pair of repeatedOption(args, "--value")) {
    const separator = pair.indexOf("=");
    if (separator === -1) throw new Error(`--value must look like <operationId>=<value>`);
    valueOverrides[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return valueOverrides;
}

async function callCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`call parse    --transcript <file> [--title t] [--source s] [--model m] [--deterministic] [--json|--ndjson] [--out <path>]
call classify --transcript <file>|--call <parsed.json> [--llm] [--deterministic] [--json] [--list]
call score    --transcript <file>|--call <parsed.json> [--call-type <t>] [--rubric <rubric.json>] [--model m] [--json|--out <path>] [--list-rubrics]
call link     --attendees <a@x.com,...> | --domain <x.com>  [source options] [--json]
call plan     --transcript <file>|--call <parsed.json> --deal <id> [source options] [--save|--json]

classify picks the call type (deterministic signals; --llm for a model tiebreak).
score auto-selects the type-specific rubric from that classification unless you
pass --call-type or --rubric. Call types: ${CALL_TYPE_IDS.join(", ")}.

parse/score default to LLM extraction (Anthropic or OpenAI key via env,
\`login anthropic|openai\`, or a one-time prompt). parse --deterministic is the
free keyword baseline and classify --deterministic needs no key.
score always needs a key (scoring is LLM work).`);
    return;
  }

  const loadParsedCall = async (): Promise<ParsedCall> => {
    const callPath = option(rest, "--call");
    if (callPath) {
      return JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8")) as ParsedCall;
    }
    const transcriptPath = option(rest, "--transcript");
    if (!transcriptPath) throw new Error(`call ${subcommand} requires --transcript <file> or --call <parsed.json>`);
    const raw = readFileSync(resolve(process.cwd(), transcriptPath), "utf8");
    const source = option(rest, "--source") as ParsedCall["sourceSystem"] | undefined;
    const base = {
      title: option(rest, "--title") ?? undefined,
      sourceSystem: source,
      capturedAt: new Date().toISOString(),
    };
    if (rest.includes("--deterministic")) {
      return parseCall(raw, base);
    }
    // LLM extraction is the default: bring-your-own-key (Anthropic or OpenAI).
    const credential = await requireLlmCredential();
    const normalized = normalizeTranscript(raw);
    const { insights, model } = await extractInsightsLlm(normalized, {
      ...credential,
      model: option(rest, "--model") ?? undefined,
      title: base.title,
    });
    return parseCall(raw, {
      ...base,
      insights,
      extractor: `llm:${credential.provider}:${model}`,
    });
  };

  // Reconstruct plain transcript text from either a --transcript file (any
  // dialect, normalized) or a parsed --call JSON. Shared by classify + score.
  const loadTranscriptText = (): string => {
    const transcriptPath = option(rest, "--transcript");
    if (transcriptPath) {
      return normalizeTranscript(readFileSync(resolve(process.cwd(), transcriptPath), "utf8"));
    }
    const callPath = option(rest, "--call");
    if (!callPath) throw new Error(`call ${subcommand} requires --transcript <file> or --call <parsed.json>`);
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8")) as ParsedCall;
    return parsed.segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
  };

  if (subcommand === "classify") {
    if (rest.includes("--list")) {
      const lines = CALL_TYPES.map((d) => `${d.id.padEnd(22)} ${d.name} — ${d.definition}`);
      console.log(rest.includes("--json") ? JSON.stringify(CALL_TYPES, null, 2) : lines.join("\n"));
      return;
    }
    const transcriptText = loadTranscriptText();
    const title = option(rest, "--title") ?? undefined;
    const deterministic = classifyCall(transcriptText);
    // LLM tiebreak: explicit --llm, or auto when the deterministic pass is unsure
    // and a key is available (never required — deterministic always answers).
    const wantLlm = rest.includes("--llm") || (!rest.includes("--deterministic") && deterministic.confidence !== "high" && Boolean(resolveLlmCredential()));
    let result: {
      type: CallType;
      confidence: string;
      reason: string;
      method: string;
      candidates?: typeof deterministic.candidates;
      model?: string;
    } = deterministic;
    if (wantLlm) {
      const credential = await requireLlmCredential("score");
      const llm = await classifyCallLlm(transcriptText, CALL_TYPES, {
        ...credential,
        model: option(rest, "--model") ?? undefined,
        title,
      });
      result = { type: llm.type, confidence: "high", reason: llm.reason, method: "llm", model: llm.model };
    }
    if (rest.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const def = CALL_TYPES.find((d) => d.id === result.type);
    console.log(`Call type: ${def?.name ?? result.type} (${result.type})`);
    console.log(`Confidence: ${result.confidence} · via ${result.method}${result.model ? ` (${result.model})` : ""}`);
    console.log(`Why: ${result.reason}`);
    if (result.method === "deterministic" && deterministic.candidates.length > 1) {
      const others = deterministic.candidates.slice(1, 4).map((c) => `${c.type} (${c.score})`).join(", ");
      console.log(`Other matches: ${others}`);
    }
    console.log(`\nScore it with this rubric: fullstackgtm call score ${option(rest, "--transcript") ? `--transcript ${option(rest, "--transcript")}` : `--call ${option(rest, "--call")}`} --call-type ${result.type}`);
    return;
  }

  if (subcommand === "parse") {
    const parsed = await loadParsedCall();
    const outPath = option(rest, "--out");
    if (outPath) writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(parsed, null, 2)}\n`);
    if (rest.includes("--ndjson")) {
      // One flat row per insight — warehouse-friendly (e.g. Snowflake COPY).
      for (const insight of parsed.insights) {
        console.log(
          JSON.stringify({
            call_id: parsed.id,
            call_title: parsed.title ?? null,
            source_system: parsed.sourceSystem,
            extractor: parsed.extractor,
            type: insight.type,
            title: insight.title,
            text: insight.text,
            evidence: insight.evidence,
            speaker: insight.speaker ?? null,
            confidence: insight.confidence,
            importance: insight.importance,
          }),
        );
      }
      return;
    }
    if (rest.includes("--json") || outPath) {
      if (!outPath) console.log(JSON.stringify(parsed, null, 2));
      return;
    }
    console.log(`Call ${parsed.id}${parsed.title ? ` — ${parsed.title}` : ""} (${parsed.sourceSystem})`);
    console.log(`${parsed.segments.length} segments · ${parsed.insights.length} insights (${parsed.summary.highImportance} high-importance)\n`);
    for (const insight of parsed.insights) {
      console.log(`[${insight.type}] (importance ${insight.importance}) ${insight.text}`);
    }
    return;
  }

  if (subcommand === "link") {
    const attendees = option(rest, "--attendees");
    const domain = option(rest, "--domain");
    if (!attendees && !domain) throw new Error("call link requires --attendees <emails,comma-separated> and/or --domain <example.com>");
    const snapshot = await readSnapshot(rest);
    const suggestion = suggestCallDeal(snapshot, {
      attendeeEmails: attendees?.split(",").map((e) => e.trim()).filter(Boolean),
      domain: domain ?? undefined,
    });
    if (rest.includes("--json")) {
      console.log(JSON.stringify(suggestion, null, 2));
    } else {
      const marker = suggestion.confidence === "high" ? "✓" : suggestion.confidence === "low" ? "~" : "✗";
      console.log(`${marker} [${suggestion.confidence}] ${suggestion.dealId ?? "no match"}${suggestion.dealName ? ` — ${suggestion.dealName}` : ""}`);
      console.log(`    ${suggestion.reason}`);
    }
    if (suggestion.confidence === "none") process.exitCode = 1;
    return;
  }

  if (subcommand === "plan") {
    const dealId = option(rest, "--deal");
    if (!dealId) throw new Error("call plan requires --deal <dealId> (use `call link` to find it)");
    const parsed = await loadParsedCall();
    const snapshot = await readSnapshot(rest);
    const deal = snapshot.deals.find((row) => row.id === dealId);
    if (!deal) throw new Error(`Deal ${dealId} is not in the snapshot — check the id or the snapshot source.`);

    const nextSteps = parsed.insights.filter((insight) => insight.type === "next_step");
    if (nextSteps.length === 0) {
      console.log("No next-step insights in this call — nothing to plan. (Other insight types are evidence, not writes.)");
      return;
    }
    const [top, ...others] = nextSteps;
    const proposed = top.text.trim().slice(0, 255);
    const current = deal.nextStep?.trim() ?? "";
    const plan = buildCallPlan(parsed, deal, proposed, current, others.slice(0, 3));

    if (rest.includes("--save")) {
      await createFilePlanStore().save(plan);
      console.log(
        `Saved plan ${plan.id}. Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`, then \`fullstackgtm apply --plan-id ${plan.id} --provider <name>\`.`,
      );
      return;
    }
    console.log(rest.includes("--json") ? JSON.stringify(plan, null, 2) : patchPlanToMarkdown(plan));
    return;
  }

  if (subcommand === "score") {
    if (rest.includes("--list-rubrics")) {
      console.log(JSON.stringify(rubricPresets(), null, 2));
      return;
    }
    // Explicit-rubric problems surface before any credential or API work.
    const rubricPath = option(rest, "--rubric");
    let rubric: Rubric | undefined;
    if (rubricPath) {
      const rubricRaw = readFileSync(resolve(process.cwd(), rubricPath), "utf8");
      try {
        rubric = parseRubric(rubricRaw);
      } catch (error) {
        throw new Error(
          `${rubricPath} is not a valid rubric: ${error instanceof Error ? error.message : String(error)} Expected JSON like { "scale": 5, "dimensions": [{ "name": "...", "weight": 1, "rubric": "..." }] }.`,
        );
      }
    }
    const callTypeOpt = option(rest, "--call-type") as CallType | undefined;
    if (callTypeOpt && !CALL_TYPE_IDS.includes(callTypeOpt)) {
      throw new Error(`Unknown --call-type "${callTypeOpt}". One of: ${CALL_TYPE_IDS.join(", ")}.`);
    }
    const credential = await requireLlmCredential("score");
    const transcriptPath = option(rest, "--transcript");
    let transcriptText: string;
    let title = option(rest, "--title") ?? undefined;
    if (transcriptPath) {
      transcriptText = normalizeTranscript(readFileSync(resolve(process.cwd(), transcriptPath), "utf8"));
    } else {
      const callPath = option(rest, "--call");
      if (!callPath) throw new Error("call score requires --transcript <file> or --call <parsed.json>");
      const parsed = JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8")) as ParsedCall;
      transcriptText = parsed.segments
        .map((segment) => (segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text))
        .join("\n");
      title = title ?? parsed.title;
    }
    // Rubric selection: explicit --rubric wins, then --call-type, else the
    // deterministic classifier picks the type-specific preset. No generic
    // discovery rubric silently applied to a renewal anymore.
    if (!rubric) {
      const type = callTypeOpt ?? classifyCall(transcriptText).type;
      rubric = rubricForCallType(type, DEFAULT_RUBRIC);
      if (!rest.includes("--json")) {
        const how = callTypeOpt ? `--call-type ${callTypeOpt}` : `auto-classified as ${type}`;
        console.error(`Scoring with the "${rubric.name ?? "Generic"}" rubric (${how}). Override with --rubric <file> or --call-type <type>.`);
      }
    }
    const scorecard = await scoreCallLlm(transcriptText, rubric, {
      ...credential,
      model: option(rest, "--model") ?? undefined,
      title,
    });
    const outPath = option(rest, "--out");
    if (outPath) writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(scorecard, null, 2)}\n`);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(scorecard, null, 2));
      return;
    }
    console.log(renderScorecard(scorecard, title));
    return;
  }

  throw new Error(`call supports: parse, classify, link, plan, score (got ${subcommand ?? "nothing"})`);
}

/**
 * First-touch key onboarding: env vars win, then the credential store; on a
 * TTY a missing key is captured once (validated, stored 0600 like provider
 * logins). Non-interactive contexts get an actionable error instead.
 */
async function requireLlmCredential(
  command: "parse" | "score" | "market classify" = "parse",
): Promise<{ provider: LlmProvider; apiKey: string }> {
  const resolved = resolveLlmCredential();
  if (resolved) return resolved;
  // Scoring is inherently LLM work — there is no keyword fallback to suggest.
  const fallbackHint =
    command === "parse"
      ? ", or pass --deterministic for the free keyword baseline"
      : command === "score"
        ? " (call score has no non-LLM mode)"
        : ", or classify by hand: `market worksheet --vendor <id>` then `market observe --from`";
  const work = command === "score" ? "scoring" : command === "parse" ? "extraction" : "classification";
  if (!process.stdin.isTTY) {
    throw new Error(
      `LLM ${work} needs an API key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run \`echo "$KEY" | fullstackgtm login anthropic\` (or \`login openai\`) once${fallbackHint}.`,
    );
  }
  console.error("LLM parsing needs an API key (Anthropic or OpenAI) — yours, used directly with the provider.");
  console.error(`Paste it once; it is validated and stored at ${credentialsPath()} (file mode 0600), like CRM logins.`);
  console.error("(Alternatives: set ANTHROPIC_API_KEY / OPENAI_API_KEY, or pass --deterministic for the free keyword baseline.)\n");
  const apiKey = await readSecret("API key (sk-ant-... or sk-...): ");
  const provider = detectProviderFromKey(apiKey);
  const validation = await validateLlmKey(provider, apiKey);
  if (!validation.ok) throw new Error(`${provider} rejected the key: ${validation.detail}`);
  const now = new Date().toISOString();
  storeCredential(provider, { kind: "api_key", accessToken: apiKey, createdAt: now, updatedAt: now });
  console.error(`Stored ${provider} key (${validation.detail}). Future runs use it automatically; remove with \`fullstackgtm logout ${provider}\`.\n`);
  return { provider, apiKey };
}

function renderScorecard(scorecard: CallScorecard, title?: string): string {
  const bandText = scorecard.band ? ` — ${scorecard.band.label}` : "";
  const rubricLine = scorecard.rubricName ? `Rubric: ${scorecard.rubricName}${scorecard.callType ? ` (${scorecard.callType})` : ""}` : "";
  const lines = [
    `# Coaching Scorecard${title ? ` — ${title}` : ""}`,
    "",
    `**Overall: ${scorecard.overallScore}/${scorecard.scale}${bandText}** (model: ${scorecard.model})`,
    ...(scorecard.band?.meaning ? [`> ${scorecard.band.meaning}`] : []),
    ...(rubricLine ? ["", `_${rubricLine}_`] : []),
    "",
    "| Dimension | Score | | Coaching note |",
    "| --- | --- | --- | --- |",
  ];
  for (const dim of scorecard.dimensions) {
    const filled = Math.round((dim.score / dim.maxScore) * 5);
    const bar = "█".repeat(filled) + "░".repeat(5 - filled);
    lines.push(`| ${dim.name} | ${dim.score}/${dim.maxScore} | ${bar} | ${dim.coachingNote} |`);
  }
  if (scorecard.highlights.length) {
    lines.push("", "**Highlights**");
    for (const h of scorecard.highlights) lines.push(`- ${h}`);
  }
  if (scorecard.missedItems.length) {
    lines.push("", "**Missed**");
    for (const m of scorecard.missedItems) lines.push(`- ${m}`);
  }
  return lines.join("\n");
}

function buildCallPlan(
  parsed: ParsedCall,
  deal: { id: string; name: string; nextStep?: string },
  proposed: string,
  current: string,
  extraNextSteps: ExtractedCallInsight[],
): PatchPlan {
  const findings: PatchPlan["findings"] = [];
  const operations: PatchPlan["operations"] = [];
  const nextStepEvidence = parsed.evidence.filter(
    (item) => (item.metadata as { insightType?: string } | undefined)?.insightType === "next_step",
  );
  const evidenceIds = nextStepEvidence.map((item) => item.id);

  if (current.toLowerCase() !== proposed.toLowerCase()) {
    findings.push({
      id: `finding_${parsed.id.replace(/^call_/, "")}_${deal.id}`,
      objectType: "deal",
      objectId: deal.id,
      ruleId: "call-next-step-not-reflected-in-crm",
      type: "call_next_step_not_reflected_in_crm",
      title: "Call agreed a next step the CRM does not reflect",
      severity: "warning",
      summary: current
        ? `The call produced "${proposed}" but ${deal.name}'s next step still reads "${current}".`
        : `The call produced "${proposed}" but ${deal.name} has no next step set.`,
      recommendation: "Review the evidence and approve the next-step update.",
      evidenceIds,
      currentCrmValue: current || null,
      proposedValue: proposed,
    });
    operations.push({
      id: `op_${parsed.id.replace(/^call_/, "")}_next`,
      objectType: "deal",
      objectId: deal.id,
      operation: "set_field",
      field: "nextStep",
      beforeValue: current || null,
      afterValue: proposed,
      reason: `Call evidence: ${nextStepEvidence[0]?.text.slice(0, 200) ?? proposed}`,
      sourceRuleOrPolicy: "call_intelligence.next_step",
      riskLevel: "high",
      approvalRequired: true,
      rollback: "Restore the previous deal next step (the before value) if the update is wrong.",
      evidenceIds,
    });
  }
  for (const [index, extra] of extraNextSteps.entries()) {
    operations.push({
      id: `op_${parsed.id.replace(/^call_/, "")}_task${index}`,
      objectType: "deal",
      objectId: deal.id,
      operation: "create_task",
      field: "follow_up_task",
      beforeValue: null,
      afterValue: extra.text.trim().slice(0, 255),
      reason: `Additional commitment from the call: ${extra.evidence.slice(0, 160)}`,
      sourceRuleOrPolicy: "call_intelligence.follow_up",
      riskLevel: "low",
      approvalRequired: true,
      rollback: "Close or delete the created task.",
    });
  }
  return {
    id: `patch_plan_${parsed.id.replace(/^call_/, "")}${deal.id.slice(-4)}`,
    title: `Call evidence plan${parsed.title ? ` — ${parsed.title}` : ""} → ${deal.name}`,
    createdAt: new Date().toISOString(),
    status: "needs_approval",
    dryRun: true,
    summary: `${findings.length} finding(s) and ${operations.length} proposed operation(s) from call ${parsed.id}.`,
    findings,
    evidence: parsed.evidence,
    operations,
  };
}

/**
 * The market map: claim taxonomy in a reviewable config file, page captures
 * and append-only observations under the profile home, deterministic front
 * states and reports computed from the store. Intensity readings enter as
 * proposals through two channels — `classify` (LLM, bring-your-own-key, the
 * call-intelligence pattern) and `worksheet`/`observe` (an agent or human
 * fills the worksheet) — and BOTH pass the same mechanical gate: every quoted
 * span is verified verbatim against the stored capture it cites.
 */
async function marketCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  const configPath = () => resolve(process.cwd(), option(rest, "--config") ?? "market.config.json");

  // Catch --help anywhere before loadMarketConfig/credential checks run —
  // several subcommands (capture, refresh) have side effects on bare invocation.
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage:
market init --category <name> [--out <path>]   write a starter market.config.json
market init --category <name> --auto --vendor <url> [--vendor <url>...] [--anchor <url>] [--max-claims n]
                                               LLM-propose vendors + claim taxonomy from seed pages (needs an API key)
market capture [--config <path>] [--run <label>]
market classify [--run <label>] [--capture-run <label>] [--vendor <id>] [--model m] [--out <path>]
market worksheet --vendor <id> [--capture-run <label>] [--out <path>]
market observe --from <observations.json> [--unverified]
market fronts [--config <path>] [--run <label>] [--diff <prior-run>] [--json]
market axes [--config <path>] [--run <label>] [--json]
market overlay --snapshot <crm.json> [--calls <parsed.json|manifest.json>]... [--prior-run <label>]
               [--min-mentions N] [--promote-lift X] [--json] [--save --task-account <id>|--task-deal <id>]
market scale [--config <path>] [--json]
market report [--config <path>] [--run <label>] [--format md|html] [--out <path>]
market refresh [--run <label>] [--model m]     capture → classify → fronts drift → HTML report

overlay is the directive layer: joins the map to YOUR CRM ground truth and
emits OCCUPY / PROMOTE / URGENT / RETREAT directives, each carrying ≥1
observation and ≥1 CRM statistic with its sample size. Claim mentions are
deterministic word-boundary matches of each claim's "terms" against call
documents (call parse output); small samples refuse to become strategy
(--min-mentions, default 3). --save turns directives into approval-gated
create_task operations through the normal plans → approve → apply gate.

scale prints the relative scale index that sizes the report's bubbles when
vendors carry scaleSignals (citable review counts / headcount / revenue —
a within-set index, never "market share" unqualified).

axes runs the axis-discovery math: PCA over the vendor × claim intensity
matrix (PC1 = the category's primary axis, PC2 = the max-differentiation
direction orthogonal to it), triangulation of configured axes against the
PCs, and an orthogonality screen (|r|>0.75 = one axis twice). Axes live in
the config as claim-scoring rubrics; the report's strategic map and axis
lab render from them.

classify uses your Anthropic/OpenAI key (like call parse) to read the stored
captures and propose intensity readings; worksheet is the no-key path (an
agent or human fills it, submits via observe). Either way, every quoted span
is verified character-for-character against the capture it cites before the
observation is accepted — quotes that aren't on the page bounce.

The taxonomy (vendors + claims) is config you review and version; captures
and observations live under ~/.fullstackgtm/market/<category> (profile-scoped,
one client's category intel never bleeds into another's). Front states are
recomputed deterministically on every invocation — never stored.`);
    return;
  }

  if (subcommand === "init") {
    const category = option(rest, "--category");
    if (!category) throw new Error("market init requires --category <name>");
    const outPath = resolve(process.cwd(), option(rest, "--out") ?? "market.config.json");
    if (existsSync(outPath)) throw new Error(`${outPath} already exists — refusing to overwrite`);

    if (rest.includes("--auto")) {
      const vendorUrls = repeatedOption(rest, "--vendor");
      if (vendorUrls.length === 0) {
        throw new Error("market init --auto requires at least one --vendor <url> (the competitor homepages to seed from)");
      }
      const anchorUrl = option(rest, "--anchor");
      const credential = await requireLlmCredential("market classify");
      console.error(`Capturing ${vendorUrls.length} seed page(s) and proposing a claim taxonomy with ${credential.provider}…`);
      const { config, unreadableVendorIds, model } = await suggestMarketConfig({
        category,
        vendors: vendorUrls.map((url) => ({ url, anchor: anchorUrl ? url === anchorUrl : false })),
        llm: { ...credential, model: option(rest, "--model") ?? undefined },
        maxClaims: numericOption(rest, "--max-claims"),
      });
      writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
      if (unreadableVendorIds.length > 0) {
        console.error(`Note: no readable text for ${unreadableVendorIds.join(", ")} — excluded from taxonomy grounding.`);
      }
      console.log(
        `Wrote ${outPath}: ${config.vendors.length} vendors, ${config.claims.length} proposed claims (${model}). Review it, then: fullstackgtm market refresh`,
      );
      return;
    }

    writeFileSync(outPath, `${JSON.stringify(starterMarketConfig(category), null, 2)}\n`);
    console.log(`Wrote ${outPath}. Fill in vendors and claims, then: fullstackgtm market capture`);
    return;
  }

  const config = loadMarketConfig(configPath());
  const store = createFileObservationStore(config.category);

  if (subcommand === "capture") {
    const result = await captureMarket(config, { runLabel: option(rest, "--run") ?? "run-1" });
    for (const entry of result.entries) {
      const flag = entry.captureHash && entry.textChars > 500 ? "" : "  <-- thin/empty";
      console.log(
        `${entry.vendorId.padEnd(16)} ${entry.kind.padEnd(8)} ${String(entry.httpStatus ?? "ERR").padEnd(4)} ${String(entry.textChars).padStart(7)} chars  ${entry.url}${flag}`,
      );
    }
    console.log(`\nmanifest: ${result.manifestPath}`);
    return;
  }

  if (subcommand === "observe") {
    const fromPath = option(rest, "--from");
    if (!fromPath) throw new Error("market observe requires --from <observations.json>");
    const set = JSON.parse(readFileSync(resolve(process.cwd(), fromPath), "utf8")) as ObservationSet;
    const problems = validateObservationSet(config, set);
    if (problems.length > 0) {
      console.error(`Rejected: ${problems.length} problem(s)`);
      for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    if (!rest.includes("--unverified")) {
      const { textByHash } = loadCaptureTexts(config.category);
      const failures = verifyEvidenceSpans(set.observations, textByHash);
      if (failures.length > 0) {
        console.error(`Rejected: ${failures.length} evidence span(s) failed verification against the stored captures`);
        for (const failure of failures.slice(0, 20)) {
          console.error(`  - ${failure.vendorId} × ${failure.claimId}: ${failure.problem}`);
        }
        console.error("Quotes must be copied verbatim from the captured pages. (--unverified skips this gate when the captures genuinely live elsewhere.)");
        process.exitCode = 1;
        return;
      }
    }
    await store.append(set);
    console.log(`Appended ${set.runLabel}: ${set.observations.length} observations (${set.extractor})`);
    return;
  }

  if (subcommand === "worksheet") {
    const vendorId = option(rest, "--vendor");
    if (!vendorId) throw new Error("market worksheet requires --vendor <id>");
    const worksheet = buildWorksheet(config, vendorId, { captureRun: option(rest, "--capture-run") ?? undefined });
    const outPath = option(rest, "--out");
    const payload = `${JSON.stringify(worksheet, null, 2)}\n`;
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), payload);
      console.log(`Wrote ${outPath} (${worksheet.pages.length} captured pages, ${worksheet.claims.length} claims)`);
    } else {
      console.log(payload);
    }
    return;
  }

  if (subcommand === "classify") {
    const credential = await requireLlmCredential("market classify");
    const vendorFilter = option(rest, "--vendor");
    const outPath = option(rest, "--out");
    if (vendorFilter && !outPath) {
      throw new Error(
        "market classify --vendor produces a partial set (coverage validation would reject it) — pass --out <path> to inspect/merge it by hand",
      );
    }
    const result = await classifyMarket(config, {
      llm: { ...credential, model: option(rest, "--model") ?? undefined },
      runLabel: option(rest, "--run") ?? option(rest, "--capture-run") ?? "run-1",
      captureRun: option(rest, "--capture-run") ?? undefined,
      vendors: vendorFilter ? [vendorFilter] : undefined,
    });
    if (result.retriedVendorIds.length > 0) {
      console.error(`Span verification bounced ${result.retriedVendorIds.join(", ")} once; retry passed.`);
    }
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(result.set, null, 2)}\n`);
      console.log(`Wrote ${outPath}: ${result.set.observations.length} verified observations (${result.set.extractor})`);
      return;
    }
    const problems = validateObservationSet(config, result.set);
    if (problems.length > 0) {
      throw new Error(`Classified set failed validation: ${problems.slice(0, 5).join("; ")}`);
    }
    await store.append(result.set);
    console.log(
      `Appended ${result.set.runLabel}: ${result.set.observations.length} observations, every span verified (${result.set.extractor})`,
    );
    return;
  }

  if (subcommand === "refresh") {
    const credential = await requireLlmCredential("market classify");
    const runLabel = option(rest, "--run") ?? `run-${new Date().toISOString().slice(0, 10)}`;
    const prior = await store.latest();
    console.log(`Capturing ${config.vendors.length} vendors as ${runLabel}…`);
    const captured = await captureMarket(config, { runLabel });
    const failed = captured.entries.filter((entry) => !entry.captureHash);
    if (failed.length > 0) console.log(`${failed.length} page(s) failed/empty — affected cells will verify against remaining pages or read unobservable.`);
    console.log(`Classifying with ${credential.provider}…`);
    const result = await classifyMarket(config, {
      llm: { ...credential, model: option(rest, "--model") ?? undefined },
      runLabel,
      captureRun: runLabel,
    });
    await store.append(result.set);
    const fronts = computeFrontStates(config, result.set);
    if (prior) {
      const drift = diffFrontStates(computeFrontStates(config, prior), fronts);
      if (drift.length === 0) console.log(`No front changes since ${prior.runLabel}.`);
      for (const change of drift) console.log(`CHANGED   ${change.claimId}: ${change.before} → ${change.after}`);
    }
    const outPath = option(rest, "--out") ?? `${config.category}-${runLabel}.html`;
    writeFileSync(resolve(process.cwd(), outPath), marketMapToHtml(config, result.set));
    console.log(`Wrote ${outPath}`);
    return;
  }

  const loadSet = async (): Promise<ObservationSet> => {
    const runLabel = option(rest, "--run");
    const set = runLabel ? await store.get(runLabel) : await store.latest();
    if (!set) {
      throw new Error(
        runLabel
          ? `No observation run "${runLabel}" for ${config.category}`
          : `No observations stored for ${config.category} — run market observe --from <file> first`,
      );
    }
    return set;
  };

  if (subcommand === "fronts") {
    const set = await loadSet();
    const fronts = computeFrontStates(config, set);
    const priorLabel = option(rest, "--diff");
    const prior = priorLabel ? await store.get(priorLabel) : null;
    if (priorLabel && !prior) throw new Error(`No observation run "${priorLabel}" to diff against`);
    const drift = prior ? diffFrontStates(computeFrontStates(config, prior), fronts) : null;
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ runLabel: set.runLabel, fronts, drift }, null, 2));
      return;
    }
    for (const front of fronts) {
      const owner = front.state === "owned" ? ` → ${front.loudVendorIds[0]}` : "";
      console.log(`${front.state.toUpperCase().padEnd(10)} ${front.claimId}${owner}`);
    }
    if (drift) {
      console.log("");
      if (drift.length === 0) console.log(`No front changes since ${priorLabel}.`);
      for (const change of drift) console.log(`CHANGED   ${change.claimId}: ${change.before} → ${change.after}`);
    }
    return;
  }

  if (subcommand === "report") {
    const set = await loadSet();
    const format = option(rest, "--format") ?? "md";
    const output = format === "html" ? marketMapToHtml(config, set) : marketMapToMarkdown(config, set);
    const outPath = option(rest, "--out");
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), output);
      console.log(`Wrote ${outPath}`);
    } else {
      console.log(output);
    }
    return;
  }

  if (subcommand === "axes") {
    const set = await loadSet();
    const report = assessAxes(config, set);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(axesReportToText(report));
    return;
  }

  if (subcommand === "scale") {
    const report = computeScaleIndex(config);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(scaleReportToText(config, report));
    return;
  }

  if (subcommand === "overlay") {
    const set = await loadSet();
    const snapshotPath = option(rest, "--snapshot");
    if (!snapshotPath) {
      throw new Error(
        "market overlay requires --snapshot <canonical-snapshot.json> (fullstackgtm snapshot --out it first) — directives need CRM ground truth",
      );
    }
    const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), snapshotPath), "utf8")) as CanonicalGtmSnapshot;

    // --calls accepts ParsedCall JSON files (from `call parse --out`) and/or
    // manifest arrays [{path, dealId?}] linking calls to deals. Repeatable.
    const documents: CallDocument[] = [];
    const addParsedCall = (parsedPath: string, dealId?: string) => {
      const parsed = JSON.parse(readFileSync(resolve(process.cwd(), parsedPath), "utf8")) as ParsedCall & {
        segments?: Array<{ text?: string }>;
      };
      const text = [
        ...(parsed.segments ?? []).map((segment) => segment.text ?? ""),
        ...(parsed.insights ?? []).map((insight) => `${insight.text ?? ""} ${insight.evidence ?? ""}`),
      ].join("\n");
      documents.push({ id: parsed.id ?? parsedPath, text, dealId, occurredAt: parsed.evidence?.[0]?.capturedAt });
    };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] !== "--calls") continue;
      const callsPath = rest[i + 1];
      if (!callsPath) throw new Error("--calls needs a path");
      const raw = JSON.parse(readFileSync(resolve(process.cwd(), callsPath), "utf8"));
      if (Array.isArray(raw)) {
        for (const entry of raw as Array<{ path: string; dealId?: string }>) addParsedCall(entry.path, entry.dealId);
      } else {
        addParsedCall(callsPath);
      }
    }

    const priorLabel = option(rest, "--prior-run");
    const priorSet = priorLabel ? await store.get(priorLabel) : null;
    if (priorLabel && !priorSet) throw new Error(`No observation run "${priorLabel}" for URGENT drift`);

    const stats = computeOverlayStats(config, snapshot, documents);
    const directives = computeDirectives(config, set, stats, {
      minMentions: numericOption(rest, "--min-mentions") ?? undefined,
      promoteLift: numericOption(rest, "--promote-lift") ?? undefined,
      priorSet: priorSet ?? undefined,
    });

    if (rest.includes("--json")) {
      console.log(JSON.stringify({ stats, directives }, null, 2));
      return;
    }
    console.log(overlayToMarkdown(stats, directives));

    if (rest.includes("--save")) {
      const taskAccount = option(rest, "--task-account");
      const taskDeal = option(rest, "--task-deal");
      if (!taskAccount && !taskDeal) {
        throw new Error(
          "--save needs --task-account <id> or --task-deal <id>: directives become approval-gated create_task operations, and the CRM needs a record to hang them on (your own company's account record works well)",
        );
      }
      const plan = directivesToPlan(
        config,
        set,
        directives,
        taskDeal ? { objectType: "deal", objectId: taskDeal } : { objectType: "account", objectId: taskAccount as string },
      );
      const stored = await createFilePlanStore().save(plan);
      console.log(`Saved plan ${stored.plan.id} (${directives.length} directive task(s); approve via \`plans approve\`)`);
    }
    return;
  }

  throw new Error(
    `Unknown market subcommand: ${subcommand} (try: init, capture, classify, worksheet, observe, fronts, axes, overlay, scale, report, refresh)`,
  );
}

/**
 * The enrich layer: governed append/refresh of third-party data (Apollo pull,
 * Clay ingest) into the CRM through the normal dry-run → approval → apply
 * contract. State lives in the profile-scoped run store (checkpoint,
 * staleness ledger, observability in one); scheduling belongs to the
 * horizontal scheduler — enrich owns no cron logic.
 */
async function enrichCommand(args: string[]) {
  const [subcommand, ...rest] = args;

  // Catch --help BEFORE config load, credential resolution, or any network
  // call (the 0.14.1/0.18 bug class — `enrich append --help` executing a
  // paid Apollo pull would be its worst recurrence).
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage:
enrich append  [--source apollo] [--objects companies,contacts] [--save] [--config <path>]
               [source options] [--run-label <label>] [--json]
enrich refresh [--source apollo] [--stale-days <n>] [--save] [--config <path>]
               [source options] [--run-label <label>] [--json]
enrich ingest  <file.csv|payload.json> --source clay [--run-label <label>] [--objects companies|contacts] [--config <path>]
enrich acquire [--source <id>] [--max <n>] [--save] [--config <path>] [--json]
enrich status  [--runs] [--source <id>] [--config <path>] [--json]

acquire creates NET-NEW leads from a staged prospect list (ingest first):
it dedupes each sourced row against the CRM, skips matches and ambiguities
(resolve-first never creates over a possible duplicate), and proposes a
\`create_record\` op per confirmed net-new row — capped by the acquire meter's
remaining budget (records + spend, per day and per month; whichever is hit
first). Approval-gated like every write: \`--save\` → plans approve → apply.
The meter is charged only when a create actually lands at apply.

append pulls from an api source (Apollo — BYO key via \`login apollo\` or
APOLLO_API_KEY) or reads data staged by \`enrich ingest\` (Clay CSV exports,
webhook payload JSON), matches source records to CRM records via the ordered
match keys in enrich.config.json (unique hit wins; zero hits falls through to
the next key; multiple hits skip or flow into the suggest chain, per
onAmbiguous), and emits a fill-blanks-only patch plan. Without --save it
prints the dry-run diff and writes NOTHING; with --save the plan lands in the
plan store as needs_approval and the run (counts, per-field enrichedAt stamps,
resume cursor) lands in the profile's enrich run store. From there the normal
chain takes over: plans approve → apply.

refresh computes its work set from the run-store stamps — fields enrich
itself wrote, opted in with "refresh": true, older than the staleness window
(--stale-days overrides per-field staleDays and policy.defaultStaleDays) —
re-fetches the source, and proposes updates only where the source value
actually changed. Every operation carries beforeValue, so apply-time
compare-and-set rejects writes over a CRM that moved underneath the plan.

Conflict policy (MVP): "never" — enrich only fills blank fields and only
re-touches fields its own ledger proves it stamped. system-only and always
are phase 2. Recurring execution is the scheduler's job; enrich has no cron.`);
    return;
  }

  if (!["append", "refresh", "ingest", "status", "acquire"].includes(subcommand)) {
    throw new Error(`Unknown enrich subcommand: ${subcommand} (try: append, refresh, ingest, status, acquire)`);
  }

  const configPath = () => resolve(process.cwd(), option(rest, "--config") ?? ENRICH_CONFIG_FILE_NAME);
  const store = createFileEnrichRunStore();

  if (subcommand === "status") {
    await enrichStatus(store, rest, configPath());
    return;
  }

  // Config resolution: an explicit --config or an on-disk default always wins
  // (and validates). Only when neither exists do we fall back to a built-in
  // preset for the source (e.g. `--source clay`), so the common Mode-A loop
  // needs no hand-authored config. A present-but-invalid config still errors.
  const explicitConfig = option(rest, "--config");
  const configFile = configPath();
  // No config file + no --config → fall back to a built-in preset so the common
  // paths need zero hand-authored config: `acquire` gets the zero-config acquire
  // preset (targeted/deduped/metered out the gate); other verbs get the source
  // preset (e.g. clay ingest). An explicit/on-disk config always wins.
  const presetFor = (src: string | undefined) =>
    subcommand === "acquire" ? builtinAcquirePreset(src) : builtinEnrichPreset(src);
  const config =
    !explicitConfig && !existsSync(configFile)
      ? (presetFor(option(rest, "--source") ?? undefined) ?? loadEnrichConfig(configFile))
      : loadEnrichConfig(configFile);

  // `enrich ingest` stages rows. If the same command also names a CRM source
  // (--input/--provider), collapse the two-step into one: stage, then run the
  // append against the just-staged data so `enrich ingest clay.csv --source clay
  // --input snap.json` returns the hygiene verdict end-to-end. Without a CRM
  // source it stays stage-only (the existing two-step is preserved).
  if (subcommand === "ingest") {
    const autoAppend = Boolean(option(rest, "--provider") || option(rest, "--input"));
    await enrichIngest(store, config, rest, autoAppend);
    if (!autoAppend) return;
  }

  if (subcommand === "acquire") {
    if (!config.acquire) {
      throw new Error(
        'enrich acquire: config has no "acquire" section. Add e.g. { "acquire": { "create": { "contact": { "matchKey": "email", "properties": { "email": "email", "firstname": "first_name", "lastname": "last_name" } } }, "budget": { "records": { "perDay": 50, "perMonth": 500 } }, "costPerRecord": { "clay": 0.10 } } } to enrich.config.json.',
      );
    }
    const source = resolveEnrichSource(config, rest);
    const sourceConfig = config.sources[source];
    const save = rest.includes("--save");
    const today = new Date().toISOString().slice(0, 10);

    // Prospects come from an API source (net-new discovery, e.g. Explorium +
    // pipe0 work-email) or a staged ingest list (Clay/CSV/webhook).
    const snapshot = await readSnapshot(rest);
    const icp = loadIcp(rest);
    if (sourceConfig.kind === "api" && !icp) {
      console.error(
        "⚠ No ICP loaded — discovery will use the raw discovery.filters and skip fit scoring. " +
          "Develop one with `fullstackgtm icp interview` (or pass --icp <path>) so leads map to your ICP.",
      );
    }
    // Recommend the strong dedup key when the CRM carries no LinkedIn URLs:
    // without them, pre-email dedup falls back to the weaker name+domain match.
    if (sourceConfig.kind === "api" && !(snapshot.contacts ?? []).some((c) => c.linkedin)) {
      console.error(
        "⚠ No LinkedIn URLs found on your contacts — pre-email dedup falls back to name+domain (weaker). " +
          "Populate the HubSpot \"LinkedIn URL\" (hs_linkedin_url) property for exact dedup; " +
          "acquire writes it on every new contact it creates, so coverage grows automatically.",
      );
    }
    const seen = loadSeen();
    let records: EnrichSourceRecord[];
    let apiSkippedCrm = 0;
    let apiSkippedSeen = 0;
    let apiProcessedKeys: string[] = [];
    if (sourceConfig.kind === "api") {
      const api = await acquireFromApi(config, source, rest, icp, snapshot, seen);
      records = api.records;
      apiSkippedCrm = api.skippedCrm;
      apiSkippedSeen = api.skippedSeen;
      apiProcessedKeys = api.processedKeys;
    } else {
      const stagedLabel = option(rest, "--staged-run");
      const stagedRun = stagedLabel
        ? await store.get(stagedLabel)
        : await store.latest({ source, mode: "ingest" });
      if (!stagedRun || stagedRun.mode !== "ingest") {
        throw new Error(
          `No staged data for source "${source}". Stage prospects first: fullstackgtm enrich ingest <prospects.csv|payload.json> --source ${source}`,
        );
      }
      records = stagedSourceRecords(config, source, stagedRun);
    }

    // Meter: how many MORE leads may we create right now? --max is an
    // additional per-run ceiling, never a way to exceed the budget.
    const now = new Date();
    const costPerRecord = config.acquire.costPerRecord?.[source] ?? 0;
    if (apiSkippedCrm || apiSkippedSeen) {
      console.error(
        `Pre-email dedup: skipped ${apiSkippedCrm} already-in-CRM + ${apiSkippedSeen} seen before paying for emails ` +
          `(≈$${((apiSkippedCrm + apiSkippedSeen) * costPerRecord).toFixed(2)} enrichment saved).`,
      );
    }
    const headroom = remaining(loadMeter(now), config.acquire.budget, costPerRecord, now);
    const explicitMax = numericOption(rest, "--max");
    let cap = headroom.maxRecords;
    if (explicitMax !== undefined) cap = cap === null ? explicitMax : Math.min(cap, explicitMax);

    const result = buildAcquirePlan({
      config,
      source,
      snapshot,
      records,
      runLabel: option(rest, "--run-label") ?? `acquire-${source}-${today}`,
      maxRecords: cap,
    });

    const meterLine = formatAcquireMeter(headroom, costPerRecord);
    if (!save) {
      if (rest.includes("--json")) {
        console.log(
          JSON.stringify(
            { plan: result.plan, counts: result.counts, estCostUsd: result.estCostUsd, meter: headroom },
            null,
            2,
          ),
        );
      } else {
        console.log(patchPlanToMarkdown(result.plan));
        console.log(meterLine);
        console.log("\nDry run — nothing written. Re-run with --save to persist the plan, then approve + apply.");
      }
      return;
    }

    const run = await openEnrichRun(store, source, "append", option(rest, "--run-label"), today);
    const planIds: string[] = [];
    if (result.plan.operations.length > 0) {
      await createFilePlanStore().save(result.plan);
      planIds.push(result.plan.id);
    }
    await store.update({
      ...run,
      completedAt: new Date().toISOString(),
      cursor: null,
      planIds: [...(run.planIds ?? []), ...planIds],
    });
    // Remember everyone we email-resolved this run so the next run skips them
    // pre-email (cross-run credit saver). Committed (--save) runs only.
    if (apiProcessedKeys.length > 0) recordSeen(apiProcessedKeys, now);
    console.log(meterLine);
    if (planIds.length > 0) {
      console.log(
        `Saved plan ${result.plan.id} — ${result.counts.created} net-new lead(s), est. $${result.estCostUsd.toFixed(2)}. ` +
          `Review \`fullstackgtm plans show ${result.plan.id}\`, approve \`fullstackgtm plans approve ${result.plan.id} --operations all\`, ` +
          `then \`fullstackgtm apply --plan-id ${result.plan.id} --provider hubspot\`. The meter is charged only when a create lands at apply.`,
      );
    } else {
      console.log("No net-new leads to create (everything sourced already matched, or was withheld by the meter).");
    }
    return;
  }

  const mode: "append" | "refresh" = subcommand === "refresh" ? "refresh" : "append";
  const source = resolveEnrichSource(config, rest);
  const sourceConfig = config.sources[source];
  const save = rest.includes("--save");
  const today = new Date().toISOString().slice(0, 10);

  // Refresh work set comes from the staleness ledger, before any fetch.
  const allRuns = await store.list();
  let workSet: ReturnType<typeof selectStaleWork> = [];
  if (mode === "refresh") {
    const staleDaysOverride = numericOption(rest, "--stale-days");
    workSet = selectStaleWork(config, allRuns, source, { staleDaysOverride });
    if (workSet.length === 0) {
      const stamped = latestStamps(allRuns, source).size;
      console.log(
        stamped === 0
          ? `Nothing to refresh: no ${source} enrichment stamps yet. Run \`enrich append --source ${source} --save\` first.`
          : `Nothing to refresh: all ${stamped} stamped field(s) from ${source} are within their staleness window.`,
      );
      return;
    }
  }

  const snapshot = await readSnapshot(rest);

  // Assemble source records: api pull (checkpointed when --save) or staged ingest data.
  let run: EnrichRun | null = null;
  let records: EnrichSourceRecord[];
  let missCount = 0;
  if (sourceConfig.kind === "api") {
    const objectTypes = parseEnrichObjects(rest, config, source);
    const fieldsFor = (objectType: EnrichObjectType) =>
      (config.fields[objectType] ?? []).filter((field) => field.from[source] !== undefined);
    const pullKeys: ApolloPullKey[] =
      mode === "append"
        ? apolloPullKeysForAppend(snapshot, objectTypes, (objectType, record) =>
            fieldsFor(objectType).some((field) => {
              const value = record[resolveCrmField(objectType, field.crm)];
              return value === undefined || value === null || String(value).trim() === "";
            }),
          )
        : apolloPullKeysForRefresh(snapshot, workSet);
    if (pullKeys.length === 0) {
      console.log(
        mode === "append"
          ? "Nothing to enrich: no records with a blank mapped field and a pull key (companies need a domain, contacts an email)."
          : "Nothing to refresh: no stale records carry a pull key (companies need a domain, contacts an email).",
      );
      return;
    }
    const client = createApolloClient({
      getApiKey: () => apolloApiKey(),
      apiBaseUrl: process.env.APOLLO_API_BASE_URL,
    });
    if (save) {
      run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
      if (run.cursor) {
        console.error(
          `Resuming interrupted run ${run.runLabel} from cursor ${run.cursor} (${run.pulled?.length ?? 0} record(s) already pulled).`,
        );
      }
    }
    const result = await pullApolloRecords(client, pullKeys, {
      resumeAfter: run?.cursor ?? null,
      onProgress: run
        ? async (progress) => {
            run!.cursor = progress.lastKeyValue;
            if (progress.record) run!.pulled = [...(run!.pulled ?? []), progress.record];
            if (progress.miss) run!.missedKeys = [...(run!.missedKeys ?? []), progress.miss.value];
            await store.update(run!);
          }
        : undefined,
    });
    records = run ? [...(run.pulled ?? [])] : result.records;
    missCount = run ? (run.missedKeys?.length ?? 0) : result.misses.length;
  } else {
    const stagedLabel = option(rest, "--staged-run");
    const stagedRun = stagedLabel
      ? await store.get(stagedLabel)
      : await store.latest({ source, mode: "ingest" });
    if (!stagedRun || stagedRun.mode !== "ingest") {
      throw new Error(
        `No staged data for source "${source}". Stage it first: fullstackgtm enrich ingest <file.csv|payload.json> --source ${source}`,
      );
    }
    records = stagedSourceRecords(config, source, stagedRun);
    if (save) run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
  }

  const result = buildEnrichPlan({
    config,
    source,
    mode,
    snapshot,
    records,
    workSet: mode === "refresh" ? workSet : undefined,
    runLabel: run?.runLabel ?? `${mode}-${source}-${today}`,
  });
  // Pull keys the source had no data for count as fetched-but-unmatched.
  result.counts.fetched += missCount;
  result.counts.unmatched += missCount;

  if (!save) {
    if (rest.includes("--json")) {
      console.log(JSON.stringify(result.plan, null, 2));
    } else {
      console.log(patchPlanToMarkdown(result.plan));
      console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
      console.log("\nDry run — nothing written. Re-run with --save to persist the plan and the run record.");
    }
    return;
  }

  // --save: persist the plan (when it proposes anything) and finalize the run.
  const planIds: string[] = [];
  if (result.plan.operations.length > 0) {
    await createFilePlanStore().save(result.plan);
    planIds.push(result.plan.id);
  }
  const finalized: EnrichRun = {
    ...(run as EnrichRun),
    completedAt: new Date().toISOString(),
    cursor: null,
    counts: result.counts,
    planIds: [...((run as EnrichRun).planIds ?? []), ...planIds],
    stamps: [...((run as EnrichRun).stamps ?? []), ...result.stamps],
    ambiguities: result.ambiguities,
  };
  await store.update(finalized);
  console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
  if (planIds.length > 0) {
    console.log(
      `Saved plan ${result.plan.id} (run ${finalized.runLabel}). Review with \`fullstackgtm plans show ${result.plan.id}\`, ` +
        `approve with \`fullstackgtm plans approve ${result.plan.id} --operations <ids|all>\`, then ` +
        `\`fullstackgtm apply --plan-id ${result.plan.id} --provider <name>\`.`,
    );
  } else {
    console.log(`Run ${finalized.runLabel} recorded; no operations to propose.`);
  }
}

function formatEnrichCounts(counts: EnrichCounts, ambiguities: number) {
  return (
    `Source records: ${counts.fetched} fetched · ${counts.matched} matched · ` +
    `${counts.unmatched} unmatched · ${counts.ambiguous} ambiguous (${ambiguities} collision(s) recorded) · ` +
    `${counts.opsEmitted} operation(s) proposed`
  );
}

/** Best-effort enrich-config load for apply-time acquire-budget enforcement. */
/** Provider API key: env override first, then the credential store (`login`). */
function providerKey(provider: "explorium" | "pipe0"): string {
  const envName = provider === "explorium" ? "EXPLORIUM_API_KEY" : "PIPE0_API_KEY";
  if (process.env[envName]) return process.env[envName] as string;
  const stored = getCredential(provider);
  if (stored) return stored.accessToken;
  throw new Error(`No ${provider} credentials. Run \`echo "$KEY" | fullstackgtm login ${provider}\`, or set ${envName}.`);
}

/** Load the active ICP: --icp <path>, else ./icp.json. Undefined if none. */
function loadIcp(args: string[]): Icp | undefined {
  const explicit = option(args, "--icp");
  const path = resolve(process.cwd(), explicit ?? "icp.json");
  if (!existsSync(path)) {
    if (explicit) throw new Error(`--icp ${explicit}: file not found`);
    return undefined;
  }
  return parseIcp(readFileSync(path, "utf8"));
}

/**
 * `icp` — develop and inspect the Ideal Customer Profile that targets acquire.
 * The CLI can't run AskUserQuestion itself; `icp interview` emits the question
 * spec an agent (Claude Code / Codex) drives with its AskUserQuestion tool, then
 * `icp set` writes icp.json from the collected answers.
 */
async function icpCommand(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`Usage:
  fullstackgtm icp interview                      emit the interview spec (an agent drives it with AskUserQuestion)
  fullstackgtm icp set <answers.json> [--name <n>] [--out <path>]   write icp.json from interview answers
  fullstackgtm icp show [--icp <path>]            render the ICP + the discovery filters it produces

The ICP makes \`enrich acquire\` targeted, not random: it generates each
provider's discovery filters (Explorium, pipe0/Crustdata) AND scores every
discovered prospect for fit — only above-threshold leads become create_record
ops. Develop one by interview, then \`enrich acquire\` picks up ./icp.json.`);
    return;
  }
  if (sub === "interview") {
    console.log(
      JSON.stringify(
        {
          questions: INTERVIEW_SPEC,
          instructions:
            "Ask each question with AskUserQuestion (multiSelect per .multiSelect). For each answer, collect the chosen options' .value arrays and concat them under the question's .id. Then run `fullstackgtm icp set <answers.json>` with that flattened object.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (sub === "set") {
    const file = rest.find((a) => !a.startsWith("--"));
    if (!file) throw new Error("Usage: fullstackgtm icp set <answers.json> [--name <n>] [--out <path>]");
    const answers = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
    const icp = icpFromAnswers(option(rest, "--name") ?? "ICP", answers);
    const out = resolve(process.cwd(), option(rest, "--out") ?? "icp.json");
    writeFileSync(out, `${JSON.stringify(icp, null, 2)}\n`);
    console.log(
      `Wrote ${out} — ${icp.persona.titleKeywords?.length ?? 0} title keyword(s), ` +
        `${icp.firmographics.employeeBands?.length ?? 0} size band(s), fit threshold ${fitThreshold(icp)}.`,
    );
    return;
  }
  if (sub === "show") {
    const icp = loadIcp(rest);
    if (!icp) throw new Error("No ICP found (icp.json in cwd, or pass --icp <path>). Build one: fullstackgtm icp interview.");
    console.log(
      JSON.stringify(
        {
          icp,
          exploriumFilters: icpToExploriumFilters(icp),
          crustdataFilters: icpToCrustdataFilters(icp),
          fitThreshold: fitThreshold(icp),
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`Unknown icp subcommand: ${sub} (try: interview, set, show)`);
}

/**
 * Pull net-new prospects from an API acquire source into source records the
 * acquire builder dedupes + turns into create_record ops. Explorium discovers;
 * pipe0 (when resolveEmailsWith=pipe0) fills real work emails. Only rows that
 * carry the dedupe key (email) survive — you cannot resolve-first without it.
 */
async function acquireFromApi(
  config: EnrichConfig,
  source: string,
  rest: string[],
  icp: Icp | undefined,
  snapshot: CanonicalGtmSnapshot,
  seen: Set<string>,
): Promise<{ records: EnrichSourceRecord[]; skippedCrm: number; skippedSeen: number; processedKeys: string[] }> {
  const acquire = config.acquire!;
  const disc = acquire.discovery?.[source];
  if (!disc) {
    throw new Error(`enrich acquire: api source "${source}" needs an "acquire.discovery.${source}" config (provider + size).`);
  }
  const matchKey = acquire.create.contact?.matchKey ?? "email";
  const maxOverride = numericOption(rest, "--max");
  const size = maxOverride !== undefined ? Math.min(maxOverride, disc.size ?? 25) : disc.size ?? 25;

  // 1. Discover. Filters come from the ICP when one is loaded (the whole point —
  //    targeted, not random); otherwise from the hand-written disc.filters.
  let prospects: Prospect[];
  if (disc.provider === "explorium") {
    const filters = icp
      ? icpToExploriumFilters(icp)
      : ((disc.filters ?? {}) as Record<string, { values?: string[]; value?: boolean }>);
    prospects = await fetchExploriumProspects({ apiKey: providerKey("explorium"), filters, size });
  } else if (disc.provider === "pipe0") {
    const filters = icp ? icpToCrustdataFilters(icp) : (disc.filters ?? {});
    prospects = await fetchPipe0CrustdataProspects({ apiKey: providerKey("pipe0"), filters, limit: size });
  } else {
    throw new Error(`enrich acquire: unknown discovery provider "${disc.provider}" (explorium | pipe0).`);
  }

  // 2. ICP fit scoring BEFORE paying for emails — only above-threshold prospects
  //    proceed to (credit-spending) email resolution.
  if (icp) {
    const threshold = fitThreshold(icp);
    prospects = prospects
      .map((p) => ({ ...p, fitScore: scoreProspectAgainstIcp(p, icp).score }))
      .filter((p) => (p.fitScore ?? 0) >= threshold);
  }

  // 2.5 Pre-email dedup — drop prospects already in the CRM (name+domain match
  //     vs the snapshot) or already processed in a prior run (the seen cache),
  //     BEFORE paying pipe0 for emails. The email-level dedup (buildAcquirePlan)
  //     and apply-time resolve-first remain the precise backstop.
  const { fresh, skippedCrm, skippedSeen } = partitionFreshProspects(prospects, crmContactKeys(snapshot), seen);
  prospects = fresh;

  // 3. Resolve real work emails (both providers need it: Explorium's email is
  //    hashed, Crustdata search returns none). pipe0 waterfall, chunked.
  if (matchKey === "email") {
    prospects = await pipe0ResolveWorkEmails({ apiKey: providerKey("pipe0"), prospects });
  }

  const processedKeys = prospects.flatMap(prospectIdentityKeys);
  const records = prospects
    .map((p) => {
      const keyValue = (p as unknown as Record<string, unknown>)[matchKey] as string | undefined;
      return {
        id: p.sourceId ?? `${source}:${keyValue ?? p.fullName ?? ""}`,
        objectType: "contact" as const,
        keys: { [matchKey]: keyValue },
        payload: p as unknown as Record<string, unknown>,
      };
    })
    .filter((record) => Boolean(record.keys[matchKey]));
  return { records, skippedCrm, skippedSeen, processedKeys };
}

function tryLoadAcquireConfig(args: string[]): EnrichConfig | undefined {
  try {
    const path = resolve(process.cwd(), option(args, "--config") ?? ENRICH_CONFIG_FILE_NAME);
    if (!existsSync(path)) return undefined;
    return loadEnrichConfig(path);
  } catch {
    return undefined;
  }
}

function formatAcquireMeter(headroom: AcquireRemaining, costPerRecord: number): string {
  const n = (v: number | null) => (v === null ? "∞" : String(v));
  const money = (v: number | null) => (v === null ? "∞" : `$${v.toFixed(2)}`);
  const max = headroom.maxRecords === null ? "unlimited" : `${headroom.maxRecords}`;
  return (
    `Acquire meter — creatable now: ${max} lead(s). ` +
    `Records left: ${n(headroom.records.day)}/day, ${n(headroom.records.month)}/month · ` +
    `Spend left: ${money(headroom.spendUsd.day)}/day, ${money(headroom.spendUsd.month)}/month ` +
    `(≈$${costPerRecord.toFixed(2)}/lead).`
  );
}

function resolveEnrichSource(config: EnrichConfig, rest: string[]): string {
  const requested = option(rest, "--source");
  const declared = Object.keys(config.sources);
  if (requested) {
    if (!config.sources[requested]) {
      throw new Error(`Unknown enrich source "${requested}" (declared: ${declared.join(", ")})`);
    }
    return requested;
  }
  if (declared.length === 1) return declared[0];
  if (config.sources.apollo) return "apollo";
  throw new Error(`Multiple sources declared (${declared.join(", ")}) — pass --source <id>`);
}

function parseEnrichObjects(rest: string[], config: EnrichConfig, source: string): EnrichObjectType[] {
  const configured = (["company", "contact"] as EnrichObjectType[]).filter((objectType) =>
    (config.fields[objectType] ?? []).some((field) => field.from[source] !== undefined),
  );
  const flag = option(rest, "--objects");
  if (!flag) {
    if (configured.length === 0) {
      throw new Error(`No fields map from source "${source}" — add "from": { "${source}": ... } entries to the config.`);
    }
    return configured;
  }
  const requested = Array.from(new Set(flag.split(",").map((part) => parseSingleObjectType(part))));
  for (const objectType of requested) {
    if (!configured.includes(objectType)) {
      throw new Error(`--objects ${flag}: no ${objectType} fields map from source "${source}" in the config.`);
    }
  }
  return requested;
}

function apolloApiKey(): string {
  if (process.env.APOLLO_API_KEY) return process.env.APOLLO_API_KEY;
  const stored = getCredential("apollo");
  if (stored) return stored.accessToken;
  throw new Error(
    'No Apollo credentials. Run `echo "$APOLLO_API_KEY" | fullstackgtm login apollo` once, or set APOLLO_API_KEY.',
  );
}

/**
 * Open (or resume) a saved run. An interrupted run — same label, same source
 * and mode, never completed — is resumed from its cursor; a completed run
 * with the default label gets a -2/-3 suffix (runs are append-only).
 */
async function openEnrichRun(
  store: EnrichRunStore,
  source: string,
  mode: "append" | "refresh",
  requestedLabel: string | null,
  today: string,
): Promise<EnrichRun> {
  const baseLabel = requestedLabel ?? `${mode}-${source}-${today}`;
  let label = baseLabel;
  for (let suffix = 2; ; suffix += 1) {
    const existing = await store.get(label);
    if (!existing) break;
    if (existing.source === source && existing.mode === mode && existing.completedAt === null) {
      return existing; // resume the interrupted run
    }
    if (requestedLabel) {
      throw new Error(`Run "${requestedLabel}" already exists and is completed — enrich runs are append-only.`);
    }
    label = `${baseLabel}-${suffix}`;
  }
  return store.append({
    id: enrichRunId(source, label),
    runLabel: label,
    source,
    mode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    cursor: null,
    counts: { fetched: 0, matched: 0, unmatched: 0, ambiguous: 0, opsEmitted: 0 },
    planIds: [],
    stamps: [],
  });
}

async function enrichIngest(store: EnrichRunStore, config: EnrichConfig, rest: string[], autoAppend = false) {
  const file = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
  if (!file) throw new Error("Usage: fullstackgtm enrich ingest <file.csv|payload.json> --source <id> [--run-label <label>]");
  const source = option(rest, "--source");
  if (!source) throw new Error("enrich ingest requires --source <id> (the ingest source the data belongs to)");
  const sourceConfig = config.sources[source];
  if (!sourceConfig) {
    throw new Error(`Unknown enrich source "${source}" (declared: ${Object.keys(config.sources).join(", ")})`);
  }
  if (sourceConfig.kind !== "ingest") {
    throw new Error(`Source "${source}" is kind "${sourceConfig.kind}" — only ingest sources accept staged data.`);
  }

  const raw = readFileSync(resolve(process.cwd(), file), "utf8");
  let rows: Array<Record<string, unknown>>;
  const isCsv = file.toLowerCase().endsWith(".csv") || sourceConfig.format === "csv";
  if (isCsv && !file.toLowerCase().endsWith(".json")) {
    rows = parseCsv(raw);
  } else {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) rows = parsed as Array<Record<string, unknown>>;
    else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)) {
      rows = (parsed as { rows: Array<Record<string, unknown>> }).rows;
    } else if (parsed && typeof parsed === "object") {
      rows = [parsed as Record<string, unknown>];
    } else {
      throw new Error(`${file}: expected a JSON array, an object, or { "rows": [...] }`);
    }
  }
  if (rows.length === 0) throw new Error(`${file}: no rows to stage`);

  const objectsFlag = option(rest, "--objects");
  const objectType: EnrichObjectType = objectsFlag
    ? parseSingleObjectType(objectsFlag)
    : inferIngestObjectType(config, source, rows);

  const today = new Date().toISOString().slice(0, 10);
  const baseLabel = option(rest, "--run-label") ?? `ingest-${source}-${today}`;
  let label = baseLabel;
  for (let suffix = 2; await store.get(label); suffix += 1) {
    if (option(rest, "--run-label")) {
      throw new Error(`Run "${baseLabel}" already exists — enrich runs are append-only; pick a new --run-label.`);
    }
    label = `${baseLabel}-${suffix}`;
  }
  const now = new Date().toISOString();
  await store.append({
    id: enrichRunId(source, label),
    runLabel: label,
    source,
    mode: "ingest",
    startedAt: now,
    completedAt: now,
    cursor: null,
    counts: { fetched: rows.length, matched: 0, unmatched: 0, ambiguous: 0, opsEmitted: 0 },
    planIds: [],
    stamps: [],
    staged: rows,
    stagedObjectType: objectType,
  });
  console.log(
    autoAppend
      ? `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}; matching against the CRM…`
      : `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}. ` +
          `Next: fullstackgtm enrich append --source ${source} [source options] [--save]`,
  );
}

function parseSingleObjectType(value: string): EnrichObjectType {
  const normalized = value.trim().toLowerCase();
  if (normalized === "companies" || normalized === "company") return "company";
  if (normalized === "contacts" || normalized === "contact") return "contact";
  throw new Error(`--objects must be companies or contacts (got "${value}")`);
}

async function enrichStatus(store: EnrichRunStore, rest: string[], configFile: string) {
  const sourceFilter = option(rest, "--source");
  const allRuns = (await store.list()).filter((run) => !sourceFilter || run.source === sourceFilter);
  if (allRuns.length === 0) {
    console.log(
      sourceFilter
        ? `No enrich runs for source "${sourceFilter}".`
        : "No enrich runs yet. Start with `fullstackgtm enrich append --save` or stage data with `enrich ingest`.",
    );
    return;
  }

  // Staleness windows come from the config when one is readable; status must
  // not REQUIRE a config (the run store alone is enough to report on).
  let config: EnrichConfig | null = null;
  if (existsSync(configFile)) {
    try {
      config = loadEnrichConfig(configFile);
    } catch {
      config = null;
    }
  }

  const now = Date.now();
  const sources = Array.from(new Set(allRuns.map((run) => run.source)));
  const report = sources.map((source) => {
    const runs = allRuns.filter((run) => run.source === source);
    const last = runs[runs.length - 1];
    const interrupted = runs.filter((run) => run.completedAt === null);
    const stamps = Array.from(latestStamps(runs, source).values());
    const ages = stamps.map((stamp) => (now - Date.parse(stamp.enrichedAt)) / 86_400_000);
    const staleness = stamps.map((stamp, index) => {
      const windowDays = config
        ? staleDaysFor(config, stamp.objectType, stamp.field)
        : DEFAULT_STALE_DAYS;
      return ages[index] > windowDays;
    });
    return {
      source,
      runs: runs.length,
      lastRun: {
        runLabel: last.runLabel,
        mode: last.mode,
        startedAt: last.startedAt,
        completedAt: last.completedAt,
        counts: last.counts,
        planIds: last.planIds,
      },
      interrupted: interrupted.map((run) => ({ runLabel: run.runLabel, cursor: run.cursor })),
      stamps: {
        total: stamps.length,
        stale: staleness.filter(Boolean).length,
        oldestDays: ages.length ? Math.round(Math.max(...ages)) : null,
        newestDays: ages.length ? Math.round(Math.min(...ages)) : null,
        windowSource: config ? "enrich.config.json" : `default ${DEFAULT_STALE_DAYS}d`,
      },
    };
  });

  if (rest.includes("--json")) {
    console.log(JSON.stringify({ sources: report, runs: rest.includes("--runs") ? allRuns : undefined }, null, 2));
    return;
  }

  for (const entry of report) {
    const last = entry.lastRun;
    console.log(`${entry.source} — ${entry.runs} run(s)`);
    console.log(
      `  last: ${last.runLabel} (${last.mode}) ${last.completedAt ? `completed ${last.completedAt}` : "INTERRUPTED"}` +
        ` · ${last.counts.fetched} fetched, ${last.counts.matched} matched, ${last.counts.unmatched} unmatched,` +
        ` ${last.counts.ambiguous} ambiguous, ${last.counts.opsEmitted} ops` +
        (last.planIds.length ? ` · plans: ${last.planIds.join(", ")}` : ""),
    );
    for (const run of entry.interrupted) {
      console.log(`  interrupted: ${run.runLabel} at cursor ${run.cursor ?? "(start)"} — re-run with --save to resume`);
    }
    console.log(
      `  stamps: ${entry.stamps.total} field(s) enriched · ${entry.stamps.stale} stale (window: ${entry.stamps.windowSource})` +
        (entry.stamps.total ? ` · age ${entry.stamps.newestDays}–${entry.stamps.oldestDays}d` : ""),
    );
  }
  if (rest.includes("--runs")) {
    console.log("");
    for (const run of allRuns) {
      console.log(
        `${run.runLabel}  ${run.source.padEnd(8)} ${run.mode.padEnd(8)} ${run.completedAt ? "done" : "interrupted"}` +
          `  ${run.counts.opsEmitted} ops  ${run.stamps.length} stamps${run.staged ? `  ${run.staged.length} staged` : ""}`,
      );
    }
  }
}

/**
 * The schedule layer: declarative cadences for read/plan-side commands,
 * materialized through a provider (MVP: the user crontab), with an
 * append-only run history. The governance invariant — scheduling never
 * auto-approves — is enforced at `add` time and re-checked at `run` time.
 * Spec: docs/schedule.md (monorepo).
 */
async function scheduleCommand(args: string[]) {
  const [subcommand, ...rest] = args;

  // Catch --help BEFORE any store read, credential access, or crontab
  // round-trip (the enrich/market early-catch pattern — `schedule install
  // --help` must never touch the crontab).
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage:
schedule add "<fullstackgtm command>" --cron "<expr>" [--label <name>] [--provider local]
schedule list [--json]
schedule remove <id>
schedule enable <id> | disable <id>
schedule run <id>                     execute now; the single entry point every provider's timer calls
schedule install [--provider local]   render enabled entries into the managed crontab block
schedule uninstall [--provider local] remove the managed block (nothing else)
schedule status [<id>] [--runs <n>] [--json]

add validates the command against the schedulable allowlist — read/plan-side
only: audit, snapshot, enrich append|refresh, market capture|refresh,
suggest, report, doctor — and parses the 5-field cron expression (*, lists,
ranges, steps), but touches NO crontab: entries are declarative until install
materializes them (the plan/apply split — declare, then deliberately
activate).

Scheduling never auto-approves. apply is schedulable ONLY as
\`apply --plan-id <id>\`, and every firing re-checks the plan's status is
approved — an unapproved plan records a plan_not_approved no-op run instead
of executing. There is no flag that relaxes this. Unattended runs accumulate
proposals (plans, run records, reports), never surprise CRM writes.

install renders all enabled entries into a sentinel-delimited block
(# >>> fullstackgtm <profile> >>> ... # <<< fullstackgtm <profile> <<<) in
the user crontab; each line invokes \`schedule run <id> --profile <profile>\`
and nothing else. Re-install replaces the block wholesale and never touches
lines outside the sentinels. Providers other than local (modal, aws) are not
yet implemented — they will be scaffold generators calling the same
\`schedule run\` contract.

run executes the command in-process and records the outcome (exit code,
output tail, artifacts: plan ids / enrich run labels) under the profile's
schedule/runs/<id>/; the exit code propagates. Manual runs record
trigger: manual. status shows next firing and surfaces missed firings
(laptop asleep = cron skips silently; visibility only, no catch-up).`);
    return;
  }

  const store = createFileScheduleStore();
  const runStore = createFileScheduleRunStore();

  if (subcommand === "add") {
    const commandText = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    if (!commandText) {
      throw new Error('Usage: fullstackgtm schedule add "<fullstackgtm command>" --cron "<expr>" [--label <name>] [--provider local]');
    }
    const cronText = option(rest, "--cron");
    if (!cronText) throw new Error('schedule add requires --cron "<minute hour day-of-month month day-of-week>"');
    requireLocalScheduleProvider(option(rest, "--provider") ?? "local");

    let argv = tokenizeCommand(commandText);
    if (argv[0] === "fullstackgtm") argv = argv.slice(1);
    validateSchedulableArgv(argv);
    const cron = parseCron(cronText);
    const next = nextCronFiring(cron, new Date()); // also rejects never-firing expressions
    const createdAt = new Date().toISOString();
    const label =
      option(rest, "--label") ??
      argv.filter((arg) => !arg.startsWith("--")).slice(0, 2).join("-").replace(/[^\w.-]+/g, "-");
    assertSingleLineLabel(label);
    const entry: ScheduleEntry = {
      id: scheduleId(label, cron.source, argv, createdAt),
      label,
      argv,
      cron: cron.source,
      provider: "local",
      enabled: true,
      createdAt,
    };
    await store.add(entry);
    console.log(`Added ${entry.id} "${label}": \`${argv.join(" ")}\` at \`${cron.source}\` (next firing: ${next.toISOString()}).`);
    console.log("Declarative until materialized — activate with `fullstackgtm schedule install`.");
    return;
  }

  if (subcommand === "list") {
    const entries = await store.list();
    const now = new Date();
    const withNext = entries.map((entry) => ({
      ...entry,
      nextFiring: entry.enabled ? safeNextFiring(entry.cron, now) : null,
    }));
    if (rest.includes("--json")) {
      console.log(JSON.stringify(withNext, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log('No schedules. Add one with `fullstackgtm schedule add "<command>" --cron "<expr>"`.');
      return;
    }
    for (const entry of withNext) {
      console.log(
        `${entry.id}  ${entry.enabled ? "on " : "off"}  ${entry.cron.padEnd(14)} next ${entry.nextFiring ?? "—"}  ${entry.label}: ${entry.argv.join(" ")}`,
      );
    }
    console.log("\nEntries are declarative — `schedule install` materializes enabled ones into the crontab.");
    return;
  }

  if (subcommand === "remove") {
    const id = positionalArg(rest, "Usage: fullstackgtm schedule remove <id>");
    if (!(await store.remove(id))) throw new Error(`No schedule with id ${id}.`);
    console.log(`Removed ${id}. Run \`fullstackgtm schedule install\` to update the crontab block.`);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const id = positionalArg(rest, `Usage: fullstackgtm schedule ${subcommand} <id>`);
    const entry = await store.setEnabled(id, subcommand === "enable");
    console.log(
      `${subcommand === "enable" ? "Enabled" : "Disabled"} ${entry.id} "${entry.label}". ` +
        "Run `fullstackgtm schedule install` to update the crontab block.",
    );
    return;
  }

  if (subcommand === "run") {
    const id = positionalArg(rest, "Usage: fullstackgtm schedule run <id>");
    const entry = await store.get(id);
    if (!entry) throw new Error(`No schedule with id ${id} in profile "${activeProfile()}".`);
    if (!entry.enabled) {
      throw new Error(`Schedule ${id} is disabled — enable it with \`fullstackgtm schedule enable ${id}\`.`);
    }
    const trigger = (option(rest, "--trigger") ?? "manual") as ScheduleRunTrigger;
    if (trigger !== "cron" && trigger !== "manual") {
      throw new Error("--trigger must be cron or manual");
    }
    const run = await executeScheduledRun(entry, trigger);
    if (run.exitCode !== 0) process.exitCode = run.exitCode;
    return;
  }

  if (subcommand === "install" || subcommand === "uninstall") {
    requireLocalScheduleProvider(option(rest, "--provider") ?? "local");
    const profile = activeProfile();
    const io = systemCrontabIo();
    const existing = io.read();
    if (subcommand === "uninstall") {
      io.write(replaceManagedBlock(existing, profile, null));
      console.log(`Removed the fullstackgtm managed crontab block for profile "${profile}" (lines outside the sentinels untouched).`);
      return;
    }
    const enabled = (await store.list()).filter((entry) => entry.enabled && entry.provider === "local");
    if (enabled.length === 0) {
      io.write(replaceManagedBlock(existing, profile, null));
      console.log(`No enabled schedules for profile "${profile}" — removed the managed block.`);
      return;
    }
    const block = renderManagedBlock(profile, enabled, scheduleCliInvocation());
    io.write(replaceManagedBlock(existing, profile, block));
    console.log(
      `Installed ${enabled.length} schedule(s) into the managed crontab block for profile "${profile}". ` +
        "Re-running install replaces the block wholesale; `schedule uninstall` removes it.",
    );
    return;
  }

  if (subcommand === "status") {
    const id = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    const entries = await store.list();
    const selected = id ? entries.filter((entry) => entry.id === id) : entries;
    if (id && selected.length === 0) throw new Error(`No schedule with id ${id}.`);
    if (selected.length === 0) {
      console.log('No schedules. Add one with `fullstackgtm schedule add "<command>" --cron "<expr>"`.');
      return;
    }
    const showRuns = numericOption(rest, "--runs");
    const now = new Date();
    const report = [] as Array<Record<string, unknown>>;
    for (const entry of selected) {
      const runs = await runStore.list(entry.id);
      const last = runs.length > 0 ? runs[runs.length - 1] : null;
      let streak = 0;
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        if ((runs[index].exitCode === 0) !== (last!.exitCode === 0)) break;
        streak += 1;
      }
      const missed = computeMissedFirings(entry, runs, now);
      report.push({
        id: entry.id,
        label: entry.label,
        argv: entry.argv,
        cron: entry.cron,
        enabled: entry.enabled,
        nextFiring: entry.enabled ? safeNextFiring(entry.cron, now) : null,
        lastRun: last
          ? {
              firedAt: last.firedAt,
              trigger: last.trigger,
              exitCode: last.exitCode,
              noopReason: last.noopReason,
              artifacts: last.artifacts,
            }
          : null,
        streak: last ? { outcome: last.exitCode === 0 ? "success" : "failure", length: streak } : null,
        missedFirings: missed.missed.map((firing) => firing.toISOString()),
        missedFiringsCapped: missed.capped,
        runs: showRuns !== undefined ? runs.slice(-showRuns) : undefined,
      });
    }
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    for (const entry of report) {
      const last = entry.lastRun as { firedAt: string; trigger: string; exitCode: number; noopReason?: string; artifacts: { planIds: string[]; runLabels: string[] } } | null;
      const streak = entry.streak as { outcome: string; length: number } | null;
      const missed = entry.missedFirings as string[];
      console.log(`${entry.id}  ${entry.enabled ? "on " : "off"}  ${entry.cron}  ${entry.label}: ${(entry.argv as string[]).join(" ")}`);
      console.log(`  next: ${entry.nextFiring ?? "— (disabled)"}`);
      if (last) {
        const artifacts = [
          ...last.artifacts.planIds.map((planId) => `plan ${planId}`),
          ...last.artifacts.runLabels.map((runLabel) => `run ${runLabel}`),
        ];
        console.log(
          `  last: ${last.firedAt} (${last.trigger}) exit ${last.exitCode}` +
            (last.noopReason ? ` — no-op: ${last.noopReason}` : "") +
            (artifacts.length ? ` — ${artifacts.join(", ")}` : ""),
        );
        console.log(`  streak: ${streak!.length} ${streak!.outcome}(s)`);
      } else {
        console.log("  last: never fired");
      }
      if (missed.length > 0) {
        console.log(
          `  missed: ${missed.length}${entry.missedFiringsCapped ? "+" : ""} expected firing(s) with no run record ` +
            `(latest: ${missed[missed.length - 1]}) — local cron has no catch-up; this is visibility only`,
        );
      }
      const runs = entry.runs as ScheduleRunRecord[] | undefined;
      if (runs) {
        for (const run of runs) {
          console.log(`    ${run.firedAt}  ${run.trigger.padEnd(6)} exit ${run.exitCode}${run.noopReason ? `  no-op: ${run.noopReason}` : ""}`);
        }
      }
    }
    return;
  }

  throw new Error(
    `Unknown schedule subcommand: ${subcommand} (try: add, list, remove, enable, disable, run, install, uninstall, status)`,
  );
}

function positionalArg(rest: string[], usage: string): string {
  const value = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
  if (!value) throw new Error(usage);
  return value;
}

function safeNextFiring(cron: string, now: Date): string | null {
  try {
    return nextCronFiring(parseCron(cron), now).toISOString();
  } catch {
    return null;
  }
}

/** The provider seam: local ships now; modal/aws arrive as scaffold generators. */
function requireLocalScheduleProvider(provider: string) {
  if (provider === "local") return;
  if (provider === "modal" || provider === "aws") {
    throw new Error(
      `Provider "${provider}" is not yet implemented — it will be a scaffold generator that emits a ` +
        "deploy-ready artifact whose runner calls the same `schedule run <id>` contract. MVP provider: local.",
    );
  }
  throw new Error(`Unknown provider "${provider}" — not yet implemented. MVP provider: local.`);
}

/**
 * Resolve how cron should invoke this CLI: the current node binary plus the
 * entry script (source checkouts need --experimental-strip-types), with
 * FSGTM_HOME pinned when set so the cron environment sees the same store.
 */
function scheduleCliInvocation(): string {
  const script = process.argv[1] ? resolve(process.argv[1]) : null;
  if (!script || !existsSync(script)) {
    throw new Error("Cannot resolve the fullstackgtm entry point for crontab lines (process.argv[1] is missing).");
  }
  // A newline/control char in any of these flows verbatim into the crontab
  // executable line; single-quote escaping defends the shell, not cron's line
  // parser. Refuse early with a clear message (renderManagedBlock re-checks).
  for (const [name, value] of [
    ["FSGTM_HOME", process.env.FSGTM_HOME],
    ["the node executable path", process.execPath],
    ["the CLI script path", script],
  ] as const) {
    if (value && hasControlChar(value)) {
      throw new Error(`Cannot install schedules: ${name} contains a newline or control character.`);
    }
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const parts = [quote(process.execPath)];
  if (script.endsWith(".ts")) parts.push("--experimental-strip-types");
  parts.push(quote(script));
  const home = process.env.FSGTM_HOME ? `FSGTM_HOME=${quote(process.env.FSGTM_HOME)} ` : "";
  // cron treats an unescaped `%` in the command field as a newline/stdin split.
  // Escape it as `\%` so a stray `%` in a path can't truncate the managed line.
  return (home + parts.join(" ")).replace(/%/g, "\\%");
}

/**
 * The single provider entry point: execute the scheduled command in-process
 * (dispatch into the CLI router — never a shell), capture the output tail and
 * exit code as a run record, and hand the exit code back to the caller. Cron
 * calls it, cloud providers will call it, and a human running it manually
 * produces the same record (trigger: manual).
 *
 * Governance re-checks happen here, not just at `add` time: the allowlist is
 * re-validated (schedules.json is user-editable), and a scheduled apply
 * hard-checks the plan is approved — an unapproved plan records a
 * plan_not_approved no-op run and does NOT execute. Scheduling never
 * auto-approves.
 */
async function executeScheduledRun(
  entry: ScheduleEntry,
  trigger: ScheduleRunTrigger,
): Promise<ScheduleRunRecord> {
  const runStore = createFileScheduleRunStore();
  const firedAt = new Date().toISOString();
  const noop = async (
    reason: NonNullable<ScheduleRunRecord["noopReason"]>,
    exitCode: number,
    message: string,
  ): Promise<ScheduleRunRecord> => {
    const run: ScheduleRunRecord = {
      scheduleId: entry.id,
      firedAt,
      completedAt: new Date().toISOString(),
      trigger,
      exitCode,
      outputTail: message,
      artifacts: { planIds: [], runLabels: [] },
      noopReason: reason,
    };
    await runStore.record(run);
    console.error(message);
    return run;
  };

  try {
    validateSchedulableArgv(entry.argv);
  } catch (error) {
    return noop("not_schedulable", 1, error instanceof Error ? error.message : String(error));
  }
  if (entry.argv[0] === "apply") {
    const planId = option(entry.argv.slice(1), "--plan-id")!;
    const stored = await createFilePlanStore().get(planId);
    const status = stored ? stored.status : "missing";
    if (status !== "approved") {
      // The governance gate holding is not a machinery failure: exit 0, with
      // the refusal recorded on the run for `schedule status` to surface.
      return noop(
        "plan_not_approved",
        0,
        `Plan ${planId} is ${status}, not approved — scheduled apply refuses to execute. ` +
          `Scheduling never auto-approves; review and approve with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
  }

  // Artifact attribution by store diff: anything new in the plan store or the
  // enrich run store after the command ran was produced by this firing.
  const planStore = createFilePlanStore();
  const plansBefore = new Set((await planStore.list()).map((stored) => stored.plan.id));
  const enrichStore = createFileEnrichRunStore();
  const enrichBefore = new Set((await enrichStore.list()).map((run) => run.runLabel));

  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const tee =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      for (const line of args.map(String).join(" ").split("\n")) lines.push(line);
      original(...args);
    };
  console.log = tee(originalLog);
  console.error = tee(originalError);
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  let exitCode = 0;
  try {
    await runCli([...entry.argv]);
    exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    exitCode = 1;
    lines.push(error instanceof Error ? error.message : String(error));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = priorExitCode;
  }

  const planIds = (await planStore.list())
    .map((stored) => stored.plan.id)
    .filter((planId) => !plansBefore.has(planId));
  const runLabels = (await enrichStore.list())
    .map((run) => run.runLabel)
    .filter((runLabel) => !enrichBefore.has(runLabel));
  const run: ScheduleRunRecord = {
    scheduleId: entry.id,
    firedAt,
    completedAt: new Date().toISOString(),
    trigger,
    exitCode,
    outputTail: lines.slice(-50).join("\n"),
    artifacts: { planIds, runLabels },
  };
  await runStore.record(run);
  return run;
}

/**
 * The resolve gate: exit 0 = safe to create, exit 2 = match found (exists or
 * ambiguous — do NOT blind-create), exit 1 = error. Built for sync jobs and
 * webhook handlers to call before any record creation.
 */
async function resolveCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error("Usage: fullstackgtm resolve <account|contact|deal> [--name N] [--domain D] [--email E] [--account-id A] [source options] [--json]");
  }
  const candidate: ResolveCandidate = {
    objectType: objectType as ResolveCandidate["objectType"],
    name: option(rest, "--name") ?? undefined,
    domain: option(rest, "--domain") ?? undefined,
    email: option(rest, "--email") ?? undefined,
    accountId: option(rest, "--account-id") ?? undefined,
  };
  const snapshot = await readSnapshot(rest);
  const result = resolveRecord(snapshot, candidate);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const marker = result.verdict === "safe_to_create" ? "✓" : result.verdict === "exists" ? "=" : "?";
    console.log(`${marker} [${result.verdict}] ${result.reason}`);
    for (const m of result.matches) {
      console.log(`    ${m.id} "${m.name}" — matched by ${m.matchedBy}: ${m.detail}`);
    }
  }
  if (result.verdict !== "safe_to_create") process.exitCode = 2;
}

/**
 * Governed generic writes: build a dry-run patch plan from a snapshot filter
 * plus field assignments (or --archive). Never writes — approve and apply the
 * plan like any audit plan; compare-and-set protects every operation.
 */
async function bulkUpdateCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error(
      "Usage: fullstackgtm bulk-update <account|contact|deal> --where <field=value|field!=value|field~substr|field:empty|field:notempty> [--where …] (--set <field>=<value> [--set …] | --archive) [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]",
    );
  }
  const where = repeatedOption(rest, "--where");
  const set: Record<string, string> = {};
  for (const pair of repeatedOption(rest, "--set")) {
    const separator = pair.indexOf("=");
    if (separator === -1) throw new Error(`--set must look like <field>=<value>, got "${pair}"`);
    set[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  const snapshot = await readSnapshot(rest);
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: objectType as "account" | "contact" | "deal",
    where,
    set: Object.keys(set).length > 0 ? set : undefined,
    archive: rest.includes("--archive"),
    forceArchiveDuplicates: rest.includes("--force-archive-duplicates"),
    createTask: option(rest, "--create-task") ?? undefined,
    require: repeatedOption(rest, "--require"),
    guard: repeatedOption(rest, "--guard"),
    reason: option(rest, "--reason") ?? undefined,
    maxOperations: numericOption(rest, "--max-operations"),
    // --today resolves the comparison `today` literal (e.g. closeDate<today);
    // defaults to the system date inside buildBulkUpdatePlan when omitted.
    today: option(rest, "--today") ?? undefined,
  });
  await emitPlan(plan, rest);
}

/** Shared plan output plumbing: --out, --save (with the approve/apply hint), --json or markdown. */
async function emitPlan(plan: PatchPlan, args: string[]) {
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (args.includes("--save")) {
    await createFilePlanStore().save(plan);
    console.error(
      `Saved plan ${plan.id} (${plan.operations.length} operations). Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`, then \`fullstackgtm apply --plan-id ${plan.id} --provider <name>\`.`,
    );
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(patchPlanToMarkdown(plan));
  }
}

/**
 * Governed duplicate cleanup: group by a normalized identity key, propose one
 * merge_records per duplicate group with a deterministic survivor. Never
 * writes — approve and apply the plan like any audit plan.
 */
async function dedupeCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error(
      "Usage: fullstackgtm dedupe <account|contact|deal> --key <domain|email|name> [--keep richest|oldest] [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]",
    );
  }
  const key = option(rest, "--key");
  if (!key || !["domain", "email", "name"].includes(key)) {
    throw new Error("dedupe requires --key <domain|email|name> (the identity field duplicates share).");
  }
  const keep = option(rest, "--keep") ?? undefined;
  const snapshot = await readSnapshot(rest);
  const plan = buildDedupePlan(snapshot, {
    objectType: objectType as DedupeOptions["objectType"],
    key: key as DedupeOptions["key"],
    keep: (keep ?? undefined) as DedupeOptions["keep"],
    reason: option(rest, "--reason") ?? undefined,
    maxOperations: numericOption(rest, "--max-operations"),
  });
  await emitPlan(plan, rest);
}

/**
 * Ownership handoff playbook: compile one bulk-update-style plan per object
 * type. Each plan carries its full filter, so eligibility (including the
 * --except-deal-stage exclusion) is re-verified per record at apply time.
 */
async function reassignCommand(args: string[]) {
  const from = option(args, "--from");
  const to = option(args, "--to");
  if (!from || !to) {
    throw new Error(
      "Usage: fullstackgtm reassign --from <ownerId> --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--except-deal-stage <stage>] [--include-closed-deals] [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]",
    );
  }
  const objects = option(args, "--objects")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) as ReassignObjectType[] | undefined;
  const snapshot = await readSnapshot(args);
  const plans = buildReassignPlans(snapshot, {
    fromOwnerId: from,
    toOwnerId: to,
    objects,
    where: repeatedOption(args, "--where"),
    exceptDealStage: option(args, "--except-deal-stage") ?? undefined,
    includeClosedDeals: args.includes("--include-closed-deals"),
    reason: option(args, "--reason") ?? undefined,
    maxOperations: numericOption(args, "--max-operations"),
  });
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plans, null, 2)}\n`);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plans, null, 2));
    return;
  }
  const store = args.includes("--save") ? createFilePlanStore() : null;
  for (const plan of plans) {
    if (store) await store.save(plan);
    console.log(`${plan.id}  ${String(plan.operations.length).padStart(3)} operation(s)  ${plan.title}`);
    console.log(`    ${plan.summary}`);
  }
  if (store) {
    console.log(
      `\nSaved ${plans.length} plan(s). For each: \`fullstackgtm plans show <id>\`, \`fullstackgtm plans approve <id> --operations <ids|all>\`, then \`fullstackgtm apply --plan-id <id> --provider <name>\`.`,
    );
  } else {
    console.log("\nDry run only — re-run with --save to store the plans for approval.");
  }
}

/**
 * One-shot composite for a single audit rule: audit → save → suggest →
 * approve only suggestion-backed operations meeting the confidence bar (plus
 * operations that carry concrete values and need no human input) → apply
 * (only with --yes). Every stage goes through the same gates as the manual
 * chain; placeholder values below the bar stay unapproved.
 */
async function fixCommand(args: string[]) {
  const ruleId = option(args, "--rule");
  const provider = option(args, "--provider");
  if (!ruleId || !provider) {
    throw new Error(
      "Usage: fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--today <iso>] [--yes]",
    );
  }
  const minConfidence = option(args, "--min-confidence") ?? "high";
  if (!["high", "low"].includes(minConfidence)) {
    throw new Error("--min-confidence must be high or low");
  }
  const includeCreates = args.includes("--include-creates");

  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const configured = await resolveConfiguredRules(loaded);
  const rule = configured.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    throw new Error(`Unknown rule: ${ruleId}. Available rules: ${configured.map((r) => r.id).join(", ")}`);
  }
  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;

  const snapshot = await readSnapshot(args);
  const plan = auditSnapshot(snapshot, policy, [rule]);
  if (plan.operations.length === 0) {
    console.log(`fix ${ruleId}: audit proposed 0 operations — nothing to fix.`);
    return;
  }
  const store = createFilePlanStore();
  await store.save(plan);

  const suggestions = suggestValues(plan, snapshot);
  const accepted = new Set(minConfidence === "low" ? ["high", "low"] : ["high"]);
  const overrides: Record<string, string> = {};
  let belowBar = 0;
  for (const suggestion of suggestions) {
    if (
      suggestion.suggestedValue &&
      (accepted.has(suggestion.confidence) || (includeCreates && suggestion.confidence === "create"))
    ) {
      overrides[suggestion.operationId] = suggestion.suggestedValue;
    } else {
      belowBar += 1;
    }
  }
  // Approve operations whose placeholder got a qualifying suggested value,
  // plus operations that already carry a concrete value (no human input
  // needed — nothing to guess). Everything else stays unapproved.
  const placeholderIds = new Set(suggestions.map((suggestion) => suggestion.operationId));
  const approvedIds = plan.operations
    .map((operation) => operation.id)
    .filter((id) => overrides[id] !== undefined || !placeholderIds.has(id));

  const lines = [
    `fix ${ruleId} via ${provider}:`,
    `  proposed:  ${plan.operations.length} operation(s) — plan ${plan.id} (saved)`,
    `  suggested: ${Object.keys(overrides).length} value(s) at ${minConfidence}+ confidence${includeCreates ? " (creates included)" : ""}${belowBar > 0 ? `; ${belowBar} below the bar (left unapproved)` : ""}`,
    `  approved:  ${approvedIds.length} of ${plan.operations.length}`,
  ];
  if (approvedIds.length === 0) {
    lines.push("  applied:   0 — no operation met the confidence bar");
    console.log(lines.join("\n"));
    console.log(
      `\nWiden with --min-confidence low / --include-creates, or approve manually: \`fullstackgtm plans approve ${plan.id} --operations <ids> --value <opId>=<value>\`.`,
    );
    return;
  }
  await store.approveOperations(plan.id, approvedIds, overrides);

  if (!args.includes("--yes")) {
    lines.push("  applied:   0 (stopped before apply — pass --yes to write)");
    console.log(lines.join("\n"));
    console.log(`\nApply with:\n  fullstackgtm apply --plan-id ${plan.id} --provider ${provider}`);
    return;
  }
  const connector = await connectorFor(provider, args);
  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: approvedIds,
    valueOverrides: overrides,
  });
  await store.recordRun(plan.id, run);
  const counts: Record<string, number> = { applied: 0, conflict: 0, skipped: 0, failed: 0 };
  for (const result of run.results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  lines.push(
    `  applied:   ${counts.applied} · conflicts: ${counts.conflict} · skipped: ${counts.skipped} · failed: ${counts.failed}`,
  );
  console.log(lines.join("\n"));
  if (run.status === "failed") process.exitCode = 1;
}

async function suggest(args: string[]) {
  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) throw new Error("suggest requires --plan <path> or --plan-id <id>");
  let plan: PatchPlan;
  if (planId) {
    const stored = await createFilePlanStore().get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    plan = stored.plan;
  } else {
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath!), "utf8")) as PatchPlan;
  }

  const snapshot = await readSnapshot(args);
  const suggestions = suggestValues(plan, snapshot);
  const payload = { planId: planId ?? planPath, suggestions };

  const outPath = option(args, "--out");
  if (outPath) writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(payload, null, 2)}\n`);

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (suggestions.length === 0) {
    console.log("No requires_human_* placeholder operations in this plan — nothing to suggest.");
    return;
  }
  const byConfidence: Record<string, number> = {};
  for (const s of suggestions) byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
  console.log(`Suggestions for ${suggestions.length} placeholder operation(s):\n`);
  for (const s of suggestions) {
    const marker =
      s.confidence === "high" ? "✓" : s.confidence === "low" ? "~" : s.confidence === "create" ? "+" : "✗";
    console.log(`${marker} [${s.confidence}] ${s.operationId} ${s.objectName ?? s.objectId}`);
    console.log(`    ${s.suggestedValue ? `→ ${s.suggestedValue}` : "(no suggestion)"} — ${s.reason}`);
  }
  console.log(`\n${Object.entries(byConfidence).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  if (planId && (byConfidence.high ?? 0) > 0 && !outPath) {
    console.log(
      `\nChain it:\n  fullstackgtm suggest --plan-id ${planId} ${snapshotSourceHint(args)}--out suggestions.json\n  fullstackgtm plans approve ${planId} --values-from suggestions.json\n  fullstackgtm apply --plan-id ${planId} --provider <name>`,
    );
  }
}

function snapshotSourceHint(args: string[]) {
  const provider = option(args, "--provider");
  if (provider) return `--provider ${provider} `;
  const input = option(args, "--input");
  if (input) return `--input ${input} `;
  return "";
}

function readSuggestionValues(path: string, minConfidence: string, includeCreates: boolean) {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as {
    suggestions?: ValueSuggestion[];
  };
  if (!Array.isArray(raw.suggestions)) {
    throw new Error(
      `${path} is not a suggestions file (expected { suggestions: [...] } from \`fullstackgtm suggest --out\`).`,
    );
  }
  const accepted = new Set(minConfidence === "low" ? ["high", "low"] : ["high"]);
  const overrides: Record<string, string> = {};
  let skipped = 0;
  for (const s of raw.suggestions) {
    if (!s.suggestedValue) continue;
    if (accepted.has(s.confidence) || (includeCreates && s.confidence === "create")) {
      overrides[s.operationId] = s.suggestedValue;
    } else {
      skipped += 1;
    }
  }
  return { overrides, skipped };
}

async function auditLogCommand(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || (sub !== "export" && sub !== "verify")) {
    console.log(`Usage:
audit-log export [--out <path>] [--json]   hash-chained, signed record of every apply run
audit-log verify [--in <path>]             re-check an exported log's chain and signature

export flattens every apply run across all stored plans (this profile) into a
tamper-evident chain — each entry carries the prior entry's hash, and the chain
head is HMAC-signed with this install's key — so a change-management process can
archive one file and later prove it was not edited. verify recomputes the chain
and (if the signing key is present) the signature.`);
    return;
  }

  if (sub === "export") {
    const plans = await createFilePlanStore().list();
    const log = buildAuditLog(plans, new Date().toISOString());
    const payload = `${JSON.stringify(log, null, 2)}\n`;
    const outPath = option(rest, "--out");
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), payload);
      console.log(`Wrote ${outPath}: ${log.entryCount} run(s), chain head ${log.chainHead.slice(0, 12)}${log.signature ? " (signed)" : " (unsigned — no signing key on this install)"}.`);
    } else if (rest.includes("--json")) {
      console.log(payload);
    } else {
      console.log(`${log.entryCount} apply run(s); chain head ${log.chainHead.slice(0, 12)}${log.signature ? ", signed" : ", unsigned"}. Pass --out <path> to archive, or --json to print.`);
    }
    return;
  }

  // verify
  const inPath = option(rest, "--in");
  if (!inPath) throw new Error("audit-log verify requires --in <exported-log.json>");
  const log = JSON.parse(readFileSync(resolve(process.cwd(), inPath), "utf8")) as Parameters<typeof verifyAuditLog>[0];
  const result = verifyAuditLog(log);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.ok ? `OK — ${result.detail}` : `TAMPERED — ${result.detail}`);
  }
  if (!result.ok) process.exitCode = 2;
}

async function apply(args: string[]) {
  const provider = option(args, "--provider");
  if (!provider) throw new Error("apply requires --provider <name>");

  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) throw new Error("apply requires --plan <path> or --plan-id <id>");

  let plan: PatchPlan;
  let approvedOperationIds: string[];
  let valueOverrides: Record<string, unknown>;
  const store = planId ? createFilePlanStore() : null;

  if (planId && store) {
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (stored.status !== "approved") {
      throw new Error(
        `Plan ${planId} is ${stored.status}; approve operations first with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
    plan = stored.plan;
    approvedOperationIds = stored.approvedOperationIds;
    // Downgrade guard: an approved plan with no signatures is either pre-0.26
    // (re-approve to gain them) or had its approvalDigests stripped to skip the
    // integrity check. Either way, refuse rather than fall back to trusting the
    // file. (A plan with zero approved operations has nothing to apply anyway.)
    if (stored.approvedOperationIds.length > 0 && !stored.approvalDigests) {
      throw new Error(
        `Refusing to apply plan ${planId}: it was approved without integrity signatures ` +
          "(approved before 0.26.0, or its signatures were removed). Re-approve it with " +
          `\`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
    // Integrity gate: the plan file is re-read from disk, so verify each approved
    // operation still matches what was signed at approval. Verify against the
    // EFFECTIVE overrides (stored ∪ apply-time --value): the invariant is "what
    // gets written must equal what was signed", so an apply-time --value that
    // changes a value the human did not approve is treated as tamper, not a live
    // override. A mismatch means the plan/overrides were edited after approval —
    // refuse the whole apply rather than write an unapproved value.
    valueOverrides = { ...stored.valueOverrides, ...parseValueOverrides(args) };
    const verification = verifyApprovalDigests(
      stored.plan.operations,
      stored.approvedOperationIds,
      valueOverrides,
      stored.approvalDigests,
    );
    if (!verification.ok) {
      const detail =
        verification.reason === "no_key"
          ? "the plan-signing key is missing (was this plan approved on another machine?). Re-approve it here with `fullstackgtm plans approve`."
          : `these operations differ from what was approved: ${verification.tampered.join(", ")}. ` +
            "If you changed a value at apply time, set it at approval instead (`plans approve --value <op>=<v>`) and re-approve; " +
            "otherwise the plan was edited after approval — review and re-approve.";
      throw new Error(`Refusing to apply plan ${planId}: ${detail}`);
    }
  } else {
    const approve = option(args, "--approve");
    if (!approve) {
      throw new Error('apply requires --approve <ids|all>; nothing is written without approval');
    }
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath!), "utf8")) as PatchPlan;
    approvedOperationIds =
      approve === "all"
        ? plan.operations.map((operation) => operation.id)
        : approve.split(",").map((id) => id.trim()).filter(Boolean);
    valueOverrides = parseValueOverrides(args);
  }

  // Acquire meter: create_record ops are budgeted. Refuse up-front if the
  // approved creates would exceed the current budget window (the plan was
  // capped when `enrich acquire` ran, but the budget may have been spent down
  // since), then charge the meter for what actually lands.
  const approvedSet = new Set(approvedOperationIds);
  const createOps = plan.operations.filter(
    (op) => op.operation === "create_record" && approvedSet.has(op.id),
  );
  const createSpend = (op: PatchOperation) =>
    ((op.afterValue as CreateRecordPayload | undefined)?.estCostUsd) ?? 0;
  if (createOps.length > 0) {
    const acquireConfig = tryLoadAcquireConfig(args)?.acquire;
    if (acquireConfig?.budget) {
      const now = new Date();
      const head = remaining(loadMeter(now), acquireConfig.budget, 0, now);
      const approvedSpend = createOps.reduce((sum, op) => sum + createSpend(op), 0);
      const refusals: string[] = [];
      if (head.records.day !== null && createOps.length > head.records.day)
        refusals.push(`${createOps.length} creates > ${head.records.day} record(s) left today`);
      if (head.records.month !== null && createOps.length > head.records.month)
        refusals.push(`${createOps.length} creates > ${head.records.month} record(s) left this month`);
      if (head.spendUsd.day !== null && approvedSpend > head.spendUsd.day)
        refusals.push(`$${approvedSpend.toFixed(2)} > $${head.spendUsd.day.toFixed(2)} spend left today`);
      if (head.spendUsd.month !== null && approvedSpend > head.spendUsd.month)
        refusals.push(`$${approvedSpend.toFixed(2)} > $${head.spendUsd.month.toFixed(2)} spend left this month`);
      if (refusals.length > 0) {
        throw new Error(
          `Refusing to apply: acquire budget exceeded (${refusals.join("; ")}). ` +
            "Re-run `fullstackgtm enrich acquire` to re-cap to the remaining budget, or wait for the window to reset.",
        );
      }
    }
  }

  const connector = await connectorFor(provider, args);
  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds,
    valueOverrides,
  });
  if (planId && store) {
    await store.recordRun(planId, run);
  }

  // Charge the acquire meter for the creates that actually landed.
  if (createOps.length > 0) {
    const appliedIds = new Set(
      run.results.filter((result) => result.status === "applied").map((result) => result.operationId),
    );
    const landed = createOps.filter((op) => appliedIds.has(op.id));
    if (landed.length > 0) {
      const spend = landed.reduce((sum, op) => sum + createSpend(op), 0);
      recordConsumption(new Date(), landed.length, spend);
    }
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    console.log(formatPatchPlanRun(run));
  }
  if (run.status === "failed") process.exitCode = 1;
}

async function diffCommand(args: string[]) {
  const beforePath = option(args, "--before");
  const afterPath = option(args, "--after");
  if (!beforePath || !afterPath) {
    throw new Error("diff requires --before <snapshot.json> and --after <snapshot.json>");
  }
  const before = JSON.parse(
    readFileSync(resolve(process.cwd(), beforePath), "utf8"),
  ) as CanonicalGtmSnapshot;
  const after = JSON.parse(
    readFileSync(resolve(process.cwd(), afterPath), "utf8"),
  ) as CanonicalGtmSnapshot;

  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded));
  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;
  const staleDealDays = numericOption(args, "--stale-days");
  if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;

  const diff = diffSnapshots(before, after);
  const drift = diffFindings(
    auditSnapshot(before, policy, rules),
    auditSnapshot(after, policy, rules),
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify({ diff, drift }, null, 2));
  } else {
    console.log(diffToMarkdown(diff, drift));
  }
  if (args.includes("--fail-on-new-findings") && drift.newFindings.length > 0) {
    process.exitCode = 2;
  }
}

async function mergeCommand(args: string[]) {
  const inputs = repeatedOption(args, "--input");
  if (inputs.length < 2) {
    throw new Error("merge requires at least two --input <snapshot.json> sources");
  }
  const out = option(args, "--out");
  if (!out) throw new Error("merge requires --out <merged.json>");

  const snapshots = inputs.map(
    (input) =>
      JSON.parse(readFileSync(resolve(process.cwd(), input), "utf8")) as CanonicalGtmSnapshot,
  );
  const { snapshot, report } = mergeSnapshots(snapshots);
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(snapshot, null, 2)}\n`);

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Merged ${report.sources.join(" + ")} into ${out}.`);
  for (const type of ["user", "account", "contact"] as const) {
    const count = report.matches.filter((match) => match.type === type).length;
    console.log(`  ${type} merges: ${count}`);
  }
  console.log(`  conflicts: ${report.conflicts.length}`);
  for (const conflict of report.conflicts) {
    console.log(
      `    ${conflict.type}/${conflict.recordId} ${conflict.field}: ${conflict.values
        .map((entry) => `${entry.provider}=${JSON.stringify(entry.value)}`)
        .join(" vs ")}`,
    );
  }
  if (report.suggestions.length > 0) {
    console.log(`  review suggestions (same name, not auto-merged): ${report.suggestions.length}`);
    for (const suggestion of report.suggestions) {
      console.log(`    "${suggestion.name}": ${suggestion.recordIds.join(", ")}`);
    }
  }
  console.log(`Audit the merged view with \`fullstackgtm audit --input ${out}\`.`);
}

async function plansCommand(args: string[]) {
  const store = createFilePlanStore();
  const [subcommand, ...rest] = args;

  if (subcommand === "list" || subcommand === undefined) {
    const status = option(rest, "--status") as
      | "draft" | "needs_approval" | "approved" | "rejected" | "applied"
      | null;
    const plans = await store.list(status ?? undefined);
    if (rest.includes("--json") || args.includes("--json")) {
      console.log(
        JSON.stringify(
          plans.map((stored) => ({
            id: stored.plan.id,
            status: stored.status,
            summary: stored.plan.summary,
            approvedOperations: stored.approvedOperationIds.length,
            runs: stored.runs.length,
            createdAt: stored.createdAt,
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (plans.length === 0) {
      console.log("No stored plans. Create one with `fullstackgtm audit ... --save`.");
      return;
    }
    for (const stored of plans) {
      console.log(
        `${stored.plan.id}  ${stored.status.padEnd(14)} ${stored.plan.summary} (${stored.approvedOperationIds.length} approved, ${stored.runs.length} runs)`,
      );
    }
    return;
  }

  if (subcommand === "show") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans show <planId>");
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(stored, null, 2));
      return;
    }
    console.log(`Status: ${stored.status}`);
    console.log(`Approved operations: ${stored.approvedOperationIds.join(", ") || "none"}`);
    console.log(`Runs: ${stored.runs.length}`);
    console.log("");
    console.log(patchPlanToMarkdown(stored.plan));
    return;
  }

  if (subcommand === "approve") {
    const planId = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    if (!planId) throw new Error("Usage: fullstackgtm plans approve <planId> --operations <ids|all> | --values-from <suggestions.json>");
    const operations = option(rest, "--operations");
    const valuesFrom = option(rest, "--values-from");
    if (!operations && !valuesFrom) {
      throw new Error("plans approve requires --operations <ids|all> and/or --values-from <suggestions.json>");
    }
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);

    // Values from a `fullstackgtm suggest --out` file. High-confidence only by
    // default; widen with --min-confidence low, opt into record-creating
    // values (create:<Name>) with --include-creates. Explicit --value wins.
    let fileOverrides: Record<string, string> = {};
    if (valuesFrom) {
      const minConfidence = option(rest, "--min-confidence") ?? "high";
      if (!["high", "low"].includes(minConfidence)) {
        throw new Error("--min-confidence must be high or low");
      }
      const { overrides, skipped } = readSuggestionValues(
        valuesFrom,
        minConfidence,
        rest.includes("--include-creates"),
      );
      fileOverrides = overrides;
      if (Object.keys(overrides).length === 0) {
        throw new Error(
          `No suggestions in ${valuesFrom} meet the confidence bar (${skipped} below it). Re-run with --min-confidence low or --include-creates, or pass explicit --value overrides.`,
        );
      }
      if (skipped > 0) {
        console.log(`Skipped ${skipped} suggestion(s) below the confidence bar (widen with --min-confidence low / --include-creates).`);
      }
    }
    const explicitOverrides = parseValueOverrides(rest);
    const operationIds =
      operations === "all"
        ? stored.plan.operations.map((operation) => operation.id)
        : operations
          ? operations.split(",").map((id) => id.trim()).filter(Boolean)
          : Object.keys(fileOverrides);
    const updated = await store.approveOperations(planId, operationIds, {
      ...fileOverrides,
      ...explicitOverrides,
    });
    console.log(
      `Approved ${updated.approvedOperationIds.length} operation(s) on ${planId}. Apply with \`fullstackgtm apply --plan-id ${planId} --provider <name>\`.`,
    );
    return;
  }

  if (subcommand === "reject") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans reject <planId>");
    await store.reject(planId);
    console.log(`Rejected ${planId}.`);
    return;
  }

  throw new Error(`Unknown plans subcommand: ${subcommand}. Use list, show, approve, or reject.`);
}

/**
 * Read a secret without exposing it on the command line. Secrets passed as
 * argv leak through the process list (`ps`), `/proc`, and shell history, so
 * the CLI never accepts them as flags. Instead:
 *   - non-interactive: pipe it on stdin (docker `--password-stdin` style),
 *     e.g. `echo "$TOKEN" | fullstackgtm login hubspot`
 *   - interactive: prompted on the TTY with the input muted
 */
async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (!piped) {
      throw new Error(
        `No secret provided. Pipe it on stdin (e.g. \`echo "$SECRET" | fullstackgtm login ...\`) ` +
          `or run interactively. Secrets are never accepted as CLI arguments — they leak via the ` +
          `process list and shell history.`,
      );
    }
    // Multi-line stdin (rare) — take the first non-empty line.
    return piped.split(/\r?\n/)[0].trim();
  }

  const readline = await import("node:readline");
  return new Promise<string>((resolveSecret) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    let muted = false;
    const mutable = rl as unknown as { _writeToOutput?: (value: string) => void };
    mutable._writeToOutput = (value: string) => {
      if (!muted) process.stderr.write(value);
    };
    rl.question(`${label}: `, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolveSecret(answer.trim());
    });
    muted = true;
  });
}

function rejectArgvSecret(args: string[], ...flags: string[]) {
  for (const flag of flags) {
    if (args.includes(flag)) {
      throw new Error(
        `${flag} no longer accepts a value on the command line (argv secrets leak via \`ps\` and ` +
          `shell history). Pipe the secret on stdin instead, e.g. \`echo "$SECRET" | fullstackgtm login ...\`.`,
      );
    }
  }
}

/**
 * The broker channel carries a long-lived pairing bearer and receives freshly
 * minted live-CRM tokens, so it must be TLS unless it's an explicit localhost
 * dev target. Refuse http:// (and non-http schemes) otherwise — single-quote
 * shell escaping does nothing for a token sent in cleartext.
 */
export function assertSecureBrokerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--via must be a full URL (e.g. https://gtm.yourco.com), got "${raw}".`);
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalhost) return url; // local dev only
  throw new Error(
    `Refusing to pair over ${url.protocol}//${url.host}: the broker exchanges a long-lived token and mints live CRM ` +
      "credentials, so it must use https (http is allowed only for localhost dev).",
  );
}

async function brokerLogin(baseUrl: string) {
  const viaUrl = assertSecureBrokerUrl(baseUrl);
  const base = baseUrl.replace(/\/$/, "");
  const os = await import("node:os");
  // Self-reported, shown to the approver so they can recognize this request
  // and refuse one they didn't initiate.
  const requesterLabel = `${os.hostname()} (${process.platform}, ${os.userInfo().username})`;
  let startResponse: Response;
  try {
    startResponse = await fetch(`${base}/api/cli/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterLabel }),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    throw new Error(`Cannot reach the hosted deployment at ${base}${cause}. Check the --via URL and network access.`);
  }
  if (!startResponse.ok) {
    throw new Error(
      `Could not start pairing with ${base} (${startResponse.status}). Is this a FullStackGTM deployment?`,
    );
  }
  const start = await startResponse.json();
  // Only auto-open a verification URL that belongs to the --via origin the user
  // typed — a malicious/typo'd deployment cannot redirect the browser elsewhere.
  let sameOrigin = false;
  try {
    sameOrigin = new URL(start.verificationUrl).origin === viaUrl.origin;
  } catch {
    sameOrigin = false;
  }
  console.error(
    `\nPairing code: ${start.userCode}\n\nApprove this CLI ("${requesterLabel}") in your dashboard:\n\n  ${start.verificationUrl}\n`,
  );
  if (sameOrigin) {
    void openInBrowser(start.verificationUrl);
  } else {
    console.error(`(Not auto-opening: the verification URL is not on ${viaUrl.origin}. Open it manually only if you trust it.)`);
  }

  const deadline = Date.now() + (start.expiresInSeconds ?? 600) * 1000;
  const intervalMs = Math.max(0, (start.intervalSeconds ?? 3) * 1000);
  while (Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
    const pollResponse = await fetch(`${base}/api/cli/auth/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    if (!pollResponse.ok) {
      throw new Error(`Pairing poll failed (${pollResponse.status}).`);
    }
    const poll = await pollResponse.json();
    if (poll.status === "pending") continue;
    if (poll.status === "approved" && poll.cliToken) {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: poll.cliToken,
        baseUrl: base,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`Paired with ${base}. Credentials stored in ${credentialsPath()}.`);
      console.log(
        "Provider commands now use the organization's stored sync credentials via the deployment.",
      );
      return;
    }
    throw new Error(`Pairing was ${poll.status}.`);
  }
  throw new Error("Pairing timed out before it was approved.");
}

function isOptionValue(args: string[], arg: string) {
  const index = args.indexOf(arg);
  return index > 0 && args[index - 1].startsWith("--");
}

async function salesforceLogin(args: string[]) {
  const now = new Date().toISOString();

  if (args.includes("--device")) {
    const clientId = option(args, "--client-id");
    if (!clientId) {
      throw new Error(
        "--device requires --client-id (the consumer key of a Connected App with device flow enabled).",
      );
    }
    const loginUrl = option(args, "--login-url") ?? undefined;
    const authorization = await startSalesforceDeviceLogin({ clientId, loginUrl });
    console.error(
      `\nPairing code: ${authorization.userCode}\n\nConfirm this code at:\n\n  ${authorization.verificationUri}\n`,
    );
    void openInBrowser(authorization.verificationUri);
    const tokens = await pollSalesforceDeviceLogin({
      clientId,
      deviceCode: authorization.deviceCode,
      intervalSeconds: authorization.intervalSeconds,
      loginUrl,
    });
    storeCredential("salesforce", {
      kind: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      instanceUrl: tokens.instanceUrl,
      expiresAt: tokens.expiresAt,
      clientId,
      loginUrl,
      createdAt: now,
      updatedAt: now,
    });
    console.log(
      `Logged in to Salesforce (${tokens.instanceUrl}). Credentials stored in ${credentialsPath()}.`,
    );
    console.log("Tokens refresh silently; no further browser interaction is needed.");
    return;
  }

  rejectArgvSecret(args, "--token");
  const instanceUrl = option(args, "--instance-url");
  if (!instanceUrl) {
    throw new Error(
      "Salesforce login needs --device --client-id <consumer key>, or --instance-url " +
        "<https://yourorg.my.salesforce.com> with the access token piped on stdin.",
    );
  }
  const token = await readSecret("Salesforce access token");
  if (!token) throw new Error("No access token provided.");
  if (!args.includes("--no-validate")) {
    const result = await validateSalesforceToken(token, instanceUrl);
    if (!result.ok) throw new Error(result.detail);
    console.log(result.detail);
  }
  storeCredential("salesforce", {
    kind: "private_app",
    accessToken: token,
    instanceUrl,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`Logged in to Salesforce. Credentials stored in ${credentialsPath()}.`);
}

async function login(args: string[]) {
  const via = option(args, "--via");
  if (via) {
    await brokerLogin(via);
    return;
  }
  const provider = args.find((arg) => !arg.startsWith("--") && !isOptionValue(args, arg));
  if (provider === "salesforce") {
    await salesforceLogin(args);
    return;
  }
  if (provider === "stripe") {
    rejectArgvSecret(args, "--token");
    const key = await readSecret("Stripe secret key (sk_...)");
    if (!key) throw new Error("No Stripe key provided.");
    if (!args.includes("--no-validate")) {
      const response = await fetch("https://api.stripe.com/v1/customers?limit=1", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        throw new Error(`Stripe rejected the key (${response.status}): ${safeStatus(response)}`);
      }
      console.log("Key accepted by the Stripe API.");
    }
    const stamp = new Date().toISOString();
    storeCredential("stripe", {
      kind: "private_app",
      accessToken: key,
      createdAt: stamp,
      updatedAt: stamp,
    });
    console.log(`Logged in to Stripe. Credentials stored in ${credentialsPath()}.`);
    return;
  }
  if (provider === "anthropic" || provider === "openai") {
    rejectArgvSecret(args, "--token", "--key", "--api-key");
    const key = await readSecret(`${provider} API key (${provider === "anthropic" ? "sk-ant-..." : "sk-..."})`);
    if (!key) throw new Error(`No ${provider} key provided.`);
    if (!args.includes("--no-validate")) {
      const validation = await validateLlmKey(provider, key);
      if (!validation.ok) throw new Error(`${provider} rejected the key: ${validation.detail}`);
      console.log(validation.detail);
    }
    const stamp = new Date().toISOString();
    storeCredential(provider, { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
    console.log(`Stored ${provider} API key in ${credentialsPath()}. \`fullstackgtm call parse\` and \`call score\` use it automatically.`);
    return;
  }
  if (provider === "apollo") {
    rejectArgvSecret(args, "--token", "--key", "--api-key");
    const key = await readSecret("Apollo API key");
    if (!key) throw new Error("No Apollo key provided.");
    if (!args.includes("--no-validate")) {
      const response = await fetch("https://api.apollo.io/api/v1/auth/health", {
        headers: { "X-Api-Key": key, Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Apollo rejected the key: ${safeStatus(response)}`);
      }
      console.log("Key accepted by the Apollo API.");
    }
    const stamp = new Date().toISOString();
    storeCredential("apollo", { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
    console.log(`Stored Apollo API key in ${credentialsPath()}. \`fullstackgtm enrich append|refresh\` use it automatically.`);
    return;
  }
  if (provider === "pipe0" || provider === "explorium") {
    rejectArgvSecret(args, "--token", "--key", "--api-key");
    const key = await readSecret(`${provider} API key`);
    if (!key) throw new Error(`No ${provider} key provided.`);
    // No free auth-health endpoint; validating would spend credits, so the key
    // is stored as-is and validated on the first `enrich acquire` pull.
    const stamp = new Date().toISOString();
    storeCredential(provider, { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
    console.log(
      `Stored ${provider} API key in ${credentialsPath()}. \`fullstackgtm enrich acquire\` uses it automatically (validated on first pull).`,
    );
    return;
  }
  if (provider !== "hubspot") {
    throw new Error(
      "login supports: hubspot, salesforce, stripe, anthropic, openai, apollo, pipe0, explorium, or --via <hosted url>. Usage: fullstackgtm login <provider> | fullstackgtm login --via https://gtm.example.com",
    );
  }
  const now = new Date().toISOString();

  if (args.includes("--oauth")) {
    rejectArgvSecret(args, "--client-secret");
    const clientId = option(args, "--client-id");
    if (!clientId) {
      throw new Error(
        "--oauth requires --client-id from your own HubSpot app " +
          `(register http://localhost:${numericOption(args, "--port") ?? DEFAULT_LOOPBACK_PORT}/callback as a redirect URL). ` +
          "The client secret is read from stdin or an interactive prompt.",
      );
    }
    const clientSecret = await readSecret("HubSpot app client secret");
    if (!clientSecret) throw new Error("No client secret provided.");
    const scopes = option(args, "--scopes")?.split(",").map((scope) => scope.trim());
    const tokens = await runHubspotLoopbackLogin({
      clientId,
      clientSecret,
      port: numericOption(args, "--port"),
      scopes,
    });
    storeCredential("hubspot", {
      kind: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      clientId,
      clientSecret,
      scopes,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Logged in to HubSpot via OAuth. Credentials stored in ${credentialsPath()}.`);
    console.log("Tokens refresh silently; no further browser interaction is needed.");
    return;
  }

  rejectArgvSecret(args, "--token");
  const token = await readSecret("HubSpot private app token");
  if (!token) throw new Error("No token provided.");
  if (!args.includes("--no-validate")) {
    const result = await validateHubspotToken(token);
    if (!result.ok) throw new Error(result.detail);
    console.log(result.detail);
  }
  storeCredential("hubspot", {
    kind: "private_app",
    accessToken: token,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`Logged in to HubSpot. Credentials stored in ${credentialsPath()}.`);
}

function logout(args: string[]) {
  const provider = args.find((arg) => !arg.startsWith("--"));
  if (!provider) throw new Error("Usage: fullstackgtm logout hubspot");
  if (!getCredential(provider)) {
    console.log(`No stored credentials for ${provider}.`);
    return;
  }
  deleteCredential(provider);
  console.log(`Removed stored ${provider} credentials.`);
}

type ProviderDoctorStatus = {
  source: "env" | "stored" | "broker" | "none";
  detail: string;
};

export function doctorReport(env: Record<string, string | undefined> = process.env) {
  const packageInfo = readPackageInfo();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const storePath = credentialsPath();
  const configPath = resolve("fullstackgtm.config.json");
  const broker = getCredential("broker");

  const providers: Record<string, ProviderDoctorStatus> = {
    hubspot: env.HUBSPOT_ACCESS_TOKEN
      ? { source: "env", detail: "HUBSPOT_ACCESS_TOKEN" }
      : providerStatus("hubspot", broker),
    salesforce:
      env.SALESFORCE_ACCESS_TOKEN && env.SALESFORCE_INSTANCE_URL
        ? { source: "env", detail: "SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL" }
        : providerStatus("salesforce", broker),
    stripe: env.STRIPE_SECRET_KEY
      ? { source: "env", detail: "STRIPE_SECRET_KEY" }
      : providerStatus("stripe", broker),
  };

  const llm = resolveLlmCredential(env);
  const missingPeers = ["@modelcontextprotocol/sdk", "zod"].filter((name) => {
    try {
      import.meta.resolve(name);
      return false;
    } catch {
      return true;
    }
  });

  const connected = Object.entries(providers).filter(([, status]) => status.source !== "none");
  const nextSteps =
    connected.length === 0
      ? [
          "fullstackgtm audit --demo            # no credentials needed",
          "fullstackgtm login hubspot           # connect your CRM (or: login --via <hosted url>)",
        ]
      : [`fullstackgtm audit --provider ${connected[0][0]}`];

  return {
    package: packageInfo,
    node: { version: process.versions.node, ok: nodeMajor >= 20, required: ">=20" },
    profile: activeProfile(),
    credentialStore: { path: storePath, exists: existsSync(storePath) },
    config: { path: configPath, exists: existsSync(configPath) },
    providers,
    broker: broker ? { paired: true, baseUrl: broker.baseUrl ?? "unknown" } : { paired: false },
    llm: llm
      ? { configured: true, provider: llm.provider, source: llm.source }
      : { configured: false, detail: "call parse/score will prompt once, or set ANTHROPIC_API_KEY / OPENAI_API_KEY" },
    mcp: { peersInstalled: missingPeers.length === 0, missing: missingPeers },
    nextSteps,
  };
}

function providerStatus(provider: string, broker: StoredCredential | null): ProviderDoctorStatus {
  const stored = getCredential(provider);
  if (stored) {
    return { source: "stored", detail: `${stored.kind} login, updated ${stored.updatedAt}` };
  }
  if (broker) {
    return { source: "broker", detail: `via ${broker.baseUrl ?? "hosted deployment"}` };
  }
  return { source: "none", detail: `fullstackgtm login ${provider}` };
}

function readPackageInfo() {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return { name: parsed.name ?? "fullstackgtm", version: parsed.version ?? "unknown" };
  } catch {
    return { name: "fullstackgtm", version: "unknown" };
  }
}

function doctorCommand(args: string[]) {
  const report = doctorReport();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const mark = (ok: boolean) => (ok ? "ok" : "MISSING");
  const lines = [
    `Package:    ${report.package.name} ${report.package.version}`,
    `Node:       v${report.node.version} (${report.node.required} required) ${mark(report.node.ok)}`,
    `Profile:    ${report.profile}${report.profile === DEFAULT_PROFILE ? "" : " (named profile — credentials and plans are scoped to it)"}`,
    `Cred store: ${report.credentialStore.path} (${report.credentialStore.exists ? "present" : "not created yet — created on first login"})`,
    `Config:     ${report.config.exists ? report.config.path : "none — defaults apply"}`,
    "",
    "Providers:",
    ...Object.entries(report.providers).map(([provider, status]) =>
      `  ${provider.padEnd(11)} ${status.source === "none" ? `not connected (${status.detail})` : `${status.source}: ${status.detail}`}`,
    ),
    `  ${"broker".padEnd(11)} ${report.broker.paired ? `paired with ${report.broker.baseUrl}` : "not paired (fullstackgtm login --via <hosted url>)"}`,
    `  ${"llm".padEnd(11)} ${report.llm.configured ? `${report.llm.provider} key (${report.llm.source}) — call parse/score ready` : `not configured (${report.llm.detail})`}`,
    "",
    report.mcp.peersInstalled
      ? "MCP:        peers installed — `fullstackgtm-mcp` is ready"
      : `MCP:        optional peers missing (${report.mcp.missing.join(", ")}) — needed only for \`fullstackgtm-mcp\``,
    "",
    "Next step:",
    ...report.nextSteps.map((step) => `  ${step}`),
  ];
  console.log(lines.join("\n"));
  if (!report.node.ok) process.exitCode = 1;
}

/**
 * Pull the global `--profile <name>` flag out of argv (it may appear before
 * or after the command) and activate it. Stripping it keeps positional
 * detection in subcommands — `login <provider>`, `plans show <id>` — simple.
 */
function extractProfile(argv: string[]): string[] {
  const index = argv.indexOf("--profile");
  if (index === -1) return argv;
  const name = argv[index + 1];
  if (!name) throw new Error("--profile requires a name, e.g. --profile acme");
  setActiveProfile(name);
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function profilesCommand(args: string[]) {
  const profiles = listProfiles();
  const current = activeProfile();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ active: current, profiles }, null, 2));
    return;
  }
  for (const profile of profiles) {
    console.log(`${profile === current ? "*" : " "} ${profile}`);
  }
  if (!profiles.includes(current)) {
    console.log(`* ${current} (selected; created on first login)`);
  }
  console.log(
    "\nSelect with --profile <name> on any command, or set FULLSTACKGTM_PROFILE. " +
      "Each profile keeps its own credentials and stored plans.",
  );
}

export async function runCli(argv: string[]) {
  const [command, ...args] = extractProfile(argv);
  // Front door: the lifecycle-grouped map by default, the full reference on
  // --full. `help <command>` zooms into one verb. (docs/dx-punch-list.md #1)
  if (!command || command === "--help" || command === "-h") {
    console.log(args.includes("--full") ? usage() : shortUsage());
    return;
  }
  if (command === "help") {
    const [topic, ...rest] = args;
    if (topic && topic !== "--full" && !topic.startsWith("-")) {
      console.log(commandHelp(topic));
    } else {
      console.log(args.includes("--full") || topic === "--full" ? usage() : shortUsage());
    }
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(readPackageInfo().version);
    return;
  }
  // Commands without bespoke help get focused per-command help on --help
  // instead of executing (audit used to silently run the sample audit) or
  // dumping the whole surface. call/market/enrich/bulk-update/schedule print
  // their own richer help. `--full` always escapes to the complete reference.
  if (!BESPOKE_HELP.includes(command) && (args.includes("--help") || args.includes("-h"))) {
    console.log(args.includes("--full") ? usage() : commandHelp(command));
    return;
  }

  if (command === "login") {
    await login(args);
    return;
  }
  if (command === "logout") {
    logout(args);
    return;
  }
  if (command === "snapshot") {
    await snapshotCommand(args);
    return;
  }
  if (command === "audit") {
    await audit(args);
    return;
  }
  if (command === "report") {
    await reportCommand(args);
    return;
  }
  if (command === "rules") {
    await rulesCommand(args);
    return;
  }
  if (command === "doctor") {
    doctorCommand(args);
    return;
  }
  if (command === "health") {
    healthCommand(args);
    return;
  }
  if (command === "suggest") {
    await suggest(args);
    return;
  }
  if (command === "call") {
    await callCommand(args);
    return;
  }
  if (command === "resolve") {
    await resolveCommand(args);
    return;
  }
  if (command === "bulk-update") {
    await bulkUpdateCommand(args);
    return;
  }
  if (command === "dedupe") {
    await dedupeCommand(args);
    return;
  }
  if (command === "reassign") {
    await reassignCommand(args);
    return;
  }
  if (command === "fix") {
    await fixCommand(args);
    return;
  }
  if (command === "market") {
    await marketCommand(args);
    return;
  }
  if (command === "enrich") {
    await enrichCommand(args);
    return;
  }
  if (command === "icp") {
    await icpCommand(args);
    return;
  }
  if (command === "schedule") {
    await scheduleCommand(args);
    return;
  }
  if (command === "profiles") {
    profilesCommand(args);
    return;
  }
  if (command === "diff") {
    await diffCommand(args);
    return;
  }
  if (command === "merge") {
    await mergeCommand(args);
    return;
  }
  if (command === "plans") {
    await plansCommand(args);
    return;
  }
  if (command === "audit-log") {
    await auditLogCommand(args);
    return;
  }
  if (command === "apply") {
    await apply(args);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
}

# fullstackgtm — API surface (1.0 contract candidate)

Everything listed here is the intended 1.0 contract. While the package is in
beta (0.x), these surfaces are settling and breaking changes may still land
in minor releases — each one is called out in the CHANGELOG. At 1.0 they
freeze: breaking changes will require a major version. Anything *not* listed
(internal helpers, file layouts, exact message strings) may change in any
release.

## Canonical data model (`types.ts`)

- `CanonicalGtmSnapshot` — `{ generatedAt, provider, users, accounts, contacts, deals, activities }`
- `CanonicalUser`, `CanonicalAccount`, `CanonicalContact`, `CanonicalDeal`, `CanonicalActivity`
  - Amounts are **major currency units**; adapters storing minor units convert at their boundary.
  - `identities: ProviderIdentity[]` — `(provider, externalId)` claims; one per source system.
  - `raw` — provider payload escape hatch; never read by audit rules.
- `GtmPolicy` — thresholds with optional extensions (`requireDealAmount`, `closingSoonDays`, `closingSoonIdleDays`).

## Audit engine

- `GtmAuditRule` — `{ id, title, description, category?, evaluate(context) }`; the public extension point.
- `GtmRuleContext` — `{ snapshot, policy, index }` with the prebuilt O(n) `GtmSnapshotIndex`.
- `auditSnapshot(snapshot, policy?, rules?)` → `PatchPlan`.
- `builtinAuditRules` (12 rules) plus each rule exported individually.
- **Determinism guarantee**: identical inputs produce identical findings and operations with identical ids (`auditFindingId`, `patchOperationId` are stable hashes of rule + record).

## Patch plans and application

- `PatchPlan` — immutable dry-run proposal (`dryRun: true` always).
- `PatchOperation` — typed write: objectType, objectId, operation kind, field, before/after, reason, riskLevel, approvalRequired.
- `applyPatchPlan(connector, plan, options)` → `PatchPlanRun`. The safety contract:
  1. only operation ids in `approvedOperationIds` are written;
  2. `requires_human_*` placeholder values are never written without a `valueOverrides` entry;
  3. compare-and-set: with `readField` support, drifted values produce `conflict` results instead of writes (`checkConflicts: false` opts out);
  4. every operation yields a `PatchOperationResult` (`applied | failed | skipped | conflict`).
- `PlanStore` / `createFilePlanStore` — durable lifecycle: save → approve operations (+ value overrides) → record runs.

## Connectors

- `GtmConnector` — `{ provider, fetchSnapshot(), applyOperation?, applyCreateContactsBatch?, applyBatch?, applyBatchLimit?, readField?, fetchChanges? }`.
  - Connectors never silently drop unresolvable records; audits surface them.
  - `fetchChanges(sinceIso)` returns a partial snapshot; change feeds may omit associations.
  - `applyBatch?(operations)` — optional bulk apply path for consecutive homogeneous `set_field`, `clear_field`, or `archive_record` runs selected by `applyPatchPlan`. It must return one result per input operation; field-write implementations preserve CAS by batch-reading live target values first and writing only clean records. Connectors without it stay on the sequential `applyOperation` path. `applyBatchLimit?` declares max operations per `applyBatch` call (default 200; Salesforce 200, HubSpot 100). Salesforce uses SOQL `IN` CAS reads plus Composite sObject Collections update/delete (`allOrNone:false`); HubSpot uses batch/read + batch/update/archive.
  - `applyCreateContactsBatch?(operations)` — optional bulk fast-path for
    independent `create_record` contact ops. `applyPatchPlan` routes safe-to-batch
    creates here (batched resolve-first + batched create — ~N/100 calls instead of
    ~2N), and falls back to `applyOperation` per record on a batch rejection and
    for any op that isn't batch-safe (grouped, value-overridden, company-
    associated, conflicted). HubSpot: `search IN` + `batch/create`; Salesforce:
    SOQL `IN` + Composite sObject Collections (`allOrNone:false`).
- `createHubspotConnector(options)` — read/write/readField/fetchChanges. `applyOperation` implements every `PatchOperationType`: `set_field`, `clear_field`, `link_record`, `create_task`, `create_record` (resolve-first net-new contact/company/**deal** create — re-checks the dedupe key at apply, never double-creates; a deal create requires `dealStage: "closed_won"`, resolved to the target pipeline's real closed-won stage id from pipeline metadata, and its dedupe key is a custom deal property ensured on demand), `archive_record`, `merge_records` (HubSpot v3 merge — pairwise, irreversible; survivor must belong to the duplicate group). (The Salesforce connector implements the same operation set, with the platform-specific constraints noted below.)
- `createSalesforceConnector(options)` — read/write/readField/fetchChanges; probabilities normalized to 0..1. `applyOperation` implements every operation type, with two platform constraints: `merge_records` covers **Accounts and Contacts** only (Salesforce exposes no Opportunity merge), and `create_record` resolve-first creates **contacts/accounts** (SOQL search on the match key, create only on a confirmed miss; stamps the canonical `ownerId` onto `OwnerId`).
- `createStripeConnector(options)` — read-only billing by design (`applyOperation` returns `skipped`); email domains are the cross-system merge keys. Implements `fetchChanges` (incremental via `created[gte]`).
- `fetchStripePaidInvoices(options, { sinceIso? })` — paginated `status=paid` invoice reads (`created[gte]` incremental, cents→major, paid-date extraction); feeds `buildStripeBackfillPlan(invoices, snapshot, opts)` (`src/backfill.ts`), which proposes one closed-won deal `create_record` per paid invoice, matched to CRM accounts by billing-email domain then exact name — an unmatched customer gets an explicit proposed account `create_record` in the same plan (freemail domains never used as company domain; `createMissingAccounts: false` restores report-only). Surfaced as the `backfill stripe` verb (plan-only; `--save` → approve → `apply`).

## Multi-system operations

- `mergeSnapshots(snapshots)` → `{ snapshot, report }` — entity resolution on email/domain/name keys; identities accumulate; first source wins on conflicts and every conflict is reported.
- `diffSnapshots(before, after)` → record/field-level changes; `diffFindings(beforePlan, afterPlan)` → hygiene drift on stable ids.

## Configuration

- `fullstackgtm.config.json`: `{ policy?, rules?: { enabled?, disabled? }, rulePackages? }`.
- Rule packages export `rules: GtmAuditRule[]`.
- Precedence: CLI flags > config file > defaults.

## CLI

Commands: `init`, `login` / `logout`, `snapshot`, `audit`, `report`, `diff`, `merge`, `plans`,
`apply`, `suggest`, `audit-log` (`export` / `verify`),
`call` (`parse` / `classify` / `score` / `link` / `plan`), `resolve`,
`hierarchy` (`report`), `relationships` (`account`),
`route` (`leads`), `bulk-update`, `dedupe`, `reassign`, `fix`, `health`,
`market` (`init` / `capture` / `classify` / `worksheet` / `observe` / `fronts` /
`axes` / `overlay` / `scale` / `report` / `refresh`),
`tam` (`estimate` / `accounts` / `status` / `report` / `populate`),
`enrich` (`append` / `refresh` / `ingest` / `acquire` / `status`),
`icp` (`interview` / `set` / `show` / `judge` / `eval`),
`signals` (`fetch` / `list` / `outcome` / `weights`), `draft`,
`schedule` (`add` / `list` / `remove` / `enable` / `disable` / `run` /
`install` / `uninstall` / `status`), `rules`, `profiles`, `doctor`,
`capabilities`, `robot-docs`.
Exit codes: `0` success · `1` error · `2` findings/regressions at the requested gate
(`--fail-on`, `--fail-on-new-findings`). `--json` everywhere; JSON output shapes are stable.

Agent discovery: `capabilities` prints the machine-readable CLI contract —
the command inventory with read-only vs write-shaped access (derived from the
help table, not a parallel list), this exit-code contract, and safety
defaults. `<command> --help --json` (and `help <command> --json`) prints
per-command help as JSON. Unknown commands with `--json` return a structured
`UNKNOWN_COMMAND` envelope with a did-you-mean hint; the plain-text path
prints the same hint plus pointers to `--help` and `capabilities --json`.
`robot-docs` prints the packaged agent guide (skills/fullstackgtm/SKILL.md).

Intent inference: a `--flag` that is documented nowhere in the help reference
but is within one edit of a documented flag (lowercased, `_`→`-`) is treated
as a typo — exit 1 with `Did you mean` and the exact corrected command
(structured `UNKNOWN_FLAG` envelope under `--json`). GNU-style `--flag=value`
spellings of documented flags get the space-separated correction this CLI
parses. Corrections are suggest-only, never auto-executed. Unknown flags with
no near-miss are ignored, as before. Unknown `--provider` values and subverb
typos on the multi-verb commands (`enrich apend` → `enrich append`) get
nearest-match suggestions; a flag-shaped first token is diagnosed as
flag-before-command.

Triage: `doctor --json` returns environment status plus a `workspace` slice
(`healthScore`, `scoreDelta`, `lastAuditAt`, `auditCount`, `pendingPlans`)
and state-aware `nextSteps` — when a plan awaits approval, the exact
`plans show <id>` → `plans approve <id> --operations <ids|all>` →
`apply --plan-id <id> --provider <name>` chain. One call orients an agent.

Reproducibility: with `SOURCE_DATE_EPOCH` set (seconds since the epoch), the
audit plan's `createdAt` is pinned and `audit --demo --json` is
byte-deterministic across re-runs.

### Flag lexicon: `--provider` vs `--source` vs `--connector` vs `--channel`

Four flags name "where data comes from / goes to"; they are not interchangeable:

| Flag | Meaning | Values |
|---|---|---|
| `--provider` | The CRM the data lives in — the system a snapshot is read from and an approved plan is applied to. | `hubspot`, `salesforce` (plus `stripe`, read-only) |
| `--source` | The external data source feeding a verb: an enrichment/discovery vendor on `enrich`/`tam` (`--source apollo`, `acquire --source pipe0`), a staged-ingest label on `enrich ingest`, or — on `signals fetch` — which no-auth ATS board adapters to scan. | `apollo`, `clay`, `pipe0`, `explorium`, `theirstack`, `linkedin` (HeyReach); `greenhouse` / `lever` / `ashby` on `signals fetch` |
| `--connector` | A signal-intake source connector on `signals fetch`: pulls candidate signals from a connected platform or the local webhook spool into the signal ledger. | `file`, `serpapi-news`, `hubspot-forms` |
| `--channel` | Where a plan's output is delivered. On `apply`, the delivery terminus — a plan applies to `--provider <crm>` *or* `--channel outbox` (render approved openers to a local outbox file; transmits nothing), never both. On `draft`, which outreach channel the opener is drafted for (shapes the emitted op). | `apply`: `outbox` · `draft`: `email`, `linkedin`, `task` |

### Standardized flag aliases

Additive; every legacy flag keeps working:

- `--dry-run` — accepted on the plan-spine verbs (`audit`, `suggest`,
  `bulk-update`, `dedupe`, `reassign`, `fix`, `call plan`,
  `enrich append`/`refresh`/`acquire`, `signals fetch`, `icp judge`, `draft`,
  `tam status`, `market overlay`). These verbs are already preview-by-default
  (plans are dry-run; nothing writes to a CRM outside approve → apply), so the
  flag asserts that default rather than changing it: it additionally suppresses
  `--save` (nothing is persisted to the plan store / run ledgers; a stderr note
  is printed when both are passed) and locks `fix` to its stop-before-apply
  path even when `--yes` is present. Omitting `--dry-run` changes nothing.
  (`tam accounts` had `--dry-run` before this convention — there it prices the
  credit pull; same spirit, spend nothing.)
- `--confirm` — accepted wherever an ad-hoc confirmation flag already gates a
  write stage: alias for `fix --yes` (`tam accounts` already used `--confirm`
  for its spend guard). `--dry-run` beats `--confirm`/`--yes`.

Credential resolution ladder: explicit `--token-env` → ambient env
(`HUBSPOT_ACCESS_TOKEN`, `SALESFORCE_ACCESS_TOKEN`+`SALESFORCE_INSTANCE_URL`,
`STRIPE_SECRET_KEY`) → stored login (`~/.fullstackgtm`, `FSGTM_HOME` override)
→ broker pairing (`login --via`).

Profiles: the global `--profile <name>` flag (or `FULLSTACKGTM_PROFILE`) scopes
stored logins and stored plans to `profiles/<name>/` under the home directory,
so one operator can work across several organizations' CRMs without mixing
credentials or applying one org's plan through another's connection. The
default profile keeps the historical flat layout.

`report` renders an audit (or an existing plan via `--plan`) as a client-ready
deliverable in markdown or self-contained HTML: severity counts, prose summary,
per-rule detail with capped examples, and next steps. `auditReportToMarkdown` /
`auditReportToHtml` expose the same rendering programmatically.

## Governed write verbs

Plan builders behind `route`, `bulk-update`, `dedupe`, and `reassign` — every
one emits a standard dry-run `PatchPlan` for the normal approve → apply chain:

- `buildBulkUpdatePlan(snapshot, options: BulkUpdateOptions)` with
  `parseWhere` (filter expressions: `=`, `!=`, `~`, `!~`, `:empty`,
  `:notempty`, type-aware comparisons `<`, `>`, `<=`, `>=` — `today` resolves
  to `options.today`/the policy date, date and numeric fields coerce by value
  form, `|` any-of, relational pseudo-fields) and `isFilterableField`. Filters
  are re-verified per record at apply time (the resolved `today` rides along on
  `plan.filter.today` so re-verification agrees with plan time);
  `from:<sourceField>` values derive per record from the snapshot.
- `buildDedupePlan(snapshot, options: DedupeOptions)` with `dedupeKey` —
  duplicate groups by normalized identity key, one `merge_records` per group,
  deterministic survivor selection (`richest` / `oldest`).
- `buildReassignPlans(snapshot, options: ReassignOptions)` — one plan per
  `ReassignObjectType`, account-lifted scoping, stage exclusions. With
  `assignUnowned` (CLI `--assign-unowned`) it targets ownerless records
  (`ownerId:empty`) and claims them for `--to` — the backfill twin of
  `enrich acquire`'s create-time assignment, for clearing existing ownerless debt.
- `buildLeadRoutePlan(snapshot, options: LeadRouteOptions)` — matches contacts
  to accounts by email domain and optional company-name fallback, skips free
  email domains and ambiguous matches, then emits approval-gated account-link
  and owner-assignment operations. Owner routing can inherit active account
  owners for ownerless contacts or use the shared deterministic
  `AssignmentPolicy`; existing owners are preserved unless
  `reassignExistingOwner` (CLI `--reassign-owned`) is set.

Read-only prevention reports:

- `buildAccountHierarchy(snapshot)` / `accountHierarchyToMarkdown(report)` —
  provider parent hints plus subdomain inference, with duplicate-domain,
  ambiguous-parent, and parent-cycle conflicts surfaced rather than written.
- `buildRelationshipMap(snapshot, { accountId | domain })` /
  `relationshipMapToMarkdown(map)` — account stakeholders, inferred roles,
  activity sentiment evidence, open deals, and missing-role gaps.

`fix` is CLI-only composition of existing surfaces (audit → suggest →
approve → apply for one rule).

## Enrich

Governed third-party enrichment (spec-first; `enrich.config.json` validated
by `parseEnrichConfig` / `loadEnrichConfig`, types `EnrichConfig`,
`EnrichFieldConfig`, `EnrichSourceConfig`): `buildEnrichPlan` matches staged
or pulled source records to CRM records (`matchSourceRecord` — ordered keys,
`MatchOutcome` of matched / unmatched / ambiguous) and emits fill-blanks-only
operations. `createFileEnrichRunStore` / `EnrichRunStore` is the profile-scoped
append-only run store (resume cursor, per-record/per-field `enrichedAt`
stamps read by `latestStamps` / `selectStaleWork`). `parseCsv` is the
dependency-free CSV intake; the Apollo client (`createApolloClient`,
`pullApolloRecords`, 429-aware with `Retry-After`) is the first `api`-kind
source.

Staged-file intake follows one container convention (`spoolFiles.ts`, shared
with `signals fetch --from` and `market observe --from`): `enrich ingest`
accepts — in addition to its original `.csv` / `.json` forms, which parse
exactly as before — a `*.jsonl` spool file (one JSON row per line) or a
directory of `*.jsonl` / `*.json` spool files (name-sorted), the Phase-2
webhook landing-zone format (docs/signal-spool-format.md).

## Acquire (net-new lead generation)

`buildAcquirePlan` turns sourced-but-unmatched prospects into `create_record`
operations (matched / ambiguous are skipped — resolve-first never creates over
a possible dup), capped by the meter's headroom. `builtinAcquirePreset` is the
zero-config `EnrichConfig.acquire` (budget, provider, create-mapping) so
`enrich acquire` runs with just an `icp.json`.

**Contacts or accounts.** `acquire.create` is keyed by object type, so the same
spine acquires net-new **accounts** for ABM, not just contacts: configure
`acquire.create.company` (match key `domain`, properties → `name`/`domain`) and
feed company rows (`enrich ingest companies.csv --objects companies`). Each
unmatched company becomes a `create_record` op of `objectType: account` with its
domain stamped — so the acquired account is immediately signal-watchable
(`signals`/`icp judge` key on account domain).

- **ICP** (`icp.ts`): `Icp` type, `parseIcp`, `icpToExploriumFilters` /
  `icpToCrustdataFilters` (per-provider discovery filters), `scoreProspectAgainstIcp`
  (persona fit 0..1), `fitThreshold`, `INTERVIEW_SPEC` + `icpFromAnswers` (the
  agent-driven interview).
- **Prospect sources** (`connectors/prospectSources.ts`, `Prospect`):
  `fetchExploriumProspects` (discovery), `pipe0ResolveWorkEmails` (work-email
  waterfall, chunked, surfaces upstream errors), `fetchPipe0CrustdataProspects`
  (people search). `prospectIdentityKeys` / `crmContactKeys` /
  `partitionFreshProspects` power the pre-email dedup.
- **LinkedIn source** (`connectors/linkedin.ts`, `acquireLinkedIn.ts`): the
  injectable `LinkedInProvider` interface with a default HeyReach adapter
  (`createHeyReachProvider`, `HEYREACH_BASE`, `X-API-KEY`, `normalizeHeyReachLead`)
  and `createFakeLinkedInProvider` for keyless/offline tests; `createLinkedInProvider`
  selects the adapter (`heyreach` only; rejects unknown). `discoverLinkedInProspects`
  pulls a HeyReach lead list and `linkedInProspectToProspect` maps each lead to the
  canonical `Prospect` (match key = LinkedIn URL), so ICP scoring / dedup / meter /
  apply are reused unchanged. Phase 1 is discovery-only — read-only, never sends.
  `linkedin` is a `SUPPORTED_API_SOURCES` source, so an explicit config can set
  discovery `size` (read a whole list, not the preset's 25). A LinkedIn list
  carries no emails; opt into resolution with
  `acquire.discovery.linkedin.resolveEmailsWith: "pipe0"` — email resolution is
  no longer gated on the dedupe key being `email`, so a profile-URL-keyed source
  still creates outreach-ready, emailed contacts. ICP scoring matches title
  keywords across `Prospect.jobTitle` **and** `headline` (LinkedIn roles often
  live in the headline, not the formal title).
- **Meter** (`acquireMeter.ts`): `AcquireBudget`, `loadMeter` / `remaining` /
  `recordConsumption` — per-profile windowed record+spend budget, charged only
  for landed creates.
- **Seen cache** (`acquireSeen.ts`): `loadSeen` / `recordSeen` — cross-run
  memory so a re-run never re-pays to enrich a known prospect.
- **Assignment** (`assign.ts`): `AssignmentPolicy` (`fixed` / `round-robin` /
  `territory` / `account-owner`), `parseAssignmentPolicy`, pure
  `resolveAssignment(policy, ctx, index, knownOwnerIds)`. Set
  `EnrichConfig.acquire.assign` and `buildAcquirePlan` stamps `ownerId` into each
  `create_record` payload so a **lead is never born ownerless** — the connector
  maps it to HubSpot `hubspot_owner_id` at create time. Round-robin distributes
  by the within-run index (deterministic, no persisted cursor); every result is
  gated by the snapshot's active owners (an unknown/inactive owner collapses to
  unassigned, never a bad write). The CLI defaults to the portal's sole active
  owner when no policy is set (or `--assign-owner <id>`); with multiple owners
  and no policy it warns and leaves leads unassigned rather than guess. The same
  policy backfills existing debt via `reassign --assign-unowned`.

`CanonicalContact.linkedin` (mapped from HubSpot `hs_linkedin_url`) is the
strong dedup key across all of the above.

## Schedule

The horizontal scheduler: a declarative schedule-entry store, a
dependency-free 5-field cron parser, and the read/plan-side `SCHEDULABLE`
allowlist. `validateSchedulableArgv` enforces the allowlist at `schedule add`
time and re-checks it at run time (`tokenizeCommand` splits the quoted command
string — tokenization, never shell). `apply` is schedulable only as
`apply --plan-id <id>`, with the plan's `approved` status re-checked at every
firing — an unapproved plan records a `plan_not_approved` no-op run
(`ScheduleRunRecord.noopReason`) instead of executing.

- Entries: `ScheduleEntry` (`ScheduleProvider` is `"local"` for now),
  `scheduleId`, `ScheduleStore` / `createFileScheduleStore`.
- Run history: `ScheduleRunRecord` (`ScheduleRunTrigger`: `cron` | `manual`),
  `ScheduleRunStore` / `createFileScheduleRunStore`, with `schedulesPath` /
  `scheduleRunsDir` for the profile-scoped file layout.
- Cron: `parseCron` → `CronExpression`, `cronMatches`, `nextCronFiring`,
  `expectedFirings`, `computeMissedFirings` (status and missed-firing
  visibility — local cron has no catch-up).
- Local provider: `schedule install` materializes enabled entries into the
  platform timer. crontab (Linux default, `--timer crontab`): a
  sentinel-managed block — `crontabSentinels`, `renderManagedBlock`,
  `replaceManagedBlock`, and `systemCrontabIo` behind the injectable
  `CrontabIo` seam (tests never touch a real crontab). launchd (macOS
  default, no Full Disk Access needed): one LaunchAgent per entry —
  `cronToCalendarIntervals` (→ `LaunchdCalendarInterval[]`),
  `renderLaunchdPlist`, `launchdLabel` / `launchdAgentPrefix`,
  `installLaunchdAgents` / `uninstallLaunchdAgents`, and `systemLaunchdIo`
  behind the injectable `LaunchdIo` seam (tests never touch launchctl);
  `isDuplicateCronFiring` backs the `duplicate_firing` run no-op.

## Market map

Newer surface (0.16–0.23); shapes are settling toward the 1.0 contract. A live
model of the competitive category: claim taxonomy + vendor registry as a
reviewable `market.config.json` (`MarketConfig`, `MarketClaim`, `MarketVendor`,
`MarketAxis` — axes require `negativePole`/`positivePole` labels), content-addressed
page captures (`captureMarket`, `loadCaptureTexts`), append-only observations
(`ObservationSet`, `MarketObservation`, `ObservationStore` /
`createFileObservationStore` — profile-scoped under `<home>/market/<category>`),
and deterministic derivations: `computeFrontStates` / `diffFrontStates`
(front rule v1), `assessAxes` / `pcaTop2` / `axisPosition` (axis discovery),
`computeDirectives` / `computeOverlayStats` / `directivesToPlan`
(`market overlay` — observations × CRM snapshot × call corpus →
OCCUPY/PROMOTE/URGENT/RETREAT `MarketDirective`s, convertible to an
approval-gated plan of `create_task` operations), `computeScaleIndex` /
`scaleReportToText` (`market scale` — citable `ScaleSignal`s → within-set,
ACV-band-stratified revenue estimates with disclosed uncertainty), and
`marketMapToMarkdown` / `marketMapToHtml` (the field report; renders the
primary strategic 2×2 when `axes` / `primaryAxes` are configured, bubbles
area-proportional to estimated revenue share when scale signals exist).

Intensity readings are proposals: `classifyMarket` (LLM, bring-your-own-key,
provenance-marked) or `buildWorksheet` + `market observe` (agent/human). Every
quoted evidence span is mechanically verified verbatim
(`verifyEvidenceSpans`; whitespace and punctuation-spacing normalized) against
the stored capture it cites before a set is accepted; failed captures read as
`unobservable`, never `absent`.

## MCP

Tools: `fullstackgtm_capabilities` (the machine-readable server contract —
tool inventory with per-tool CRM-write flags, derived from the server's own
registration table), `fullstackgtm_audit`, `fullstackgtm_rules`,
`fullstackgtm_apply` (requires explicit `approvedOperationIds`),
`fullstackgtm_suggest`, `fullstackgtm_call_parse`, `fullstackgtm_resolve`,
`fullstackgtm_market_worksheet`, `fullstackgtm_market_observe` (validates,
verifies quoted spans against the stored captures, appends, returns front
states). Input schemas are stable.

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
- `builtinAuditRules` (11 rules) plus each rule exported individually.
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

- `GtmConnector` — `{ provider, fetchSnapshot(), applyOperation?, readField?, fetchChanges? }`.
  - Connectors never silently drop unresolvable records; audits surface them.
  - `fetchChanges(sinceIso)` returns a partial snapshot; change feeds may omit associations.
- `createHubspotConnector(options)` — read/write/readField/fetchChanges. `applyOperation` implements every `PatchOperationType`: `set_field`, `clear_field`, `link_record`, `create_task`, `archive_record`, `merge_records` (HubSpot v3 merge — pairwise, irreversible; survivor must belong to the duplicate group). The Salesforce connector skips `merge_records` honestly (SOAP/Apex-only on that platform).
- `createSalesforceConnector(options)` — read/write/readField/fetchChanges; probabilities normalized to 0..1; `applyOperation` implements every operation type.
- `createStripeConnector(options)` — read-only billing by design (`applyOperation` returns `skipped`); email domains are the cross-system merge keys. Implements `fetchChanges` (incremental via `created[gte]`).

## Multi-system operations

- `mergeSnapshots(snapshots)` → `{ snapshot, report }` — entity resolution on email/domain/name keys; identities accumulate; first source wins on conflicts and every conflict is reported.
- `diffSnapshots(before, after)` → record/field-level changes; `diffFindings(beforePlan, afterPlan)` → hygiene drift on stable ids.

## Configuration

- `fullstackgtm.config.json`: `{ policy?, rules?: { enabled?, disabled? }, rulePackages? }`.
- Rule packages export `rules: GtmAuditRule[]`.
- Precedence: CLI flags > config file > defaults.

## CLI

Commands: `login` / `logout`, `snapshot`, `audit`, `report`, `diff`, `merge`, `plans`,
`apply`, `suggest`, `call` (`parse` / `score` / `link` / `plan`), `resolve`,
`market` (`init` / `capture` / `classify` / `worksheet` / `observe` / `fronts` /
`axes` / `report` / `refresh`), `rules`, `profiles`, `doctor`.
Exit codes: `0` success · `1` error · `2` findings/regressions at the requested gate
(`--fail-on`, `--fail-on-new-findings`). `--json` everywhere; JSON output shapes are stable.

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

## Market map

Newer surface (0.16–0.18); shapes are settling toward the 1.0 contract. A live
model of the competitive category: claim taxonomy + vendor registry as a
reviewable `market.config.json` (`MarketConfig`, `MarketClaim`, `MarketVendor`,
`MarketAxis`), content-addressed page captures (`captureMarket`,
`loadCaptureTexts`), append-only observations (`ObservationSet`,
`MarketObservation`, `ObservationStore` / `createFileObservationStore` —
profile-scoped under `<home>/market/<category>`), and deterministic
derivations: `computeFrontStates` / `diffFrontStates` (front rule v1),
`assessAxes` / `pcaTop2` / `axisPosition` (axis discovery), and
`marketMapToMarkdown` / `marketMapToHtml` (the field report; renders the
primary strategic 2×2 when `axes` / `primaryAxes` are configured).

Intensity readings are proposals: `classifyMarket` (LLM, bring-your-own-key,
provenance-marked) or `buildWorksheet` + `market observe` (agent/human). Every
quoted evidence span is mechanically verified verbatim
(`verifyEvidenceSpans`; whitespace and punctuation-spacing normalized) against
the stored capture it cites before a set is accepted; failed captures read as
`unobservable`, never `absent`.

## MCP

Tools: `fullstackgtm_audit`, `fullstackgtm_rules`, `fullstackgtm_apply`
(requires explicit `approvedOperationIds`), `fullstackgtm_suggest`,
`fullstackgtm_call_parse`, `fullstackgtm_resolve`,
`fullstackgtm_market_worksheet`, `fullstackgtm_market_observe` (validates,
verifies quoted spans against the stored captures, appends, returns front
states). Input schemas are stable.

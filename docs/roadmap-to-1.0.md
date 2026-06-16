# fullstackgtm: 0.1 → 1.0

The planned, versioned path from first publish to a stable 1.0. Each milestone
is shippable on its own, ordered so that every step consolidates the
architecture before the next step expands it. The invariants that hold at
every version:

1. **The package is the product; the app is an adapter.** Anything the app
   needs from a provider goes through the package connector. New capability
   lands in the package first.
2. **Reads are free, writes are patch plans.** No code path may mutate a
   provider except `applyPatchPlan` / `applyOperation` with explicit approval.
3. **Deterministic and diffable.** Same inputs produce the same findings with
   the same ids. Golden tests over the demo dataset enforce this.
4. **Zero-dependency core.** Connectors use `fetch`; optional integrations
   (MCP) stay optional peers.

## 0.1.0 — The loop exists (done)

Canonical model, pluggable rule engine, patch plans, safe apply, HubSpot
connector, CLI/MCP, demo dataset, CLI auth (private app token, loopback
OAuth), broker pairing against a hosted deployment, CI + tag-publish
automation.

## 0.2.0 — Provider parity and operational trust (done)

- **Salesforce connector** behind the same `GtmConnector` contract: SOQL with
  cursor pagination, PATCH write-back, probabilities normalized to canonical
  0..1, never drops unresolvable records.
- **Salesforce CLI auth**: native device flow (code on any device, no client
  secret, silent refresh) plus manual token + instance URL.
- **Broker mint for Salesforce**: paired CLIs receive `accessToken +
  instanceUrl + fieldMappings` from the org's stored credentials.
- **CLI token observability**: paired-CLI list with last-used timestamps and
  one-click revoke in the dashboard.
- App consolidation: `convex/salesforceActions.ts` collapses onto the package
  connector like the HubSpot path did.

## 0.3.0 — One patch-plan vocabulary (done)

The last internal duplication: the app's durable `patchPlans` tables speak
`verb`/`operation` strings while the package speaks typed `PatchOperation`s.

- Package: add a `PlanStore` interface (persist plan → approve operations →
  record runs) so durable workflows are a first-class framework concern, not
  an app concern.
- App: migrate `patchPlans`/`patchOperations` rows to the package types
  (schema migration with a compatibility window), route
  `patchPlanActions.apply` through `applyPatchPlan`.
- Exit criterion: the dashboard review queue and `fullstackgtm apply` operate
  on byte-identical plan documents.

## 0.4.0 — Policy as config, rules as packages (done)

Make the rule engine the community surface.

- `fullstackgtm.config.json` (or `.ts`): policy thresholds, enabled rules,
  per-rule severity overrides, custom rule module paths.
- Rule metadata: category, default severity, docs URL; `fullstackgtm rules`
  becomes generated documentation.
- 10–15 additional built-in rules drawn from real RevOps pain: duplicate
  accounts by domain, contacts without owners, deals closing this quarter
  with no activity in 14 days, stage/probability drift, currency mismatches.
- Exit criterion: a third party can publish an npm package of rules and a
  user can enable it from config without forking.

## 0.5.0 — Time: snapshot history and drift (done)

- Snapshot archive conventions (local directory or any mounted/S3-backed
  path) with `fullstackgtm snapshot --archive`.
- `fullstackgtm diff <a> <b>`: what changed between snapshots — records,
  fields, and *findings* (hygiene drift), built on the stable-id property.
- Audit trends in the hosted app (the observability layer earns its keep).
- Exit criterion: a nightly CI job can fail on hygiene regression, not just
  hygiene presence.

## 0.6.0 — Many systems, one entity (done — Stripe is the first non-CRM connector)

The original thesis: GTM data disagrees across systems.

- Entity resolution over `identities` claims: merge canonical records from
  multiple snapshots (CRM + marketing + billing) by domain/email/external-id
  heuristics, with explicit confidence and human-reviewable merge plans (the
  patch-plan safety model applied to identity).
- Cross-system audit rules: "account exists in billing but not CRM",
  "marketing-qualified contact has no CRM owner".
- First non-CRM connector (likely billing — Stripe — or marketing) to prove
  the contract generalizes.
- Exit criterion: one audit over a merged snapshot from two live systems.

## 0.7.0 — Sync maturity (done)

- Incremental fetch: provider cursors (HubSpot `updatedAfter` search,
  Salesforce `SystemModstamp` filters) behind an optional
  `fetchChanges(since)` connector capability.
- Conflict surfacing: when a provider value changed under an unapplied patch
  operation, the plan flags it instead of writing blind (compare-and-set).
- Exit criterion: hourly sync of a 100k-record org without full re-pulls.

## 0.8–0.9 — Hardening and freeze (done)

- API review and freeze of `types.ts`, connector contract, CLI flags, MCP
  schemas; deprecations resolved.
- Security review of the auth surfaces (credential store, broker endpoints,
  token lifecycle); rate limiting on the device-flow endpoints.
- Docs site with the operating-model registry as browsable reference.
- Performance pass: streaming snapshots for very large orgs.

## 0.10 → 0.28 — the layers, as shipped

The plan above ended at the freeze; what shipped next grew the surface
outward, one layer per release, each consolidating before the next expanded:

- **0.11** — the suggest chain: deterministic placeholder values with
  confidence + reasons, `plans approve --values-from`.
- **0.12** — governed merge: `merge_records` (HubSpot contacts / companies /
  deals), survivor suggestions capped at low confidence.
- **0.13–0.14** — call intelligence: `call parse|score|link|plan`, LLM
  extraction behind the bring-your-own-key seam, deterministic baseline,
  provenance-marked insights.
- **0.15** — the Prevent layer: the `resolve` create gate plus record-source
  provenance and attribution.
- **0.16–0.22** — the market map: content-addressed captures, classification
  with mechanical span verification, front states and drift, axis discovery,
  overlay directives, scale estimation, the field report.
- **0.19 / 0.23** — governed write verbs (`bulk-update`, then `dedupe`,
  `reassign`, `fix`) and the enrich layer (Apollo / Clay, fill-blanks-only
  plans).
- **0.24** — the schedule layer: horizontal cron, read/plan-side allowlist,
  scheduling never auto-approves.
- **0.25** — agent skill distribution (`npx skills add fullstackgtm/core`).
- **0.25.2–0.26** — the security-hardening train: write-path integrity
  (HMAC-signed approvals re-verified at apply; archive-of-duplicate and
  irreversible-op drift guards; recovery snapshots) plus crontab/SSRF/XSS/
  error-body/CSV/credential-mode fixes, each verified by adversarial re-attack.
- **0.27** — trust & transparency: `audit-log export|verify` (hash-chained,
  signed apply-run record), SECURITY.md + DATA-FLOWS.md + company-of-record,
  call-transcript insight grounding.
- **0.28** — connectors, credentials & supply chain: opt-in OS keychain,
  broker-https enforcement, the build/CI dist-integrity gate (published dist is
  provably from source), Salesforce-merge capability matrix.

The known-gaps list below predates these layers and has been re-verified
against the 0.28 surface: still accurate, still open.

## Known real-portal gaps to close before 1.0

Found by exercising the published package as a fresh RevOps user with a real
CRM (2026-06):

- **Pipeline-aware closed-deal detection (HubSpot).** `isClosed`/`isWon` are
  derived by substring-matching the raw `dealstage` value against
  `closedwon`/`closedlost`. Custom pipelines use opaque stage ids, so closed
  deals read as open and flood stale-deal/past-close findings. Fix: resolve
  stage metadata from `/crm/v3/pipelines` once per snapshot.
- **Rate-limit resilience.** No 429/retry/backoff handling anywhere; a
  mid-size portal snapshot is ~1,000+ sequential page requests and one
  transient failure aborts the run. Fix: honor `Retry-After`, retry
  idempotent reads with backoff.
- **`fetchChanges` 10k truncation.** The HubSpot search API caps at 10,000
  results; the connector stops silently at MAX_PAGES. Fix: detect the cap
  and fall back to (or instruct) a full snapshot, loudly.
- **MCP plan hand-off.** `fullstackgtm_audit` can only return the full plan
  inline (200KB+ on real data) while `fullstackgtm_apply` requires a file
  path. Fix: an `outPath` option on the audit tool plus a summary-only
  output mode.
- **Scope-complete login validation.** `login hubspot` validates against the
  owners endpoint only, so an under-scoped token passes login and fails
  mid-audit. Fix: probe each required object endpoint at login and report
  missing scopes up front.

## 1.0.0 — The contract (not yet declared)

Semver stability commitment on the canonical model, rule interface, connector
contract, plan format, CLI, and MCP tools. Declared only after the API
surface has survived external usage and the real-portal gaps above are
closed. From there, new providers and new rules are minor releases; the
model only breaks at 2.0.

## Deliberately out of scope until after 1.0

- Hosted multi-org analytics across customers
- Non-deterministic (LLM-scored) rules — they can *propose*, but the
  deterministic engine stays the system of record for findings
- Workflow orchestration (sequences, cadences) — adjacent product, not
  framework

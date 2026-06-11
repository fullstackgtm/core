# Changelog

All notable changes to the `fullstackgtm` package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).
The path to 1.0 is planned in [docs/roadmap-to-1.0.md](./docs/roadmap-to-1.0.md).

## [0.15.0] — 2026-06-11

The Prevent layer: stop creating duplicates, and name the writer that does.

### Added

- **`fullstackgtm resolve <account|contact|deal>`** — the create gate.
  Deterministic verdicts (exists / ambiguous / safe_to_create) with matches
  and reasons, using the same identity keys as the audit/merge engines:
  normalized account domain, contact email, open-deal key. Names alone are
  never identity (ambiguous, with candidates). Gate-shaped exit codes for
  scripts: 0 = safe to create, 2 = match found, 1 = error. Exposed as
  `resolveRecord()` and MCP `fullstackgtm_resolve`.
- **Record provenance** (`RecordProvenance` on accounts/contacts/deals):
  HubSpot snapshots capture the read-only `hs_object_source`,
  `hs_object_source_label`, `hs_object_source_id` fields, and the three
  duplicate rules append writer attribution to findings — "Created by:
  Gojiberry (app-123) ×2, CRM_UI" — so recurring dupes are fixed at the
  faucet. Provenance is exempt from merge conflicts and diff drift, and
  records created by the CLI's own `create:` path stamp
  `hs_object_source_detail_2` (best-effort).

## [0.14.1] — 2026-06-11

Fixes from the 0.14.0 journey verification (4 agents, 21 checks).

### Fixed

- **`call score` no longer suggests a flag it rejects**: the keyless error
  said "pass --deterministic" but score has no non-LLM mode — its error now
  says exactly that. Rubric files are also validated *before* the
  credential check (keyless users see rubric errors), and a non-JSON rubric
  names the file and the expected shape instead of a raw parse error.
- **NDJSON rows carry `extractor`** — LLM and deterministic rows were
  per-row indistinguishable in warehouse loads, contradicting the
  provenance claim. (Docs wording was right at the parse-result and
  evidence level; now it is true per-row too.)
- **`call … --help` prints help** instead of being shadowed by argument
  and credential checks.
- `login anthropic|openai` gets the same explicit argv-secret rejection
  (`--token`/`--key`/`--api-key`) as the CRM providers.

## [0.14.0] — 2026-06-11

LLM-powered call intelligence, bring-your-own-key. The dry-run replications
of two real client pipelines proved the deterministic baseline is an
analytics floor, not what call workflows actually run on — so the no-LLM
guardrail is consciously retired for the `call` commands (and only there).

### Added

- **LLM extraction is the default for `call parse`** — constrained tool
  calls against Anthropic (default claude-haiku-4-5) or OpenAI (default
  gpt-4o-mini) via raw fetch, no SDK dependency. Mandatory verbatim-quote
  evidence; next steps carry owner/deadline/commitment; every insight is
  provenance-marked (`extractor: "llm:<provider>:<model>"` vs
  `"deterministic"`). `--deterministic` keeps the free keyword baseline.
- **First-touch key onboarding**: the first LLM command without a key (TTY)
  explains, captures the key via muted prompt/stdin, auto-detects the
  provider from the prefix, validates it against the provider's API, and
  stores it 0600 in the credential store. Non-interactive contexts get an
  actionable error, never a prompt. Also: `fullstackgtm login anthropic|openai`
  and `logout`, and a `doctor` row showing LLM key status.
- **`fullstackgtm call score`**: rubric-driven coaching scorecards —
  built-in five-dimension rubric or `--rubric rubric.json`
  ({ scale, dimensions: [{ name, weight, rubric }] }); per-dimension
  verbatim evidence + coaching notes; the weighted overall is computed
  deterministically client-side. Markdown table or `--json`.
- **MCP `fullstackgtm_call_parse` gains `extractor: auto|llm|deterministic`**
  (auto uses a key when the server has one, else the baseline) and `--model`.

### Security

- LLM keys follow the same discipline as CRM secrets: stdin/prompt only,
  never argv; 0600 store; provider error bodies never echoed (status line
  only); keys go directly to api.anthropic.com / api.openai.com.

## [0.13.1] — 2026-06-11

### Fixed

- **Granola's formatted text export parses correctly**: it writes
  `[Speaker] text` with no colon, which the transcript parser missed
  entirely (found running the published 0.13.0 against a real export).
  `normalizeTranscript` now rewrites those lines to the canonical
  `[Speaker]: text` form.

## [0.13.0] — 2026-06-11

Calls become evidence: the deterministic skeleton of every call workflow —
normalize, link, govern the writeback — as chainable primitives. Born from
two real client pipelines that each hand-rolled all three.

### Added

- **`fullstackgtm call parse`**: normalizes any transcript dialect
  (`Speaker: text`, `[Speaker]:` labels, or raw Granola utterance JSON) into
  canonical segments, nine types of deterministic keyword-derived insights,
  and `GtmEvidence` records with stable ids. `--json`, `--out`, and
  `--ndjson` (one flat row per insight — warehouse-ready). LLM-free.
- **`fullstackgtm call link`**: attendee emails/domain → account (by domain
  or contact email) → open deals ranked by recent activity, with
  confidence + written reason — the heuristic every call pipeline
  hand-rolls, as one command.
- **`fullstackgtm call plan`**: next-step insights become a saved patch
  plan — `deal.next_step` (compare-and-set protected) plus follow-up tasks
  (idempotent), with the call evidence attached — flowing into the standard
  suggest/approve/apply lifecycle. Implements the
  `call_next_step_not_reflected_in_crm` finding declared since the MVP.
- **MCP `fullstackgtm_call_parse`** tool; `parseCall`, `normalizeTranscript`,
  `suggestCallDeal`, `parseTranscript`, `extractCallInsights`,
  `summarizeInsights` exported from the package (the extraction library
  moved out of the proprietary app — the boundary moves outward).

## [0.12.0] — 2026-06-11

Governed merges: the Remediate layer of the
[CRM-health lifecycle](./docs/crm-health-lifecycle.md). Duplicate detection
now ends in an approvable merge, not a chore.

### Added

- **`merge_records` operation type**: merges a duplicate group
  (`beforeValue` = group ids) into an approved survivor (`afterValue`).
  HubSpot connector implements it via the v3 merge API for companies,
  contacts, and deals — pairwise, survivor's values win, losers archived by
  HubSpot, **irreversible** (called out in every operation's rollback text).
  Refuses survivors outside the group; treats 404 losers as already merged,
  so replayed plans are safe. Salesforce skips honestly (merge is SOAP/Apex
  only on that platform).
- **Survivor suggestions in `suggest`**: deterministic ranking — most
  complete record, then most recent activity — with the evidence written
  into the reason. **Capped at low confidence by design**: an irreversible
  merge can never clear the default bulk-approval bar; accepting one takes
  `--min-confidence low` or an explicit `--value`.

### Changed

- **The three duplicate rules now emit `merge_records`** (high risk,
  approval required, irreversibility in the rollback text) instead of
  `create_task` review chores — detection now connects to remediation
  inside the governed loop.

## [0.11.1] — 2026-06-11

Write-path integrity: fixes our own dupe faucets, found auditing the apply
path for the new [CRM-health lifecycle](./docs/crm-health-lifecycle.md) doc.

### Added

- **docs/crm-health-lifecycle.md**: the full CRUD lifecycle for keeping a
  CRM healthy — Prevent → Detect → Remediate → Verify/Attribute — grounded
  in verified platform behavior (HubSpot/Salesforce dedupe and merge
  support) and the build order toward governed merges and a resolve gate.

### Fixed

- **`create:<Name>` is now resolve-first**: it links to an unambiguous
  existing company/account instead of creating, refuses on ambiguity, and
  creates only on a confirmed miss — and never creates the same name twice
  within one apply run (HubSpot search is eventually consistent, so the
  same-run record is authoritative).
- **HubSpot compare-and-set on `link_record` is no longer blind**:
  `readField("deal"|"contact", id, "accountId")` reads the actual company
  association (it is not a property), so replaying an applied link returns
  `conflict` instead of silently re-creating companies.
- **`create_task` is idempotent**: the operation id is stamped into the
  task body as a token and pre-checked (fail-open), so replayed plans no
  longer duplicate merge-review tasks on either provider.
- **`duplicate-account-domain` normalizes domains** the same way merge
  does — `www.acme.com`, `https://acme.com/about`, and `acme.com` now
  group as duplicates.

## [0.11.0] — 2026-06-11

Canonicalizes the paths discovered dogfooding against a real portal: the
suggest chain (every `requires_human_account_selection` answer was derivable
from the snapshot but required ad-hoc scripting), governed record creation,
client-ready reports, and multi-org profiles.

### Added

- **`fullstackgtm suggest --plan-id <id> | --plan <path> [source options]`**:
  deterministic value suggestions for `requires_human_*` placeholder
  operations, derived from snapshot evidence — account-name matching
  cross-checked against contact→account associations, plus the
  only-active-user case for owner selection. Every suggestion carries a
  confidence level (`high`/`low`/`create`/`none`) and a written reason;
  conflicting or ambiguous evidence yields no suggestion, never a guess.
  `--out` writes a suggestions file; `--json` for agents. Exposed
  programmatically as `suggestValues` and over MCP as `fullstackgtm_suggest`.
- **`plans approve <id> --values-from <suggestions.json>`**: bulk-approve
  with suggested values — high-confidence only by default,
  `--min-confidence low` and `--include-creates` widen the bar explicitly.
  Explicit `--value` flags still win.
- **`create:<Name>` link values**: approving a `link_record` operation with
  `--value <op>=create:Acme` creates the company (HubSpot) / account
  (Salesforce) and links to it in one audited operation — record creation
  stays inside the typed, human-approved model instead of a side channel.
- New builtin rule `duplicate-open-deal` (data-quality): flags multiple open
  deals sharing a normalized name, scoped to the account when linked —
  typically an integration re-creating deals instead of upserting, which
  counts the same revenue several times in pipeline and forecast. Emits one
  finding and one approval-gated merge-review task per duplicate group.
  Found dogfooding: an outreach-tool sync had tripled five open deals in our
  own portal and no existing rule caught it.
- `fullstackgtm report` — render an audit (or an existing plan via `--plan`)
  as a client-ready deliverable in markdown or self-contained HTML:
  at-a-glance metrics, prose summary, per-rule detail with capped example
  records (`--max-examples`), and recommended next steps. `--client`,
  `--title`, `--prepared-by`, and `--format` customize the output;
  `--out report.html` infers HTML. Exposed programmatically as
  `auditReportToMarkdown` / `auditReportToHtml`.
- Credential profiles for multi-organization use: the global
  `--profile <name>` flag (or `FULLSTACKGTM_PROFILE`) scopes stored logins
  AND stored plans to `profiles/<name>/` under the fullstackgtm home, so one
  operator can hold several clients' credentials without mixing them — and a
  plan proposed against one org's CRM can never be applied through
  another's. New `profiles` command lists them; `doctor` reports the active
  profile. The default profile keeps the existing flat layout, so current
  installs are unaffected. Exposed programmatically as `setActiveProfile`,
  `activeProfile`, `listProfiles`, and `DEFAULT_PROFILE`.

### Fixed

- `validateHubspotToken` / `validateSalesforceToken` no longer echo the
  provider's raw error body into the login failure message (observed live: a
  HubSpot 401 body printed to the terminal). Status line only, matching the
  no-body-interpolation rule applied elsewhere in 1.0.1.
- Unreachable hosts during `login salesforce --instance-url` and
  `login --via <url>` now name the target and what to check, completing the
  0.10.1 fix that only covered the audit/connector path.

## [0.10.1] — 2026-06-11

Fixes from a full fresh-user journey audit (install → demo → MCP → real CRM),
focused on the first-contact experience.

### Added

- **`fullstackgtm --version`** (also `-v` / `version`) — previously exited 1
  with a usage dump.
- **README "Connect your CRM" section**: HubSpot private-app walkthrough with
  the exact read scopes the audit needs (`crm.objects.{owners,companies,contacts,deals}.read`)
  and the write scopes `apply` needs; Salesforce Connected App prerequisites
  (admin-created, device flow enabled, `api` + `refresh_token` scopes,
  propagation delay); Stripe restricted-key guidance. Previously the word
  "scope" appeared nowhere in the docs.
- Roadmap: documented the known real-portal gaps to close before 1.0
  (pipeline-aware closed-deal detection, 429/retry, fetchChanges 10k
  truncation, MCP plan hand-off, scope-complete login validation).

### Fixed

- **`FSGTM_NO_BROWSER=1` suppresses OS browser opens** in all login flows
  (broker pairing, Salesforce device flow, HubSpot OAuth) — for agent
  sandboxes, CI, and headless use; verification URLs are always printed.
  The broker test suite sets it, so running `npm test` no longer pops a
  real browser tab at a mock pairing URL on every run.
- **MCP server now works from inside existing projects.** When launched via
  `npx -p ... fullstackgtm-mcp` from a directory whose node_modules already
  contains the peers (but not fullstackgtm), npx skips installing them into
  its cache and module resolution failed; the server now falls back to
  resolving the peers from the working directory — peer-dependency semantics.
  Previously this made the README's `claude mcp add` setup produce a dead
  server in most agent-tooling repos.
- **README auth examples matched the CLI again**: `login salesforce --token ...`
  and `login hubspot --oauth ... --client-secret ...` showed argv-secret forms
  the CLI deliberately rejects; both now use stdin.
- The no-credentials Stripe error suggested `login stripe --token sk_...`,
  which the CLI itself refuses — it now shows the stdin form and mentions
  restricted keys.
- Unreachable hosts no longer surface as a bare `fetch failed`: HubSpot and
  Salesforce connection errors name the target URL and (for Salesforce) point
  at SALESFORCE_INSTANCE_URL.
- Credential errors now point at `fullstackgtm doctor` and the README scope
  guide; the MCP audit tool description now mentions the `demo` source;
  README rule count corrected (11 built-ins, not five).

## [0.10.0] — 2026-06-10

**Versioning reset to reflect beta status.** The 1.x numbering below
(1.0.0–1.2.2) overstated maturity: those versions were development
milestones, not a frozen public contract. 0.10.0 continues the 0.x line
(0.9.0 was the last pre-1.x milestone) and is functionally identical to
1.2.2 plus the status/docs corrections below. `fullstackgtm@1.2.1` and
`@1.2.2` were briefly on npm (2026-06-10) and were unpublished the same
week; those version numbers are permanently burned per npm policy. The real
1.0 will be declared via [docs/roadmap-to-1.0.md](./docs/roadmap-to-1.0.md)
once the API surface has survived external usage.

### Changed

- README status: "1.0 — stable" → "beta (0.x)"; API surfaces may break in
  minor releases until 1.0 (each break will be called out here). The safety
  invariants are explicitly not beta.
- `docs/api.md` reframed as the 1.0 contract *candidate*.
- MCP server now reports the real package version instead of a hardcoded
  string.

## [1.2.2] — 2026-06-10 (unpublished)

Release mechanics.

### Changed

- **Releases publish via npm Trusted Publishing (OIDC)** from GitHub Actions
  on the public repo — no tokens, no 2FA bypass. (1.2.1 was published
  manually to bootstrap the package on npm.)
- Bin paths canonicalized (no `./` prefix) to silence npm 11's
  normalization warning during pack/publish.

## [1.2.1] — 2026-06-10 (unpublished)

First version published to npm.

Onboarding polish: first-run verification, agent install docs, and a working
zero-install MCP path.

### Added

- **`fullstackgtm doctor [--json]`**: offline install check — package/node
  versions, credential-store and config presence, per-provider credential
  source (env / stored / broker / none), MCP peer status, and the suggested
  next command. `--json` for agents and orchestration.
- **`INSTALL_FOR_AGENTS.md`**: deterministic install-and-verify steps with
  expected outputs and exit codes, for AI agents installing the CLI.
- **`llms.txt`**: documentation map and key invariants for LLM consumption.

### Fixed

- **`fullstackgtm-mcp` no longer crashes with a raw module-not-found stack
  trace** when the optional peers are missing — it prints install guidance
  instead (`npx fullstackgtm-mcp` alone never installs optional peers).
- README MCP instructions now use a working zero-install invocation
  (`npx -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp`)
  and include copy-paste Claude Code / generic MCP client configuration.

## [1.2.0] — Unreleased

Feature-completeness fan-out: filled every remaining capability gap found by
an exhaustive census of the package and the hosted app.

### Added (package)

- **Stripe incremental fetch** (`fetchChanges`): filters customers and
  subscriptions on `created[gte]`, so frequent syncs no longer re-pull the
  full account. (Catches newly-created records; Stripe list endpoints can't
  filter on a modification timestamp — documented on the method.)
- **HubSpot and Salesforce now populate `lastActivityAt` and
  `forecastCategory`** on deals (`hs_last_sales_activity_timestamp` /
  `LastActivityDate`, and stage/`ForecastCategory` → canonical category).
  `forecastCategory` was a dead canonical field; stale-deal detection now
  uses true engagement time instead of falling back to sync time.
- **`diffSnapshots` covers the activities collection** (added/removed/changed),
  rendered in `diffToMarkdown` — previously only users/accounts/contacts/deals
  were diffed.
- **`patchPlanToMarkdown` renders each operation's id**, so the approval flow
  (`plans approve --operations <ids>`) no longer requires reading JSON.
- **MCP audit honors config** via a new `configPath` input — policy overrides
  and third-party rule packages now work over MCP, matching the CLI.

### Hosted app (not part of the package's semver surface)

- **Real multi-touch attribution**: `attribution.ts` replaces a single
  synthetic touchpoint per deal and a fabricated 8%-of-revenue budget with
  first/last/linear/time-decay crediting (7-day half-life) over real
  touchpoints; budget/spend read only from real fields.
- **Consistent least-privilege role gating**: 84 write mutations across the
  backend that lacked an admin/manager check now require one (via a new
  `requireManager` helper); HubSpot/Salesforce `disconnect` aligned to
  admin-or-manager. No IDOR/cross-tenant gaps existed; this closes the
  role-gating inconsistency. Removed an unused public `getByClerkId` query.

## [1.1.0] — Unreleased

Feature-completeness pass: no operation type is a stub.

### Added

- **Connectors apply every operation type.** HubSpot and Salesforce
  `applyOperation` now implement `link_record` (HubSpot deal→company
  association; Salesforce `AccountId`), `create_task` (HubSpot task
  engagement with the correct association type id; Salesforce `Task` with
  `WhatId`/`WhoId`), and `archive_record` (HubSpot archive / Salesforce
  delete), in addition to `set_field`/`clear_field`. Previously these were
  silently skipped — so applying a real audit plan (whose built-in rules emit
  `link_record` and `create_task`) now actually applies, with nothing dropped.
- An end-to-end test proves a full demo audit plan applies with zero
  unsupported-skips.

### Fixed

- HubSpot connector tolerates empty (204) response bodies from DELETE and
  association writes instead of throwing on success.
- App (hosted): patch-plan apply dispatches through the shared operation
  registry, so every `set`/`do` operation a plan can be created for is also
  applyable — the previous path only handled `deal.next_step` and threw
  "not implemented" for everything else.

## [1.0.1] — Unreleased

Security and correctness fixes from an adversarial review.

### Security

- **Fail-closed backend auth** (app): the Convex demo bypass is enabled only
  by an explicit `FSGTM_ENABLE_DEMO_DATA=true`, never inferred from a missing
  Clerk issuer — a deployment that forgot to configure auth now rejects
  requests instead of granting admin access to the direct Convex endpoint.
- **Secrets off argv**: `login` no longer accepts tokens/client secrets as
  flags (they leak via `ps` and shell history). Secrets are read from stdin
  (`echo "$T" | fullstackgtm login hubspot`) or a muted interactive prompt;
  passing `--token`/`--client-secret` is rejected.
- **Broker tokens expire** (90-day TTL) and pairing requests are swept; a
  leaked credentials file no longer grants indefinite org access.
- **Device-code phishing defense**: pairing requests carry a self-reported
  requester label shown to the approver, who is warned before granting access.
- **Enforced credential permissions**: the home dir is forced to 0700 and
  credential/plan files to 0600 even when pre-created at looser modes.
- **Per-IP rate limiting** on the public pairing endpoints (replacing a global
  counter that was a self-DoS); timing-safe smoke-bypass comparison that is
  refused in production; provider error bodies no longer interpolated into
  thrown errors; `openInBrowser` validates the URL scheme and fixes argument
  injection / the Windows opener.

### Fixed

- `mergeSnapshots` no longer auto-merges accounts that merely share a name
  with different/absent domains (a data-corrupting false merge); such
  collisions are reported as `suggestions` for human review.
- Apply paths require an `approved` plan unconditionally; a `not_required`
  draft can no longer write to a provider.
- The Stripe connector leaves a subscription's amount undefined for
  metered/tiered prices instead of silently reporting 0.
- `sampleData` probabilities corrected to the canonical 0..1 unit (were
  0..100), matching the connectors and demo dataset.
- Pagination loops guard against a repeated provider cursor (HubSpot and
  Salesforce) so a misbehaving API can't loop forever; HubSpot incremental
  search stops at its 10,000-result cap instead of erroring mid-sync.
- The CLI pairing `describe` lookup is gated to authenticated admins/managers
  so a requester's hostname isn't exposed to anonymous callers.

## [1.0.0] — Unreleased

**The contract.** From this release, the surfaces documented in
[docs/api.md](./docs/api.md) — the canonical data model, the rule interface,
the patch-plan format and apply safety contract, the connector contract,
merge/diff, configuration, CLI commands and exit codes, and MCP tool
schemas — are covered by semver: breaking changes require a major version.
New providers and new rules are minor releases; the model only breaks at 2.0.

No code changes beyond version identifiers; 1.0.0 is 0.9.0 with the
stability commitment attached.

## [0.9.0] — Unreleased

### Added

- **API freeze document** (`docs/api.md`, shipped in the package): the exact
  surfaces covered by the 1.0 semver commitment — canonical model, rule
  engine, plan/apply contract, connector contract, merge/diff, config, CLI
  commands and exit codes, MCP tools.
- **Performance guards in CI**: auditing and diffing a 2,000-account /
  10,000-deal generated org must stay within linear-time budgets, catching
  any regression to quadratic behavior.

### Security

- Rate limiting on the public CLI pairing endpoint (device-flow `start`),
  bounding pairing-request floods deployment-wide.
- Auth-surface review pass: hashed-at-rest device codes and broker tokens,
  state-checked loopback OAuth, 0600 credential files, role-gated approvals,
  and per-CLI revocation were verified; no further findings.

## [0.8.0] — Unreleased

### Added

- **Stripe connector** (`createStripeConnector`) — the first non-CRM
  connector, proving the contract generalizes to billing: customers map to
  accounts (email domain becomes the cross-system merge key) and contacts,
  subscriptions map to deals (cents converted to major units, status mapped
  to won/lost/open). Read-only by design: `applyOperation` always returns
  `skipped`. CLI `--provider stripe`, `login stripe --token sk_...`, and the
  MCP audit source complete the wiring.
- **Incremental fetch** (`fetchChanges(sinceIso)`): HubSpot via the CRM
  search API (`hs_lastmodifieddate`/`lastmodifieddate` filters with paging),
  Salesforce via `SystemModstamp` SOQL filters — frequent syncs no longer
  re-pull whole orgs. CLI: `snapshot --provider <name> --since <iso>`.
  Change feeds may omit associations; documented on the contract.
- **One plan vocabulary in the hosted app**: `patchPlans.get` now returns
  `document` — the package-typed `PatchPlan` converted from legacy rows via
  `convex/lib/patchPlanCompat.ts` — so the dashboard review queue and
  `fullstackgtm apply` consume the same document shape.

## [0.7.0] — Unreleased

### Added

- **Conflict surfacing (compare-and-set)**: connectors gain `readField`, and
  `applyPatchPlan` reads the live provider value before every field write —
  if it no longer matches the plan's `beforeValue`, the operation returns a
  new `conflict` result (with the current value) instead of writing blind.
  On by default when the connector supports it; `checkConflicts: false` opts
  out. Both HubSpot and Salesforce connectors implement `readField` through
  the same field mappings as writes.

### Notes

- Incremental fetch (provider change cursors) is the remaining 0.7.x work.

## [0.6.0] — Unreleased

### Added

- **Entity resolution across systems** (`mergeSnapshots`): collapses users
  and contacts on email, accounts on normalized domain (then name), keeps
  every original system id as an identity claim, gap-fills missing fields
  (first source wins), and reports every conflicting value instead of
  silently resolving it. Deals and activities are never merged — they are
  provider-unique — but references are re-pointed at merged records.
- CLI `merge --input a.json --input b.json --out merged.json` with a
  conflict report; audit the merged view like any snapshot.
- New cross-system rule `account-single-source` (info): on merged
  multi-system snapshots, flags accounts known to only one source. Inert on
  single-provider snapshots, so existing audits are unaffected.

## [0.5.0] — Unreleased

### Added

- **Snapshot diffing** (`diffSnapshots`): added/removed records and
  field-level changes per collection, ignoring sync-noise fields.
- **Hygiene drift** (`diffFindings`): new vs. resolved vs. persisting
  findings between two audits, keyed on stable finding ids.
- CLI `diff --before <a.json> --after <b.json>` renders both (markdown or
  `--json`) and exits 2 with `--fail-on-new-findings` — a hygiene
  *regression* gate for nightly CI, not just a hygiene presence gate.
- CLI `snapshot --archive <dir>` writes timestamped
  `<provider>-<generatedAt>.json` files for snapshot history.

## [0.4.0] — Unreleased

### Added

- **Configuration file** (`fullstackgtm.config.json`, or `--config <path>`):
  policy thresholds, rule selection (`enabled`/`disabled`), and
  `rulePackages` — modules exporting `rules: GtmAuditRule[]` — so a team's
  audit standard lives in version control. CLI flags still win over config.
- **Five new built-in rules** (10 total), each with a `category`:
  `missing-deal-amount` (forecast), `duplicate-account-domain` and
  `duplicate-contact-email` (data-quality, case-insensitive grouping),
  `active-deal-account-without-contacts` (coverage), and
  `closing-soon-inactive` (forecast, severity critical) — open deals inside
  the closing window with no recent activity, i.e. silent slip risk.
- Policy gains optional `requireDealAmount`, `closingSoonDays`, and
  `closingSoonIdleDays` thresholds.
- `rules` command resolves the configured set (including rule packages) and
  shows categories.

### Changed

- Demo-dataset golden counts updated for the new rules (69 → 79 findings;
  the duplicate rules fire on realistic generated data).

## [0.3.0] — Unreleased

### Added

- **Durable plan workflow** (`PlanStore` + `createFilePlanStore`): plans stay
  immutable proposals; the store tracks the lifecycle around them — approved
  operation ids, human-supplied value overrides, and every apply run. The
  file store keeps one JSON document per plan under `~/.fullstackgtm/plans`.
- CLI lifecycle: `audit --save`, `plans list|show|approve|reject`, and
  `apply --plan-id <id>` — the store enforces that nothing applies before
  approval and records the run afterward. Approving operations can carry
  `--value <opId>=<v>` overrides that persist with the plan.

### Notes

- The hosted app's Convex plan tables are the second `PlanStore`
  implementation target; unifying them onto these types is the remaining
  0.3.x work (see docs/roadmap-to-1.0.md).

## [0.2.0] — Unreleased

### Added

- **Salesforce connector** (`createSalesforceConnector`) behind the same
  `GtmConnector` contract: SOQL reads with cursor pagination, PATCH
  write-back (correctly handling Salesforce's `204 No Content`), per-org
  field mappings, probabilities normalized to canonical 0..1, and the same
  never-drop-records guarantee as HubSpot.
- **Salesforce CLI auth**: `login salesforce --device --client-id <consumer
  key>` uses Salesforce's native device-authorization grant — a code
  confirmed on any device, no localhost server, no client secret, silent
  refresh. Manual `--token --instance-url` also supported.
- **Broker mint for Salesforce**: paired CLIs exchange their broker token for
  `accessToken + instanceUrl + fieldMappings` from the org's stored sync
  credentials. `resolveSalesforceConnection` joins the resolution ladder.
- CLI/MCP provider surfaces accept `salesforce` everywhere `hubspot` was
  accepted (`--provider`, apply, MCP enums).

## [0.1.0] — Unreleased

Initial public release.

### Core

- Canonical, provider-independent GTM data model (users, accounts, contacts,
  deals, activities) with multi-system identity claims (`identities:
  {provider, externalId}[]`) and provider payload escape hatches.
- Pluggable deterministic audit-rule engine (`GtmAuditRule`). Five built-in
  hygiene rules: orphan accounts, ownerless deals, unlinked deals, past close
  dates, stale pipeline. Finding and operation ids are stable hashes, so runs
  over the same data are diffable.
- Dry-run patch plans: every proposed write is a typed operation with
  before/after values, a reason, a risk level, and an approval flag.
- `applyPatchPlan` orchestrator enforcing the safety contract for all
  connectors: explicit per-operation approval, no `requires_human_*`
  placeholder writes without a concrete value override, per-operation result
  records (`PatchPlanRun`).
- `GtmConnector` contract (`fetchSnapshot` / `applyOperation`) and a HubSpot
  reference connector (plain `fetch`, injected token, per-org field mappings).
  The connector never drops unresolvable records — audits surface them.
- Seeded deterministic demo dataset (`generateDemoSnapshot`): a realistic,
  deliberately messy mid-market CRM with injected real-world failure modes.

### CLI (`fullstackgtm`)

- `snapshot` / `audit` / `apply` / `rules` — composable, JSON-everywhere,
  meaningful exit codes (`0` success, `1` error, `2` findings at/above
  `--fail-on` threshold).
- Rule scoping (`--rules`), policy overrides (`--today`, `--stale-days`),
  demo and file sources, severity gating for CI and agent loops.
- `login hubspot` — private app token (zero web flow, validated) or
  bring-your-own-app OAuth via RFC 8252 loopback with silent refresh.
- `login --via <hosted url>` — broker pairing: device-flow handshake against
  a hosted FullStackGTM deployment; the CLI exchanges a revocable broker
  token for short-lived provider tokens minted from the org's stored sync
  credentials, inheriting org field mappings.
- Credential resolution ladder: `--token-env` → ambient env → stored direct
  login → broker pairing. Stored in `~/.fullstackgtm/credentials.json`
  (0600, `FSGTM_HOME` overridable).

### MCP (`fullstackgtm-mcp`)

- `fullstackgtm_audit` (sample/demo/file/live sources, rule scoping),
  `fullstackgtm_rules`, and `fullstackgtm_apply` (requires explicit
  `approvedOperationIds`) over stdio.

[0.1.0]: https://github.com/fullstackgtm/fullstackgtm/tree/main/packages/fullstackgtm

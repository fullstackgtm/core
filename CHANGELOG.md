# Changelog

All notable changes to the `fullstackgtm` package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).
The path to 1.0 is planned in [docs/roadmap-to-1.0.md](https://github.com/fullstackgtm/core/blob/main/docs/roadmap-to-1.0.md).

## [Unreleased]

## [0.52.2] — 2026-07-11

### Fixed

- Interactive `icp derive` resumes raw terminal input after editing a field,
  returning to the ICP card for further edits instead of exiting the process.

## [0.52.1] — 2026-07-11

### Fixed

- OpenRouter 401/403 failures now name `fullstackgtm login openrouter` as the
  credential replacement path and explain that `OPENROUTER_API_KEY` overrides
  the stored profile key.
- Interactive secret prompts remain non-echoing but now confirm paste activity
  with a masked glyph preview and received-character count.
- Interactive ICP review cards cap their width, wrap long segment values, and
  repaint only their own terminal rows instead of clearing the whole screen.

## [0.52.0] — 2026-07-11

### Added

- `fullstackgtm icp derive --domain <site>` derives an evidence-backed ICP
  from a public website with OpenRouter, OpenAI, or Anthropic, then offers an
  interactive arrow-key review before writing `icp.json`.
- `fullstackgtm login openrouter` stores and validates a profile-scoped API key
  for website-to-ICP derivation.
- OpenRouter derivation streams reasoning activity and provider-authored
  reasoning summaries into the CLI status line during the model's longest wait.

### Changed

- Public website fetching retains DNS pinning while disabling Node's automatic
  address-family selection, avoiding custom-lookup failures on current Node.
- ICP-to-Clay filters map only supported catalog industries rather than
  inventing unsupported provider labels.

## [0.51.0] — 2026-07-11

### Added

- Native Clay Public API authentication and people search for governed lead
  acquisition, including ICP-to-Clay filter translation and resumable search
  checkpoints.
- A provider-neutral, fill-only contact waterfall contract for work email,
  mobile, and direct-dial enrichment, with Pipe0 as the first registered
  provider and compatibility for existing Pipe0 email resolution.
- Clay acquisition presets, initialization, doctor diagnostics, public API
  exports, strategy documentation, and live-safe credential validation.

### Changed

- `enrich acquire` now uses the shared decision-first presentation contract:
  compact cards by default, full evidence with `--verbose`, and a stable JSON
  envelope with counts, cost, meter, and persistence state under `--json`.
- Pre-enrichment deduplication and avoided-spend reporting are provider-neutral
  so the same acquisition pipeline can support additional contact sources.

## [0.50.1] — 2026-07-10

### Added

- Decision-first CLI presentation across plan previews, plan queues, apply
  outcomes, doctor, schedules, signals, ICP, market, TAM, and call analysis.
  Human defaults use compact cards and ranked summaries; `--verbose` restores
  full audit detail and `--json` retains the stable machine contract.

### Fixed

- HubSpot 429/5xx responses now retry with bounded backoff, honor
  `Retry-After`, and report accurate live throttle feedback.
- Multi-line progress boards no longer scroll intermediate paint frames into
  terminal history.
- `plans sync` reconciles historical workspaces concurrently with visible
  progress, skips absent legacy mirrors, and avoids echoing hosted-origin
  receipts back to hosted.
- CLI apply reports only the exact approved receipt subset to hosted while
  retaining excluded rows in the complete local audit trail.
- Plan and apply output now distinguish approved, applied, excluded, skipped,
  and failed operations without exposing the immutable document's stale
  creation-time status as the current lifecycle state.

## [0.50.0] — 2026-07-10

### Added

- CLI and hosted now act as local-first replicas of one immutable patch plan.
  Either surface may execute when it has a compatible CRM connection; online
  execution uses a shared claim, while offline CLI work remains available and
  reconciles later through stable provider idempotency and exact receipts.
- `fullstackgtm plans sync` explicitly exchanges approval revisions, terminal
  state, and per-operation execution receipts. Plan list, show, and apply also
  perform best-effort ambient check-ins.
- Hosted can execute fully synchronized CLI-origin plans through its connected
  HubSpot or Salesforce connector. The CLI imports hosted runs without replaying
  provider writes, and hosted imports exact CLI outcomes rather than inferring
  success for every approved row.

### Security

- Shared execution claims are bound to the immutable plan, exact approved
  subset, replica, and paired CLI token. Approval edits freeze during apply;
  stranded claims require an explicit audited recovery, and preflight release
  is permitted only before provider I/O by the owning replica.
- Hosted ingestion recomputes the immutable document digest and verifies an
  exact one-to-one operation set. Terminal transitions require complete,
  duplicate-free receipts for the approved subset and cannot widen authority.

### Fixed

- Paired CLIs now mirror saved plans into the hosted Patch Plans queue and
  print an exact review deep-link. Mirrors are org-scoped, immutable and
  idempotent; hosted approvals are hash/operation-verified and locally
  HMAC-signed before CLI execution. Security state and evidence/findings stay
  local, while bounded provider receipts replicate between capable executors.
- `enrich acquire` now reports discovery, resolution, and plan-building progress
  across the previously silent provider/dedupe middle. Paired hosted runs render
  the same live stage, counters, and generic progress notes on their detail page.
- Interactive acquisition runs retain both the CRM snapshot and acquisition
  checklists in terminal history, then print a compact plan summary, copyable
  review/approve/apply commands, and the paired hosted Runs deep-link.
- Persistent progress completion freezes the already-painted final frame rather
  than repainting it, preventing duplicate live/final checklists in scrollback.
- Acquisition now persists query-bound Pipe0 cursors and HeyReach/Explorium
  offsets so scheduled runs traverse the full audience instead of repeatedly
  exhausting the first 25 results. `--max` controls desired new leads and the
  new `--scan-limit` bounds raw duplicate-heavy scanning. Run history records
  the complete discovery funnel and provider-confirmed exhaustion state.
- Checkpoints now live in a dedicated profile-scoped store keyed independently
  by provider/source/list/query. Paired CLIs synchronize opaque continuation to
  an organization-scoped hosted record using broker authentication and
  compare-and-swap revisions; conflicts retain the newer hosted checkpoint.
- The documented LinkedIn `--list <id>` flag is accepted by strict CLI parsing,
  and NAICS-only software ICPs retain their industry constraint on Pipe0.

## [0.49.0] — 2026-07-10

### Security

- MCP apply now accepts only store-backed, HMAC-approved plan ids; external
  plan paths and caller-supplied approvals/value overrides are rejected.
- Apply uses an atomic single-owner claim and durable attempt journal.
  Uncertain attempts remain fail-closed until an operator acknowledges provider
  state; recovery clears every approval and never replays writes automatically.
- Salesforce credential-bearing endpoints are restricted to canonical HTTPS
  Salesforce origins and redirects are handled without forwarding credentials.
- Executable rule packages require explicit CLI trust and are disabled entirely
  in MCP. Implicit repository configuration cannot activate plugins.
- Sensitive local files use atomic no-follow writes and verified no-follow
  reads; symlinked credential, plan, and managed-home paths are refused.
- Market capture/sourcing uses DNS-pinned public-only HTTP with per-hop redirect
  validation, bounded responses, and cross-origin credential stripping.
- Provider HTTP failures expose typed status metadata without raw response
  bodies, reflected secrets, or PII.

### Changed

- **Breaking pre-1.0 plan-store contract:** `PlanStore` implementations now
  participate in apply claims, attempt recovery, and claim-bound run recording;
  `ApprovalStatus` includes `applying`. Custom stores must implement the new
  lifecycle before upgrading.
- Public mirror generation is commit-derived, allowlisted, secret-scanned, and
  fail-closed. npm publishing uses pinned actions/npm plus a protected release
  environment and provenance verification.
- Package CI now validates Node 20/22, Linux/macOS/Windows compiled runtimes,
  and actual installed tarballs with and without optional MCP peers.

### Fixed

- `bulk-update --help` and `-h` now return focused help before parsing an object
  type or touching configuration, credentials, disk, or network.
- Installation guidance no longer pins a brittle exact demo finding count.

## [0.48.0] — 2026-07-08

### Added

- Added `GtmAuditRule.emitsOperations` and `isFindingsOnlyRule` so hosts can derive findings-only rule behavior from the package registry instead of duplicating rule IDs.
- **Route, hierarchy, and relationships open surfaces.** `route leads` builds governed lead-to-account/owner patch plans; `hierarchy report` and `relationships account` provide read-only planning reports for account trees and stakeholder maps.

### Changed

- **CLI human path now uses progressive disclosure by default.** Bare
  `fullstackgtm`/`--help` shows a compact lifecycle-grouped command map instead
  of the full flag wall; `help <command>` and `<command> --help` show focused
  per-command guidance; `help --full` (including `help <command> --full`) keeps
  the complete reference available. `audit` now defaults to a summary view with
  `--full` for per-operation detail and prints next-step guidance on stderr for
  human runs while keeping `--json` machine-clean. The dry-run footer now frames
  approval/write safety as invariants rather than prototype copy.
- **Patch-plan assumptions and open questions are canonical.** Plan exports and
  markdown use `assumptions` plus `openQuestions`; the duplicate
  `decisionPoints` alias was removed.

### Fixed

- **Route plan safety and batching.** Owner routing recognizes both canonical
  user ids and provider CRM owner ids, skips name-only account matches as
  ambiguous, avoids self-conflicting sibling preconditions, groups only contacts
  with multiple operations, and uses one shared free-email domain list.
- **Hierarchy and relationships correctness.** Hierarchy reports dedupe duplicate
  account ids, avoid common public-suffix parent guesses, and rely on a single
  cycle-dedupe pass. Relationship `--domain` selectors normalize domains and
  markdown preserves zero-value deal amounts.

## [0.47.0] — 2026-07-06

### Added

- **Batched CRM apply for updates and deletes.** `applyPatchPlan` can now dispatch consecutive homogeneous `set_field` / `clear_field` / `archive_record` runs through an optional connector `applyBatch` capability with connector-declared `applyBatchLimit`. Salesforce implements this with batched CAS SOQL reads and Composite sObject Collections update/delete (`allOrNone:false`, 200/call); HubSpot implements batched CAS reads plus `/batch/update` and `/batch/archive` (100/call). Both preserve per-operation `applied | skipped | conflict | failed` results and connectors without the capability stay on sequential apply.

## [0.46.0] — 2026-07-06

### Fixed — launch hardening

- **`fullstackgtm-mcp --help`/`--version` now work without optional peers.**
  The MCP entrypoint parsed argv before importing `@modelcontextprotocol/sdk`
  and `zod`, so on a clean install `fullstackgtm-mcp --help` exited 1. It now
  prints usage (and the `npx -y -p fullstackgtm -p @modelcontextprotocol/sdk
  -p zod fullstackgtm-mcp` invocation) and exits 0.
- **Packaging hygiene.** Narrowed `files` so internal planning docs
  (`dx-punch-list`, `perf-notes`, `roadmap-to-1.0`) no longer ship in the npm
  tarball; strengthened `prepublishOnly` to also run `npm pack --dry-run` and
  smoke both bin `--help` paths.
- **Doc accuracy.** README Stripe restricted-key guidance now includes
  Invoices:Read (required by `backfill stripe`); schedule allowlist lists
  `enrich acquire --save`; benchmark headline points to the leaderboard
  caveats; `llms.txt` clarifies Stripe is read-only and fixes broken public
  mirror links; CHANGELOG clarifies unmatched Stripe customers get a proposed,
  approval-gated account-create (not silent auto-create).
- **Public-surface scrub.** Replaced realistic fake LinkedIn prospect fixtures
  with clearly-synthetic example identities and removed private-context
  wording from shipped source/docs.

### Added

- **Hosted first-party CRM OAuth for the CLI.** `fullstackgtm login hubspot` and
  `fullstackgtm login salesforce` now default to hosted browser OAuth (explicit
  `--hosted`, `--via`/`FULLSTACKGTM_HOSTED_URL` override), storing the same local
  broker credential used by team pairing while provider tokens are minted
  server-side. BYO app/token paths remain as advanced fallbacks, secrets still
  never travel via argv, and first-party app secrets never ship in the npm
  package. Non-TTY missing-BYO-flag errors print a deterministic hosted-login
  next command.

- **Chunked LLM insight extraction (`extractInsightsChunked`) — the TamTone
  "langextract" method.** Transcripts are never sent whole: they are chopped
  into ~1,500-char speaker-turn-respecting chunks (the tested quality lever —
  small chunks yielded ~95% more grounded signals than large ones) and each
  chunk gets its own focused few-shot extraction call. Per-chunk results pass
  the SAME verbatim-evidence and next-step-grounding gates as before (checked
  against the chunk they came from — a quote from another chunk is treated as
  a hallucination), then a quality gate
  (0.25·length + 0.40·specificity + 0.35·confidence, reject < 0.15) filters
  filler before per-call dedupe (richer statement wins) and ranking.
  `call parse --llm` now uses this pipeline; single-shot remains for
  one-chunk transcripts. Bounded: ≤80 chunks/call, 4 concurrent, a failed
  chunk is skipped (all-failed throws).

- **`backfill runs` — replay local execution history to the paired hosted
  app.** An engagement that started CLI-only gets its full trail on pairing:
  every stored plan's apply runs (with per-op result counts and ORIGINAL
  timestamps) and the `health.jsonl` hygiene timeline (seeding the hosted
  health trend). Idempotent by construction — deterministic per-run
  `clientRunId`s and server-side timestamp dedupe make re-running safe.
  `--dry-run` counts without sending. Privacy unchanged: only what live
  reporting sends leaves the machine (statuses, counts, timestamps,
  scores — never CRM field values). Live run reports also carry a stable
  `clientRunId` now, so retried reports never duplicate.

- **`backfill stripe` — paid Stripe invoices become closed-won CRM deals,
  through the normal governed flow.** For a business whose revenue source of
  truth is Stripe, the CRM can now be retroactively made honest: one
  closed-won deal per paid invoice (amount = invoice total, close date = paid
  date, associated to the customer's company), matched to CRM accounts by
  billing-email domain first, then exact name. Unmatched customers are either
  report-only (when they lack a usable name/domain, or with `--skip-unmatched`)
  or an explicit proposed ACCOUNT create in the same `needs_approval` plan. The
  command only ever proposes: `--save` persists the plan and writes happen
  through `plans approve` → `apply`, where the connector re-resolves each
  invoice id and creates only on a confirmed miss — re-running never
  double-creates. Proposed account creates are one op per customer, use the
  billing-email domain unless freemail, and stay approval-gated like every
  other write.
- **HubSpot deal creation in `create_record`.** `CreateRecordPayload` gains
  `dealStage: "closed_won"` (a provider-neutral sentinel resolved to the
  target pipeline's real closed-won stage id from pipeline metadata — never
  substring guessing) and `dealPipeline` (id or label; default pipeline when
  absent). The dedupe key is a custom deal property (default
  `stripe_invoice_id`), ensured on demand; if it can't be ensured the create
  is skipped rather than performed without its dedupe key. Salesforce deal
  creation stays explicitly skipped for now.
- **`fetchStripePaidInvoices`** on the Stripe connector: paginated
  `status=paid` invoice reads with `created[gte]` incremental support,
  cents→major conversion, and paid-date extraction.
- **Node-free health scoring (`src/healthScore.ts`).** `computeHealth` /
  `summarizeHealth` / `healthToMarkdown` split out of `health.ts` (which keeps
  the fs-backed profile timeline and re-exports everything) so V8 runtimes —
  the hosted app's Convex functions — can score CRM hygiene with the exact
  same deterministic curve the CLI uses.

### Changed

- **CLI startup is ~20–30% faster (p50), with zero output changes.** The
  dispatcher now loads verb modules lazily instead of compiling the full
  78-module graph on every invocation, `node:http` (which transitively
  compiles node's bundled undici on Node 22) is deferred to the OAuth
  loopback login that actually starts a server, and the CRM connector /
  demo-data modules load only when that data source is selected. Measured
  p50 over interleaved A/B runs: `--version` −31%, `capabilities --json`
  −30%, `audit --demo --json` −23%. Every output is byte-identical to the
  previous build (verified against 57 golden outputs across help, audit,
  doctor, rules, dedupe, resolve, snapshot, and error paths) and the public
  import surface of `cli.ts` is unchanged. Profiling method, opportunity
  matrix, and honest non-wins are documented in
  [docs/perf-notes.md](https://github.com/fullstackgtm/core/blob/main/docs/perf-notes.md).

## [0.45.0] — 2026-07-02

### Added (TUI glamour — interactive terminals only)

- **A terminal presentation layer (`src/cli/ui.ts`, zero new dependencies) —
  styling and animation exist ONLY on an interactive TTY.** Piped, redirected,
  `--json`, CI, and `NO_COLOR` output is byte-identical to the pre-TUI CLI
  (verified against the previous build for 14 verbs: stdout, stderr, exit
  codes); a new `agent-cli.yml` step and `tests/fullstackgtmAnsiSafety.test.ts`
  enforce zero ANSI bytes in piped output permanently. `FORCE_COLOR=1` opts
  piped output back into color per spec. On a TTY:
  - `doctor` colors each check (green ok / red MISSING), dims what's not
    connected, bands the health score, appends a score-history sparkline, and
    frames "Next step" in a box. `--help` gets a dimmed brand header
    (version · active profile), bold command names, cyan lifecycle groups.
  - `health` renders a styled rollup: banded score, ▲/▼ delta, score
    sparkline, aligned object-type and per-rule tables (positive finding
    deltas red — more findings is worse — negative green).
  - Live provider pulls show a stderr spinner with a running tally ("Pulling
    contacts from hubspot… 2,400 fetched · 12s"): the HubSpot/Salesforce
    connectors accept an optional per-page `onProgress` (presentation-only,
    errors swallowed). `audit` renders its rule registry as a live checklist
    (○ → spinner → ✓ with finding counts) via a new optional `onRule` on
    `auditSnapshot`; `signals fetch` shows a per-domain ATS tally.
  - `apply` and `fix --yes` tick per-operation progress ("Applying 41/120 ·
    ✓ 40 applied · 0 failed · 1 conflict") via a new optional `onOperation` on
    `applyPatchPlan`, closing with a colored outcome badge. `enrich
    append/refresh` gets a progress bar with rate + ETA over the Apollo pull;
    `enrich acquire` adds a budget fuel gauge (records + spend vs day/month
    caps, color-banded by burn).
  - LLM waits show an elapsed status line (`call parse` / `call score`);
    `icp judge` and `market classify` report per-account / per-vendor progress
    via new optional `onAccount` / `onVendor` callbacks.
  - Patch plans render with severity banding and value diffs — current value
    red, proposed value green, `requires_human_*` placeholders yellow — in
    `audit` and `plans show`; `plans list` becomes an aligned status-banded
    table (summaries truncated with `…` to the terminal width so rows never
    wrap); `fix` frames its stop-before-apply command in a box.

### Added (agent ergonomics pass 1)

- **Flag typos are caught instead of silently ignored.** Any `--flag` that is
  documented nowhere in the help reference but sits within one edit of a
  documented flag (after lowercasing and `_`→`-` normalization) now stops with
  exit 1, a `Did you mean: --json` hint, and the exact corrected command;
  `--json` callers get a structured `UNKNOWN_FLAG` envelope. Previously
  `audit --demo --jsn` exited 0 and printed markdown where the caller asked
  for JSON, and `reassign … --sav` exited 0 without saving. Suggest-only —
  the correction is never auto-executed, so a typo can never change what a
  write-shaped invocation stages. The known-flag registry is derived at
  runtime from the help table (no parallel list); unknown flags with no
  near-miss behave exactly as before.
- **Unknown commands get a did-you-mean on the plain-text path too.**
  `fullstackgtm plan` now answers `Did you mean: fullstackgtm plans` plus one
  pointer line each to `--help` and `capabilities --json`, instead of the
  full usage-reference dump. (The `--json` envelope already had the hint.)
- **`doctor` is now the one-call triage surface.** `doctor --json` adds a
  `workspace` slice — `healthScore`, `scoreDelta`, `lastAuditAt`,
  `auditCount`, and `pendingPlans` (id, summary, operation/approved counts) —
  and when a plan is awaiting approval `nextSteps` becomes the copy-pasteable
  `plans show` → `plans approve` → `apply` chain with the connected provider
  filled in. Text `doctor` gains the matching `Workspace:` section.
  Previously orienting an agent took three calls (doctor + health +
  plans list).
- **`audit` output is byte-deterministic under `SOURCE_DATE_EPOCH`.** The
  plan's `createdAt` honors the reproducible-build convention (seconds since
  the epoch) so golden tests and CI diffs can pin `audit --demo --json`
  byte-for-byte. Unset, it remains the real clock.
- **GNU-style `--flag=value` is corrected too.** `audit --rules=x` was
  silently dropped (the audit ran with all rules); an `=`-form whose base
  resolves to a documented flag now stops with the space-separated form this
  CLI parses (`Try: … --rules x`).
- **A flag-shaped first token is diagnosed as flag-before-command.**
  `fullstackgtm --jsn` was "Unknown command: --jsn"; now it explains that a
  command must come first and resolves the flag when it near-misses a
  documented one.
- **Subverb typos get a nearest-match did-you-mean on all 7 multi-verb
  commands** (`enrich`, `market`, `icp`, `signals`, `plans`, `schedule`,
  `tam`): `enrich apend` → `Did you mean: fullstackgtm enrich append?` plus
  the full list. `market <typo>` no longer dies with a `market.config.json`
  ENOENT before the subcommand is validated.

### Changed (agent ergonomics pass 1)

- **`apply <planId>` / `suggest <planId>` (positional) now name the exact
  corrected command** (`apply --plan-id <id> --provider <…>`) instead of
  misdiagnosing the mistake as a missing `--provider`. Both verbs stay
  flag-explicit; nothing is inferred into execution.
- **`Unknown provider: hubpsot` now adds `Did you mean hubspot?`** (CLI and
  MCP paths); the supported-provider list is unchanged.

### Changed

- **MCP zero-install is now one short command: `npx -y fullstackgtm-mcp`.** A
  thin wrapper package (`fullstackgtm-mcp@0.1.0`, monorepo
  `packages/fullstackgtm-mcp`, published manually — the OIDC release flow
  covers only this package) pins the optional MCP peers as hard dependencies
  and delegates to this package's `dist/mcp-bin.js`. README, SKILL.md, and the
  missing-peer help text now lead with the short command; the explicit
  `-p fullstackgtm -p @modelcontextprotocol/sdk -p zod` form still works.

### Added

- **`schedule install` no longer needs Full Disk Access on macOS: launchd
  LaunchAgents are the default timer there.** macOS gates `crontab` writes
  behind FDA — an unpromptable TCC permission granted to the terminal app,
  not the CLI — so on darwin `install` now writes one LaunchAgent plist per
  enabled entry (`com.fullstackgtm.<profile>.<id>` in
  `~/Library/LaunchAgents`, loaded via `launchctl bootstrap gui/<uid>`),
  which needs no permission at all. The cron expression compiles to
  `StartCalendarInterval` dicts (full-range fields become launchd wildcards;
  dense expressions are capped at 512 dicts with a clear error; Vixie
  dom+dow OR becomes a Day set plus a Weekday set). Every plist's
  `ProgramArguments` is `… schedule run <id> --profile <p> --trigger cron`
  and nothing else — the same single-entry-point audit story as the crontab
  block — and re-install replaces the profile's plist fleet wholesale,
  never touching foreign plists. launchd also coalesces firings missed
  during sleep into one run on wake, where cron silently skips. `--timer
  crontab|launchd` overrides the platform default (launchd on macOS, crontab
  elsewhere); stdout/stderr of each firing lands in
  `<home>/schedule/logs/<label>.log`. New run no-op reason
  `duplicate_firing`: `schedule run` drops a second cron trigger in the same
  minute, so a date matching both the Day and Weekday interval sets cannot
  double-run a command.

- **Standardized flag aliases (additive — every legacy flag keeps working).**
  `--dry-run` is now accepted on the plan-spine verbs (`audit`, `suggest`,
  `bulk-update`, `dedupe`, `reassign`, `fix`, `call plan`,
  `enrich append`/`refresh`/`acquire`, `signals fetch`, `icp judge`, `draft`,
  `tam status`, `market overlay`): these verbs were already preview-by-default,
  so the flag asserts that default — it suppresses `--save` (with a stderr note
  when both are passed) and locks `fix` to its stop-before-apply path even with
  `--yes`. Omitting it changes nothing. `--confirm` is now an accepted alias
  for `fix --yes` (matching `tam accounts --confirm`); `--dry-run` beats both.
- **Staged-file ingestion converged on the spool container convention
  (additive).** `signals fetch --from` and `enrich ingest` now also accept a
  `*.jsonl` spool file (one JSON row per line) or a directory of `*.jsonl` /
  `*.json` spool files — the Phase-2 webhook landing-zone format
  (docs/signal-spool-format.md) — and `market observe --from` accepts a
  `*.jsonl` file / directory of observation-set envelopes, each validated and
  appended through the same gates as the single-file path. Existing `.json` /
  `.csv` inputs parse exactly as before. Shared reader: `src/spoolFiles.ts`
  (the `file` signal-source connector now delegates to it, error text
  unchanged).
- **Machine-readable agent contract: `capabilities`, `robot-docs`, and
  `--help --json`.** `capabilities` prints the CLI contract as JSON: the
  command inventory with read-only vs write-shaped access derived from the
  help table's lifecycle phases (never a hand-maintained parallel list), the
  documented exit-code contract, safety defaults, and the MCP entrypoint.
  `<command> --help --json` (and `help <command> --json`) prints the same
  per-command help as JSON — plain `--help` output is unchanged except that
  `audit --help` now documents the pre-existing `--input <path>` flag.
  Unknown commands invoked with `--json` return a structured
  `{ ok: false, error: { code: "UNKNOWN_COMMAND", hints: [did-you-mean] } }`
  envelope on stdout (exit 1) instead of the full-usage text wall.
  `robot-docs` prints the packaged agent guide (skills/fullstackgtm/SKILL.md,
  already shipped in the npm tarball) — one maintained guide, not a third
  parallel one.
- **MCP `fullstackgtm_capabilities` tool.** The MCP server's tools are now
  declared in a single registration table and registered in a loop; the new
  tool reports the inventory (with per-tool `writesCrm` flags — only
  `fullstackgtm_apply` can reach a CRM) from that same table, so the
  advertised list cannot drift from what is actually registered. The existing
  tools' behavior is unchanged.
- **`--input` snapshot files are validated.** `--input` now checks the file
  parses to the canonical snapshot shape (the JSON `snapshot --out` writes)
  and fails with a field-level error naming what's missing, instead of a
  blind cast that surfaced as a crash deep in a rule — or an empty "clean"
  audit.

### Fixed

- **`bulk-update` restored to the help front door.** The grouped short-usage
  map listed the verb in its Remediate group but silently skipped rendering
  it (no help-table entry), and `help bulk-update` dead-ended on the short
  map. It now has a proper entry and appears in the derived `capabilities`
  inventory.

### Changed

- **Internal: `src/cli.ts` (6,003 lines) split into per-verb modules under
  `src/cli/`** (help, audit, fix, call, market, enrich, signals, draft, tam,
  icp, init, schedule, plans, auth, shared). No behavior change: `dist/bin.js`
  stays the entry, arg parsing / help text / exit codes are unchanged, and
  `cli.ts` still exports `runCli`, `doctorReport`, `assertSecureBrokerUrl`.

## [0.44.0] — 2026-07-01

### Added

- **Paired CLI auto-links HubSpot to the hosted deployment.** When a broker
  credential exists (a paired CLI), `audit --provider hubspot` hands the local
  HubSpot private-app token to the deployment over the broker channel
  (best-effort, with a printed notice), so the hosted Integrations page shows
  HubSpot connected and syncing without a separate OAuth setup. Unpaired CLIs
  are unaffected — pairing remains opt-in via `login --via`.

### Added

- **`tam accounts` credit-cost preview + spend guard.** Pulling the list costs ~3
  TheirStack credits/company, so `tam accounts` now prints the cost up front and
  never spends by surprise: `--dry-run [--usd-per-credit <rate>]` prices the pull
  AND the full TAM (e.g. "up to 100 ≈ 300 credits; full TAM ~43,517 ≈ 130,551
  credits (~$5,483)") for **0 credits**, and a pull above `--max-credits` (default
  150 ≈ 50 companies) requires `--confirm`. The dollar figure appears only with an
  explicit rate (no fabricated default; TheirStack is ~$0.04–$0.11/credit by tier).
  `tam populate` also notes where spend lives — the acquire meter governs
  population, separate from the TheirStack list pull. Library:
  `theirStackPullCost` + `THEIRSTACK_CREDITS_PER_COMPANY`.

### Changed

- **`tam status` coverage is now classified against the TAM ICP — not a raw
  account count.** Previously it counted *every* domain-bearing CRM account over
  the universe, so accounts loaded from any source (off-ICP or not) inflated
  coverage and could read >100%. Now `tam estimate` stores the ICP filter
  (`model.targeting`), and `status` classifies each account into **in-TAM /
  out-of-TAM / unknown** (checked on size + industry; geo and "uses-CRM" aren't on
  a `CanonicalAccount`, so they need re-enrichment — a `--reverify` pass is
  planned, and the classifier labels what it checked). Only in-TAM counts toward
  coverage; off-ICP junk is bucketed out. **Bottom-up vs top-down reconciliation:**
  the in-TAM count is a floor on the real universe, so when it meets/exceeds the
  estimate, `status` stops reporting a fake 100% and flips to "the estimate was a
  floor — your real market is at least N (`reconciledUniverse`); re-estimate for
  the headroom." ETA now burns on in-TAM accounts/day. New library:
  `classifyAccount`, `classifyCoverage`, `crmCheckableCriteria`, `coveredAccounts`,
  `TamTargeting`/`TamClassified` (and `TamModel.targeting`). Legacy models without
  targeting fall back to counting all accounts, with a "re-estimate to classify"
  note.

### Added

- **`tam` technographic sourcing via TheirStack — target by CRM-usage, get a real
  list.** The Explorium firmographic count (NAICS/size/geo) is a weak proxy for a
  RevOps/CRM-hygiene tool and can't return the list (it 403s on pull). New
  `--source theirstack` counts companies that actually **use** a CRM/MAP — set
  `icp.firmographics.technologies` (e.g. `["salesforce","hubspot","pipedrive"]`),
  mapped to TheirStack `company_technology_slug_or` + employee bounds + country —
  which is the real buying signal, labeled `provider:theirstack (uses-CRM)`. And a
  new **`tam accounts --source theirstack`** pulls the actual company list (real
  names + domains, `--out <csv>` or `--json`, `--max` caps the credit spend), so the
  TAM is a list you can review and acquire, not just a number. Counting is cheap
  but not free (TheirStack rejects `limit:0`, so a count returns 1 row ≈ 3 credits;
  a list pull is ~3 credits/company). New connector
  `connectors/theirstack.ts` (`theirStackCountCompanies` / `theirStackSearchCompanies`),
  `icpToTheirStackFilters` + `employeeBandsToRange`, and `login theirstack`.
  (Verified live: filters + `metadata.total_results`; `limit` must be ≥ 1.)

### Changed

- **`tam estimate` requires a confirmed ANNUAL ACV — no fabricated defaults, and
  the CRM is not silently the ACV source.** A TAM dollar figure built on a guessed
  ACV is a false signal, so the `--acv-band smb|mid|enterprise` presets (hardcoded
  $6k/$24k/$90k) are removed and `estimate` refuses to run without a real ACV. Two
  confirmed paths, always labeled on the model (`acv.source`): `--acv <annual-usd>`
  (`"explicit (annual)"`), or `--acv-from-crm --deal-period monthly|quarterly|annual`
  — the median closed-won deal amount **annualized** by the stated period
  (`"crm:closed-won (N deals, median $X/monthly ×12 = annual)"`). The period is
  **required**: a deal amount can be MRR/quarterly/annual and guessing it is a
  4–12× error (a $15k/mo deal is a $180k ACV). A bare `--provider` is the COVERAGE
  source and **no longer auto-sets ACV**. **Buyers/account** likewise:
  `--buyers-per-account <n>`, else the CRM's **average contacts per account**
  (`"crm:avg-contacts/account (N)"`), else a labeled `"assumption:1-buyer"` — never
  a silent default of 3. New library helpers `deriveAcvFromClosedWon` /
  `deriveBuyersPerAccount`; `TamModel.acv.source` and `universe.buyersSource` are
  new fields (and `acv.band` is gone).

### Fixed

- **`icp eval --golden default` no longer rots with the calendar.** The default
  golden set's `firstSeen` stamps are relative to a pinned instant
  (`DEFAULT_GOLDEN_NOW_ISO`, exported), but grading used wall-clock `new Date()`
  — so freshness decay silently degraded the "fresh → send" rows until the gate
  started failing (~8 days after the set was authored) on every fresh install
  and in CI, with no code change. The default set is now graded on its own
  pinned clock; file-based golden sets still grade against wall time (their
  timestamps are the caller's).

- **`enrich acquire` (pipe0/Crustdata) over-narrow ICP filter → zero discovery.**
  Live testing surfaced that a RevOps ICP returned 0 prospects from pipe0/Crustdata
  even though a title-only search returned plenty — the prime suspect is the
  industry vocabulary: LinkedIn renamed its industry taxonomy (v1→v2) and the map
  sent only one generation, so a vendor on the other generation matches nothing.
  `CRUSTDATA_INDUSTRY` now sends BOTH generations per cluster (e.g. "Software
  Development" *and* "Computer Software"), OR-matched within the field. (pipe0
  credits were exhausted mid-investigation, so this is a reasoned fix not yet
  re-confirmed end-to-end — re-run `enrich acquire --source pipe0` once credits
  refill; if still zero, the next suspects are the `current_seniority_levels`
  shape and `locations`. Note `scoreProspectAgainstIcp` backstops persona but NOT
  industry, so the industry filter is load-bearing.)
- **`enrich acquire` now surfaces a zero-discovery result** instead of emitting a
  silent empty plan: when a provider returns 0 prospects it warns that this is
  usually an over-narrow filter (not an empty market) and points at `icp show`;
  and when all discovered prospects score below the fit threshold it says so.

### Added

- **`tam` — Total Addressable Market mapping.** Size the reachable market FROM
  the ICP, then iteratively fill it and track coverage to an ETA. `tam estimate`
  computes a transparent model (account universe × ACV = TAM, account/per-logo
  basis by default or `--acv-basis buyer`; contacts = accounts × buyers/account
  is the population target). The account count is `--accounts <n>` (assumption)
  or `--source explorium` — a live count of matching **companies** via Explorium
  `/v1/businesses`, which is the account universe directly. (Verified against the
  live APIs: people/lead endpoints can't size a market — Explorium `/v1/prospects`
  `total_results` equals the page size and pipe0/Crustdata returns only a cursor —
  so `--source pipe0` for estimate is rejected; pipe0 remains a discovery/
  population source. The businesses count omits `size`, which otherwise caps the
  total.) Explorium caps the count at 60,000; a saturated reading is surfaced as a
  floor (`provider:explorium (≥60k cap — floor)` + a warning to narrow the ICP).
  The model always labels `accountsSource` provider-vs-assumption. Optional citable
  cross-checks sit beside the bottom-up number. `tam populate --cron` schedules
  governed `enrich acquire --save` (plan-only; see below). `tam status --save`
  stamps a coverage timeline (CRM accounts-with-domain + contacts vs. the
  universe, `$ covered` proportional, what the campaign added since baseline);
  `tam report` renders a markdown burn-up. `status`/`report` project a linear
  accounts/day ETA and refuse to project (honest "not enough history") below two
  readings or a flat rate. Coverage + ETA are deterministic (no LLM). Library:
  `estimateTam`, `computeCoverage`, `projectEta`, `tamReportToMarkdown`, the
  store, and the count probe (`probeExploriumBusinessCount` +
  `EXPLORIUM_BUSINESS_COUNT_CAP`). See [docs/tam.md](./docs/tam.md).
- **Source connectors for `signals` (Phase 1).** `signals fetch` gains an
  additive, opt-in `--connector <id>[,<id>] [--connector-opt k=v …]` that pulls
  signals from connected platforms instead of only ATS boards and hand-staged
  `--from` files. Three connectors ship: `file` (local JSON/JSONL — also the
  webhook landing-zone spool, no auth), `serpapi-news` (funding/company news via
  a news REST API, key through the credential ladder), and `hubspot-forms`
  (first-party `demand` from recent form submissions, reusing the existing
  HubSpot login). Secrets resolve through the env → login → broker ladder, never
  argv; `--connector-opt` carries non-secret knobs only. **Default behavior is
  unchanged** when no `--connector` is passed. Connectors are read-only re: the
  CRM and run through the same evidence-gate/dedup/weight pipeline as `--from`
  (the `readStagedSignals` row validator is now the shared `stagedRowToSignal`).
  Library: `connectors/signalSources.ts` (`listSignalSources`, `getSignalSource`,
  `fileSource`, `serpapiNewsSource`, `hubspotFormsSource`), `stagedRowToSignal` +
  `StagedSignalRow` from `signals.ts`. Design:
  [docs/spec-connectors-signals-outbound.md](https://github.com/fullstackgtm/core/blob/main/docs/spec-connectors-signals-outbound.md)
  (the connector taxonomy + the Phase 2/3 webhook-spool and governed-channel plan).
- **Webhook spool format + conventional landing zone (signals Phase 2).**
  `--connector file` with no path now reads the conventional spool directory
  (`<profile home>/signals/spool`, via `signalsSpoolDir`) — every `*.jsonl` in
  it, name-sorted, so a webhook receiver can append one row per event (per
  source: `rb2b.jsonl`, `hubspot.jsonl`, …) and they all land in one fetch. The
  `file` connector reads a directory as well as a single file. New
  [docs/signal-spool-format.md](./docs/signal-spool-format.md) documents the row
  format, the landing zone, re-read/retention semantics, and per-platform
  payload mappings (RB2B, Trigify, HubSpot form webhook). Per the open-core
  boundary the format + reader are open; the always-on receiver is a hosted
  concern — the package ships no receiver. Also fixes a latent filter bug:
  explicitly-provided rows (`--from`, connectors) whose bucket has no configured
  `sources` (notably `demand`) were silently dropped unless `--bucket` was given;
  now only an explicit `--bucket` narrows them, so spool/`hubspot-forms` `demand`
  signals flow by default.
- **Outbox channel — governed send terminus (signals Phase 3).** `apply
  --channel outbox` renders each APPROVED drafted opener to a local outbox
  (`<profile home>/signals/outbox/<channel>.jsonl`, via `signalsOutboxDir`) for a
  downstream sender to drain — and **transmits nothing**, preserving the "drafts
  everything, transmits nothing" invariant (the send-side mirror of the spool).
  The outbox channel is a `GtmConnector` whose `applyOperation` renders instead
  of writing a CRM, so it reuses the entire governed apply path (approval set,
  integrity verification, idempotency, run recording) with no change to the apply
  engine; `apply` now takes `--provider <crm>` OR `--channel <id>`. It only
  renders `draft:`-policy `create_task` ops (any other op is skipped) and is
  idempotent on the operation id. New
  [docs/outbox-format.md](./docs/outbox-format.md). Per the open-core boundary the
  governed artifact + format are open; the always-on sender that actually
  transmits (ESP/LinkedIn) is a hosted concern — no sender ships in the package.
  Library: `connectors/outboxChannel.ts` (`createOutboxChannelConnector`,
  `createChannelConnector`, `listOutbox`, `OutboxEntry`), `signalsOutboxDir`.

### Changed

- **`enrich acquire --save` is now schedulable** (for `tam populate`). It joins
  the read/plan-side schedule allowlist in its plan-producing form ONLY — a
  scheduled `enrich acquire` must include `--save` (rejected otherwise), so each
  firing queues a `needs_approval` lead plan and writes nothing. The acquire
  meter is still charged only at apply, and apply stays a separate human gate
  (`apply --plan-id`, re-checked approved). Scheduling never auto-approves.

## [0.43.0] — 2026-06-25

### Added

- **`init` — scaffold a GTM workspace from cold scratch.** `fullstackgtm init
  [--source pipe0|explorium|linkedin] [--provider hubspot|salesforce]` writes
  three files so the first acquire/signals/judge/draft commands work: a valid
  starter `icp.json`, an acquire-ready `enrich.config.json` (the source preset
  plus an explicit `acquire.assign` seam, placeholder owner id, so leads are
  never silently ownerless), and a `PLAYBOOK.md` wired with the cold-start and
  outbound-loop recipes for this workspace's source/provider/profile. Pure
  file-writer: no network, keeps existing files unless `--force`. Library:
  `scaffoldWorkspace`, `starterIcp`, `starterEnrichConfig`, `starterPlaybook`.
- **`docs/recipes.md` — five composable GTM plays.** Documents how the governed
  primitives compose into real plays (cold-start lead-fill, the
  trigger→judge→draft outbound loop, scheduled-continuous, ABM-from-companies,
  hygiene-gated outbound) — making explicit that the CLI ships primitives, the
  coding agent is the orchestrator (no `outbound` mega-verb), and the package
  never sends. Surfaced from the agent skill and `llms.txt`, which also now
  carry the previously-undocumented GTM-brain layer (`signals`/`icp`/`judge`/
  `draft`) and the `init`/`enrich acquire` account-stamping behavior.
- **Account-level acquire for ABM (seam I).** `enrich acquire` creates net-new
  **accounts**, not just contacts: configure `acquire.create.company` (match key
  `domain`) and feed company rows (`enrich ingest companies.csv --objects
  companies`). Each unmatched company becomes a `create_record` of
  `objectType: account` with its domain stamped — so the acquired account is
  immediately signal-watchable. (The spine already routed by object type; this
  validates + documents the account path so it's discoverable.)
- **`health` breaks down by object type.** `HealthEntry.byObjectType` reports a
  separate record-normalized score (same 100/(1+weighted-per-record) curve) plus
  finding/record counts for `account`, `contact`, and `deal` — so "is my contact
  data clean but my pipeline messy?" is answerable from one audit, and `health`
  speaks each object type instead of a single aggregate. Rendered as a "By object
  type" table in `healthToMarkdown`.
- **Outbound is contact-granular end to end (seam D).** `icp judge` now surfaces
  `contacts` — all in-CRM contacts at the hot account (primary first, capped) —
  alongside the single `contact`, so an agent can multi-thread instead of being
  limited to one person. `signals outcome --contact <id>` records which contact a
  touch reached (`SignalOutcome.contactId`), so the feedback loop credits the
  person, not just the account domain.

### Changed

- **`call link` says HOW it matched (seam H); the findings split is documented
  (seam G).** `CallDealSuggestion` now carries `resolvedVia`
  (`account_domain` | `contact_email` | `both`) and `matchedContacts`, so an
  agent can weight a deal match by whether it came from the company-wide domain
  or a single (possibly stale) attendee email — and the contact↔account hop is
  visible, not just the resolved account. Separately, `PatchPlan.findings` (the
  complete, object-typed list) and `pipelineFindings` (the deliberately
  deal/sales-pipeline subset) are now documented so account/contact findings
  aren't mistaken for "dropped" — they live in `findings`.
- **`enrich acquire` now gives every lead a signal-watchable account (contact↔
  account seam).** Previously the presets wrote the company as a text field only,
  so an acquired lead had no account record — invisible to `signals`/`icp judge`,
  which key on account domain. Now acquire resolves-or-creates the lead's account
  **by domain**: `AcquireCreateMap.associateCompanyDomainFrom` (preset:
  `companyDomain`) threads the resolved domain — or the work-email's domain as a
  free fallback — onto `CreateRecordPayload.associateCompanyDomain`. The HubSpot
  and Salesforce connectors then match the account by domain first (the accurate
  key), create it **with** the domain (`domain` / `Website`), and fill the domain
  on a name-matched account that lacks one (fill-blank, never clobber). The dry-
  run op reason now names the account + domain instead of resolving it silently.

### Fixed

- **Outbound now writes against a real record, not a domain (contact↔account
  seam).** `draft` previously emitted a `create_task` op hardcoded to
  `objectType: "contact"` while carrying the account **domain** as `objectId` —
  an incoherent operation the apply layer had to re-interpret. The bridge is now
  explicit: `icp judge` resolves each decision's CRM target and surfaces it on
  `JudgeDecision` — `accountId` plus the best `contact` (`id`/`email`/`title`) at
  the account — whenever a snapshot source is given (`--provider`/`--input`/etc;
  `--with-history` still gates the memory + fit scoring inputs, so scores are
  unchanged). `draft` writes the task against `contact.id` (who to message), or
  the `accountId` when no contact resolves, and **rejects a domain-only decision**
  ("acquire it first") instead of forging a contact-typed op with a domain. The
  object-type coherence invariant — every op's `objectId` is a real id of its
  declared type — now holds for the outbound path.

## [0.42.0] — 2026-06-25

### Added

- **Bulk apply for lead creation (HubSpot + Salesforce).** `applyPatchPlan` now
  routes independent, approved `create_record` **contact** ops through a new
  optional connector capability, `applyCreateContactsBatch`, instead of two API
  round-trips per lead (a resolve-first search + a create). HubSpot batches the
  resolve-first via a `search` `IN` and creates via `batch/create` (100/call);
  Salesforce batches via a SOQL `IN` and the Composite sObject Collections API
  (`allOrNone: false`, 200/call). A batch rejection (e.g. a duplicate that the
  provider 4xxs the whole batch over) falls back to per-record `createRecord`, so
  one bad row never sinks the rest and resolve-first is preserved. Turns ~2N API
  calls into ~N/100; ops that aren't safe to batch (grouped, value-overridden,
  company-associated, conflicted, or non-create) stay on the serial path
  unchanged. Connectors without the capability are unaffected.

## [0.41.0] — 2026-06-23

### Added

- **Signal-based outbound: `signals`, `icp judge`/`icp eval`, `draft`.** A timing
  layer on top of CRM hygiene — reach an account the week something changes, not
  from a rented list. `signals fetch/list/outcome/weights` captures buying
  triggers into a local, profile-scoped ledger (Detect-side — it writes nothing
  to the CRM), sorted into five weighted buckets
  (`demand`/`funding`/`job`/`company`/`social`); public ATS boards (Greenhouse,
  Lever, Ashby) are the free, no-auth source in the box, while
  funding/company/social arrive via staged ingest and `demand` is reserved for a
  privileged source. A reposted role outweighs a first-time post, and recorded
  outcomes (`signals outcome`) re-weight which buckets earn a touch. `icp judge`
  scores each account on timing × fit × memory into `send`/`nurture`/`skip` —
  every *why-now* must quote a real trigger verbatim (the same evidence gate as
  `call`/`market`), with a deterministic baseline when no LLM key is set.
  `icp eval` grades the judge against a golden set (and hot-vs-cold outcomes),
  exiting `2` below the bar — the calibration gate that blocks a miscalibrated
  judge from a live send. `draft` writes one trigger-grounded opener per hot
  account as a governed `create_task` plan through the existing approve → apply
  gate; it has no send capability and adds none. All four are read/plan-side and
  schedulable; none can auto-apply or send.
- **LLM base-URL override.** `ANTHROPIC_API_BASE_URL` / `OPENAI_API_BASE_URL` let
  every LLM feature run against an Anthropic/OpenAI-compatible endpoint (e.g. a
  GLM/z.ai endpoint or a local Ollama) with no code change; unset preserves the
  default endpoints.

### Changed

- **pipe0 resolution runs chunks in parallel (bounded) with exponential backoff.**
  `pipe0ResolveWorkEmails` and `pipe0ResolveCompanyDomains` previously issued one
  serial HTTP call per chunk — a few hundred leads took tens of minutes. They now
  run up to `concurrency` chunks at once (default 3) with exponential backoff on
  transient failures (throttle/5xx/network: 500ms → 4s, up to 5 attempts). Bounded
  concurrency + real backoff cuts wall-clock several-fold while keeping coverage:
  an early concurrency-6 + single-retry build throttled pipe0 at scale and dropped
  the work-email hit-rate from ~79% to ~17%, so the pairing matters. Chunk size
  stays small (the waterfall's batch failure is all-or-nothing).

## [0.40.0] — 2026-06-23

### Added

- **Salesforce reaches full parity with HubSpot.** `create_record` — the
  `enrich acquire` net-new-lead path — is now implemented for Salesforce: it
  resolve-firsts (SOQL search on the mapped match key, create only on a confirmed
  miss), stamps the canonical `ownerId` onto `OwnerId` so a lead is never born
  ownerless, and optionally resolve-or-creates and links the associated account.
  With this, **every write operation works across both providers** — `set_field`,
  `clear_field`, `link_record`, `create_task`, `archive_record`, `merge_records`
  (Salesforce: Account/Contact), and `create_record` (Salesforce: contact/account).
  HubSpot and Salesforce are now equally first-class; the audit → plan → apply
  contract is identical across them. Verified end-to-end against a live Salesforce
  org (create-on-miss, company auto-link, in-run dedup, cross-run resolve-first).

### Fixed

- **HubSpot date-field writes no longer false-conflict.** `readField` now
  normalizes `closeDate` the same way `fetchSnapshot` does (`split("T")[0]`), so
  compare-and-set stops seeing spurious drift between the date-only value baked
  into the plan and HubSpot's raw `…T00:00:00Z` read-back. Previously, every
  date-field `set_field` on HubSpot dead-ended in a false `conflict`. (Salesforce
  was already correct here.)

### Documentation

- Corrected `docs/api.md`: the Salesforce connector implements the full operation
  set, with its two platform constraints (Account/Contact-only merge, resolve-first
  contact/account create) — replacing a stale "Salesforce skips merge/create" note.
- Documented the quickest Salesforce token path for one-off / sandbox use via the
  `sf` CLI (`sf org display --verbose --json`), including the short-lived-token
  caveat; durable use still wants the Connected App device flow.

## [0.39.0] — 2026-06-23

### Added

- **LinkedIn acquire: configurable + email-resolving.** `linkedin` is now a
  first-class `SUPPORTED_API_SOURCES` entry, so an explicit `enrich.config.json`
  can drive it (set discovery `size` to read a whole list, not the preset's 25).
  Email resolution is no longer gated on the dedupe key being `email`: any source
  can opt in with `acquire.discovery.<src>.resolveEmailsWith: "pipe0"`, so a
  LinkedIn source (which keys on the profile URL) can still resolve real work
  emails (name + company → pipe0 waterfall) and create outreach-ready contacts.
- **Company-domain resolution for email enrichment** (`pipe0ResolveCompanyDomains`,
  `hostFromUrl`). The work-email waterfall requires a company domain, but a
  LinkedIn/HeyReach list supplies only company names — so the email step now
  first resolves each unique company's domain via pipe0 `company:identity@1`
  (name → website → bare host) before the waterfall. Unresolved companies are
  left untouched (never a guessed domain), and the lookup is deduped per company.

### Changed

- **ICP scoring reads the LinkedIn headline, not just the formal title.**
  `scoreProspectAgainstIcp` now matches title keywords across `jobTitle` *and*
  `headline`. On LinkedIn-sourced prospects the role signal often lives only in
  the headline (position "Founder", headline "… | RevOps | …"), which scoring on
  the title alone would miss. `Prospect` gains a `headline` field.

## [0.38.1] — 2026-06-23

### Fixed

- **`enrich acquire` LinkedIn creates failed with HubSpot 400.** The resolve-first
  search before a `create_record` filtered on the *canonical* match key
  (`linkedin`) instead of the HubSpot property name (`hs_linkedin_url`); HubSpot
  400s on a filter against a property it doesn't have, so every LinkedIn-sourced
  lead failed at apply. The connector now translates the match key through
  `HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts` before searching (email is unaffected
  — its canonical name already equals the property name). Regression test added.

## [0.38.0] — 2026-06-23

### Added

- **CLI run observability — paired CLIs report each run to the hosted dashboard.**
  When the CLI is paired (`login --via <hosted url>`), a best-effort run record —
  command, status (`success`/`partial`/`error`), duration, headline counts, and
  structured events (plan saved, meter charged) — is POSTed to the deployment's
  run timeline after each command (`runReport.ts`: `reportCounts` / `reportEvent`
  / `flushRunReport`). Opt-in by pairing (an unpaired CLI sends nothing), 4s-capped,
  swallows every error, and never affects the command's exit code; setup/inspection
  verbs (`login`, `doctor`, `help`, `--version`) are skipped. The hosted dashboard
  re-maps onto these runs (`/dashboard/runs`).

- **Lead assignment — acquired leads are never born ownerless.** A shared
  `AssignmentPolicy` (`assign.ts`: `fixed` / `round-robin` / `territory` /
  `account-owner`) routes an owner onto every record, consumed in two places:
  - **`enrich acquire`** stamps the resolved owner into each `create_record`
    payload (`EnrichConfig.acquire.assign`); the HubSpot connector maps it to
    `hubspot_owner_id` at create time. Round-robin distributes by the within-run
    index (deterministic, no persisted cursor); every result is gated by the
    snapshot's active owners, so an unknown/inactive owner collapses to
    unassigned rather than writing a bad owner. The CLI defaults to the portal's
    sole active owner when no policy is set (or `--assign-owner <id>`), and warns
    + leaves leads unassigned when several owners exist and no policy says how to
    route. `AcquireCounts` now reports `assigned` / `unassigned`.
  - **`reassign --assign-unowned --to <ownerId>`** claims every existing
    ownerless record (`ownerId:empty`) for an owner — the backfill twin of
    acquire's create-time assignment.

- **`enrich acquire --source linkedin` — governed LinkedIn lead acquisition
  (Phase 1, discovery + dry-run).** LinkedIn is a new discovery source on the
  existing acquire spine: it reads a pre-built **HeyReach** lead list
  (`--list <id>` or `acquire.discovery.linkedin.listId`), normalizes leads to
  the canonical `Prospect` type, then reuses ICP scoring, pre-email dedup, the
  acquire meter, and the dry-run → approve → apply gate unchanged. The LinkedIn
  profile URL is the match key; cost is `$0`/record (the list is already built).
  - **`LinkedInProvider`** interface (`connectors/linkedin.ts`) with a default
    **HeyReach** adapter (`HEYREACH_BASE`, `X-API-KEY`) and a
    `FakeLinkedInProvider` so the whole pipeline runs with no key and no network.
    `createLinkedInProvider` rejects unknown providers (`heyreach` only for now;
    `unipile` is the planned alternative behind the same interface).
  - Auth: `login heyreach` or `HEYREACH_API_KEY`.
  - **Read-only / no sending.** Phase 1 is discovery only — no
    `linkedin_connect` / `linkedin_message` operations, no webhook ingestion
    (Phase 2). Without `--save` nothing is written and there is zero send/ToS
    exposure.

## [0.37.0] — 2026-06-19

### Added

- **`enrich acquire` — net-new, ICP-targeted, deduped, metered lead generation
  into the CRM.** Where `enrich append/refresh` fill blanks on records that
  already exist, `acquire` discovers net-new people, resolves their work email,
  and proposes governed `create_record` operations through the existing
  dry-run → approve → apply gate. Never auto-writes.
  - **`create_record` operation** + resolve-first contact creation in the
    HubSpot connector (re-checks the dedupe key at apply, never double-creates).
  - **Acquire meter** (`acquireMeter.ts`): per-profile windowed budget capping
    both record count and provider spend (per-day + per-month, whichever binds
    first); charged only for creates that land at apply.
  - **ICP artifact** (`icp.ts`) + **`icp interview` / `icp set` / `icp show`**:
    one profile drives per-provider discovery filters (Explorium + pipe0/Crustdata)
    AND fit-scores every prospect — only above-threshold leads are proposed.
    `icp interview` emits a question spec an agent drives with AskUserQuestion.
  - **API prospect sources** (`connectors/prospectSources.ts`): Explorium
    discovery, pipe0 work-email waterfall (chunked, surfaces upstream errors),
    and pipe0/Crustdata people search.
  - **No paying for dupes**: pre-email dedup against the live CRM snapshot +
    a cross-run **seen cache** (`acquireSeen.ts`) drop already-known prospects
    *before* the paid email step. **LinkedIn URL (`hs_linkedin_url`) is now read
    into the snapshot** as the strong dedup key (safe everywhere — HubSpot
    ignores unknown properties); created contacts write it back, so dedup
    strengthens over time. A recommendation fires when the CRM has none.
  - **Zero-config preset**: `enrich acquire` works with only an `icp.json` and
    `login` — sensible defaults for budget, provider, and create-mapping.
  - **`login pipe0` / `login explorium`** credential flow.

### Also

- Built-in **clay enrich preset** + `enrich ingest <csv> --source clay --input`
  one-shot (stage → match in one command).

## [0.36.0] — 2026-06-19

### Added

- **Engagement workspace — a per-client CRM health timeline.** The profile dir
  (`$FSGTM_HOME[/profiles/<name>]`) becomes a continuous record, not just a place
  for credentials and plans: every `audit --save` now stamps a deterministic
  hygiene score and a snapshot onto the profile, so a consultant working
  `--profile <client>` accrues that org's health over time from the verb they
  already run.
  - **`fullstackgtm health [--json]`** (new, read-only) rolls up the timeline:
    current score, the change since the last audit, a dated trend, and per-rule
    finding deltas. Empty timeline prints a pointer, never an error.
  - **Deterministic score** = `100 / (1 + severity-weighted findings per record)`
    (info ×1, warning ×3, critical ×10): 0 findings ⇒ 100; the same findings over
    fewer clean records score lower. No LLM — stable in CI, comparable run-over-run.
  - New library exports `computeHealth`, `summarizeHealth`, `healthToMarkdown`
    and the `HealthEntry` / `HealthRollup` / `HealthRuleDelta` types.
  - State is profile-scoped and owner-only (0600): `health.jsonl` (append-only)
    and `snapshots/<planId>.json`, alongside `plans/` under the same secured dir.

## [0.35.0] — 2026-06-19

### Added

- **Progressive-disclosure help.** The front door is now a lifecycle-grouped map
  (Setup · Detect · Prevent · Remediate · Calls · Govern · Market · Schedule) of
  ~one line per verb instead of a 194-line wall — bare invoke and `--help` print
  it. `<verb> --help` gives focused per-command help (summary, synopsis, key
  options, the verb's lifecycle phase, see-also) rather than the whole surface.
  New `help [command] [--full]` command; `--full` always escapes to the complete
  reference. `call`/`market`/`enrich`/`bulk-update`/`schedule` keep their own
  richer help.
- **`audit` next-step guidance.** After a human-readable audit, the CLI prints a
  context-aware next step on stderr (so stdout stays clean for pipes/`--out`):
  the demo points to `report --demo` and `login`; a saved live audit chains
  `suggest → plans approve → apply` with the real plan id; a clean snapshot
  points to `resolve`/`schedule`. Suppressed under `--json`.
- **`audit --full`** and **`patchPlanToMarkdown(plan, { summary })`** — a summary
  view (header + Findings-by-Rule table + operation count) for read-side audits.

### Changed

- **`audit` defaults to the summary view** (≈24 lines on the demo vs ≈1,470
  before); `--full` opts into the per-operation dump. The default stays full for
  write-preview renders (`bulk-update`, `fix`, `dedupe`, `plans show`, MCP), where
  you approve specific operations and want every operation's detail. The `--json`
  machine output is unchanged.
- **Plan footer reframed** from "This prototype is dry-run only…" to the actual
  safety invariants ("Dry-run plan — read-only. No provider write happens until
  you approve specific operations and run `apply`… These safety invariants are
  not beta."), matching the README and agent skill.

See [docs/dx-punch-list.md](https://github.com/fullstackgtm/core/blob/main/docs/dx-punch-list.md) for the audit that drove this.

## [0.34.0] — 2026-06-18

### Added

- **`discoverCompetitors(category, { llm, anchorUrl?, exclude? })`** — propose the
  real vendor set for a category via the LLM (BYOK through `forcedToolCall`), so a
  cold-start map needs only a category. Returns canonical homepages + a
  category-specific `productUrl` per vendor; excludes the anchor and supplied hosts,
  de-dupes by registrable domain, and instructs the model to skip acquired/defunct
  brands. Pairs with `findCategoryPage` / `detectDrift` / `fetchLogoDataUri` (0.33).

## [0.33.0] — 2026-06-18

### Added

- **Market sourcing helpers (`marketSourcing.ts`)** — find the right page to
  capture per vendor, detect acquired/redirected vendors, and extract brand logos,
  with zero coupling to any transport:
  - `pickCategoryPage(html, baseUrl, keywords)` — follow a vendor's own nav to its
    category page (so multi-product companies like SAP/Salesforce are captured on
    the product page, not the corporate homepage). Pure.
  - `findCategoryPageInSitemap(rootUrl, keywords, fetchText?)` — sitemap fallback
    for JS-mega-menu sites whose product links aren't in the rendered homepage.
  - `findCategoryPage(...)` — nav-scan then sitemap, combined.
  - `detectDrift(url, srcHost, resolve?)` / `resolveFinalUrl(url)` — skip vendors
    whose site redirects to a different company (an acquired/defunct product).
  - `extractLogoUrl(html, baseUrl)` + `fetchLogoDataUri(homepageUrl, html?, …)` —
    a vendor logo as a self-contained `data:` URI for `MarketVendor.logo`.
  - `categoryKeywords()` + `registrableDomain()` utilities.

  Pure functions operate on already-fetched HTML; fetching helpers default to the
  package's SSRF-guarded `assertPublicUrl` + `fetch` but accept an injectable
  fetcher (testable offline, browser-render-friendly). 8 tests.

## [0.32.0] — 2026-06-18

### Added

- **Brand logos plot inside the market-map scatter bubbles.** When a vendor has
  a `data:image/…` logo and its dot is big enough to read it (r ≥ 12), the logo
  becomes the in-bubble label: a white disc clipped to the circle carries the
  logo, a colored rim still ties the dot to its legend color, and the legend
  number moves just above so the cross-reference holds. Smaller or logo-less
  dots keep the numbered-bubble treatment. Same `img-src data:` safety as the
  legend/header logos — only `data:` URIs are honored; anything else is refused
  and never emitted as an `<image>`. Render stays byte-deterministic.

- **Call-type classification + type-specific coaching rubrics.** New `call
  classify` verb runs a deterministic, key-free signal classifier over a
  transcript (12 call types: prospecting, discovery, demo, technical_validation,
  negotiation, closing, onboarding, check_in, renewal_expansion, qbr, internal,
  other), returning the type with a confidence and a written reason; `--llm`
  adds a model tiebreak for the ambiguous middle, `--list` prints the taxonomy.
  `call score` now **auto-selects the type-specific rubric** from that
  classification instead of applying one generic discovery rubric to every call
  — override with `--call-type <type>` or `--rubric`. The `Rubric` type gains
  optional `name`, `callType`, `bands`, and per-dimension `anchorsHigh` /
  `anchorsLow` / `evidenceCues` / `coachingPrompts`; anchored examples are
  threaded into the scoring prompt (cuts variance) and the weighted overall is
  mapped to a qualitative band, all computed client-side. Ten built-in presets
  (`call score --list-rubrics`). New exports: `classifyCall`, `classifyCallLlm`,
  `rubricForCallType`, `rubricPresets`, `bandForScore`, `CALL_TYPES`,
  `CALL_TYPE_IDS`, `BANDS_5`, and the `CallType` / `CallTypeDef` /
  `CallClassification` / `RubricDimension` / `ScoreBand` types.

## [0.31.0] — 2026-06-18

### Added

- **Vendor logos in the market-map report.** `MarketVendor` gains an optional
  `logo` field; `marketMapToHtml` renders it beside the name in the legend and
  above the matrix column headers, degrading to the numbered swatch / plain name
  when absent. Only `data:image/…` URIs are honored — keeping the report
  self-contained (no external requests, survives being saved or emailed) and safe
  under a strict `img-src data:` CSP. The hosted service extracts a canonical logo
  from each vendor's homepage; CLI users can set `logo` by hand.

## [0.30.0] — 2026-06-17

Connector fixes — the two concrete defects a real HubSpot/Salesforce shop hits.

### Added

- **Salesforce `dedupe`/`merge_records` now works** (Accounts and Contacts) via
  the SOAP `merge()` call — REST has no merge resource, but the OAuth token
  doubles as the SOAP session id, so no extra auth. Groups larger than three are
  merged in batches (master + 2 per call); failures are reported honestly with
  what merged before the stop. **Opportunities remain unmergeable** (Salesforce
  exposes no opportunity merge anywhere) and are refused with that explanation.
  Merges still flow through the approval gate and the irreversible-op drift guard
  (the survivor/loser existence check runs before the SOAP call). Exercised by
  unit tests; validate against a sandbox before wiring into automation.

### Fixed

- **HubSpot closed/won detection is now pipeline-aware.** `isClosed`/`isWon`
  were derived by substring-matching the stage against `closedwon`/`closedlost`,
  so custom pipelines (opaque stage ids) read every deal as open and flooded
  stale-deal / past-close findings with false positives. The connector now reads
  the pipeline stage metadata (`/crm/v3/pipelines/deals`: `isClosed` +
  `probability`) once per snapshot and derives closed/won from that, falling back
  to the substring heuristic only when the pipelines read is unavailable.

## [0.29.0] — 2026-06-16

### Added

- **`suggestMarketConfig` and its taxonomy types (`SeedVendor`,
  `SuggestTaxonomyOptions`, `SuggestTaxonomyResult`) are now exported from the
  package root.** The cold-start claim-taxonomy bootstrap behind `market init
  --auto` (shipped in 0.26.0) is now usable as a library API, not just the CLI —
  a consumer can run it with an injected `fetchPage` (e.g. a browser-rendered
  capture) and compose it with the already-exported `captureMarket` /
  `classifyMarket` / `marketMapToHtml`. No behaviour change to the CLI.

## [0.28.3] — 2026-06-16

Fix broken links in the published mirror. CONTRIBUTING.md and CLAUDE.md
referenced `../../docs/open-core-boundary.md` — a monorepo-root path that
escapes the repo on the mirror (where the package is the repo root) and targets
a doc the mirror doesn't carry. Made those references self-contained (the
open-core model and release ritual are explained inline). A full sweep confirms
every relative link in the shipped docs now resolves within the package/mirror.

## [0.28.2] — 2026-06-16

Collaborator/co-maintainer onboarding (from a readiness review). No runtime
code changes; one dev-ergonomics fix.

### Fixed

- **Package-local `npm test` no longer silently passes with zero tests.** A
  `pretest` guard fails with a pointer to run package tests from the monorepo
  root (the tests live there; the package-local script is meaningful only on the
  published mirror). Previously a maintainer could change code, run the package's
  test command, see green, and ship a regression.

### Added

- **CONTRIBUTING.md at the package root** (the README link previously 404'd in
  the source repo — it existed only in the mirror-staging dir). Covers dev setup,
  the test-from-root rule, the open-core mirror topology, the release ritual, and
  the access a co-maintainer needs to cut a release.
- **docs/architecture.md** — module map + snapshot → audit → plan → apply data
  flow + "where do I add a rule / connector / operation".
- A package-scoped **CLAUDE.md** so an agent/maintainer isn't pointed at the
  hosted app's Convex stack.

### Changed

- README benchmark line reconciled with RESULTS.md (1,088-run, six models);
  roadmap-to-1.0 shipped-layers list extended through 0.28.

## [0.28.1] — 2026-06-16

Company-of-record correction: the legal entity is **Full Stack GTM LLC** and the
contact/disclosure address is **ryan@fullstackgtm.com** (package.json author,
NOTICE copyright, SECURITY.md, DATA-FLOWS.md). No code changes.

## [0.28.0] — 2026-06-16

Connectors, credentials & supply chain — the last of the hardening train.
Each security change was re-attacked; the keychain and supply-chain gates each
took two rounds (the re-attack found the stale-plaintext-on-migration gap and
the orphan-dist gap that round 1 left open).

### Added

- **Opt-in OS-keychain credential storage** (`FSGTM_KEYCHAIN=1`). The credential
  blob is stored in the macOS Keychain (`security`) or Linux libsecret
  (`secret-tool`) instead of a 0600 file — no native dependency. Enabling it on
  an existing install migrates `credentials.json` into the keychain and removes
  the plaintext file. Default (unset) is unchanged: the 0600 file. macOS caveat
  (transient argv exposure during the keychain write) documented in SECURITY.md.

### Security

- **Broker URL must be https.** `login --via` and the token-mint path refuse a
  cleartext/non-https broker (localhost dev excepted), and the device
  verification URL is only auto-opened when it shares the `--via` origin — so a
  long-lived pairing bearer and minted live-CRM tokens can't go over cleartext
  or to an attacker-redirected URL.
- **Supply-chain: published dist is provably from source.** `npm run build` now
  cleans first; release rebuilds from source and refuses to publish if the
  committed `dist/` doesn't match (catching a poisoned or *orphaned* dist file),
  and a CI `dist-integrity` job enforces the same on every push — protecting
  `npm install github:` consumers who run the committed dist unbuilt.
- npx peer resolution from the current directory is now logged (running the MCP
  server in an untrusted directory could otherwise silently load a peer from it).

### Changed

- **Salesforce merge is documented as unsupported**, with a connector
  capability matrix in the README — no REST merge exists (SOAP/Apex only), so
  `merge_records` is refused honestly; deduplicate in the UI or archive the
  non-survivors. No silent half-merge, no demo surprise.

## [0.27.0] — 2026-06-16

Trust, compliance & transparency — the artifacts a skeptical buyer's security
and procurement review asks for, plus an exportable audit trail and two
content-grounding fixes. Security-relevant additions were re-attacked before
release (the audit-log signing and the transcript gate each took two rounds).

### Added

- **`audit-log export` / `audit-log verify`** — a tamper-evident record of every
  apply run, flattened across all plans into a hash chain, with the head
  HMAC-signed by the per-install key. Exports are always signed; `verify`
  recomputes the chain and refuses an edited, reordered, truncated, or
  signature-stripped log (and reports it as unverifiable on a machine without
  the key). The change-management/SIEM artifact the prior audit flagged as
  missing.
- **`SECURITY.md`** — disclosure address (security@fullstackgtm.com) and the
  full trust model (credential custody, approval gating, approval-integrity
  signing, scheduling, untrusted-input handling, auditability).
- **`DATA-FLOWS.md`** — exactly what data leaves the machine, to which endpoint,
  for which command, and under whose account; the "CLI is BYO-key, no
  vendor data path, no sub-processors" statement procurement needs; and how to
  run the whole loop with zero third-party calls.
- **Company-of-record** — `package.json` author and a `NOTICE` file now name
  Full Stack GTM with a contact; LICENSE unchanged (Apache-2.0).

### Security

- **Call-transcript insight grounding.** LLM-extracted call insights are now
  mechanically verified: the evidence quote must be a non-trivial verbatim span
  of the transcript, and for `next_step` (the only insight whose text is written
  to the CRM) the written action itself must be grounded in that quote — every
  number/amount must appear in the quote, and the action's distinctive terms
  must overlap it. This closes the prompt-injection path where a transcript
  fabricates a malicious next step accompanied by an innocuous real quote. (This
  is defense-in-depth on a human-approved path; a determined paraphrase-style
  injection still surfaces to the approver as the proposed value.)

### Changed

- README now states the design as **deterministic apply, governed suggest** and
  cites the current 1,020-run / five-model benchmark (was a stale 612-run line);
  a CI guard fails if the documented synthetic-scenario count drifts from the
  code.

## [0.26.0] — 2026-06-15

Write-path integrity — the "no write without approval" guarantee now binds to
operation *content*, and the two irreversible operations finally get a guard.
Each fix verified by a refute-by-default re-attack; the integrity binding took
three rounds (the re-attack kept finding unsigned fields that reach a write).

### Added

- **Plan-approval integrity signatures.** `plans approve` now HMAC-signs each
  approved operation's full apply-relevant content (operation, object, field,
  before/after value, group, preconditions, force flags, the approved value
  override, and reason) with a per-install key (`$FSGTM_HOME/.plan-signing-key`,
  0600). `apply --plan-id` re-verifies and refuses the whole apply if any
  approved operation changed since approval, if the plan was approved without
  signatures (downgrade guard), or if the signing key is absent (a plan
  approved on another machine fails closed). The invariant: **what gets written
  equals what the human signed** — a plan file edited between approval and apply
  (by a synced/backed-up copy, a co-tenant, or a compromised dependency) is
  caught instead of executed. apply-time `--value` is folded into the check, and
  a scheduled `apply` may not take `--value` (it must write exactly the signed
  values).
- **Recovery snapshots on irreversible operations.** `dedupe` merge ops and
  `bulk-update --archive` ops now carry `recoverySnapshot` — the field values of
  every record that will be destroyed — so the rollback instruction ("recreate
  it by hand") is backed by actual data in the plan, which is the backup.

### Security

- **Apply-time guard against destroying duplicates (the benchmark self-own).**
  `apply` now refuses any `archive_record` whose target still shares an identity
  key (account domain / contact email) with another live record — unless the
  human explicitly forced it (`--force-archive-duplicates`, which is recorded on
  the operation and signed). This catches every path (agent-driven, hand-edited,
  audit), not just `bulk-update`, so an agent on a dedupe task can no longer
  silently archive a record where it should merge — the rail is safe regardless
  of model strength.
- **Drift guard for irreversible operations.** `merge_records` and
  `archive_record` got no compare-and-set (there is no single field to compare).
  Apply now checks a fresh snapshot: a merge whose survivor is gone, or whose
  duplicates are already merged, and an archive of a record that no longer
  exists, all conflict out instead of firing an irreversible, replay-unsafe write.

### Notes

- The CAS empty/null equivalence in field compare-and-set is intentional (CRMs
  normalize `""`↔`null` server-side; distinguishing them would cause false
  conflicts). Known residuals for a follow-up: the archive-duplicate guard keys
  on domain/email only, so `dedupe --key name` (and deal dedupe, which has no
  identity key) are not guarded against destructive archive — use `dedupe`
  (merge) for those; and `marketMapToMarkdown` is not HTML-escaped (the HTML
  report is).

## [0.25.2] — 2026-06-15

Security hardening I — confirmed fixes from an adversarial audit (each verified
by a refute-by-default re-attack; the crontab and report fixes took three
rounds because the re-attack kept finding deeper paths).

### Security

- **Crontab injection via `schedule install` (was: arbitrary code execution).**
  `schedule add --label` rejects newlines/control chars; `renderManagedBlock`
  now refuses to render any entry (or CLI invocation) whose interpolated
  fields — label, cron, id, profile, argv, **and the resolved node/script
  path + `FSGTM_HOME`** — carry a control character, so a hand-edited
  `schedules.json` or a newline in `FSGTM_HOME` can no longer inject a live
  crontab line. `parseCron` now accepts ASCII space/tab only (rejects Unicode
  whitespace), and a stray `%` in a path is escaped (`\%`) so it can't truncate
  the managed line.
- **SSRF in `market capture`.** Page fetches now allow only http/https, refuse
  any host that is or resolves to a private/loopback/link-local/CGNAT/metadata
  address (IPv4, IPv6, and IPv4-mapped IPv6 in dotted or hex form), follow
  redirects manually with per-hop re-validation, and cap time/body size.
- **Stored XSS in the market HTML report.** The embedded JSON data island is
  serialized with `<`/`>`/`&`/U+2028/U+2029 escaped (no `</script>` breakout),
  the tooltip is built with `textContent` (no `innerHTML`), and the two
  remaining raw sinks (anchor vendor name, evidence-appendix confidence) are
  now `escapeHtml`'d; `validateObservationSet` rejects a non-enum `confidence`
  so an `observe --from` file can't smuggle markup.
- **Provider response bodies no longer leak into errors.** HubSpot, Salesforce,
  Apollo, and Stripe connectors throw status-line-only errors (a 4xx body can
  echo submitted emails/domains or the key, and these errors are persisted into
  scheduled-run records).
- **CSV/formula injection neutralized at the enrich write path.** Ingested
  string values beginning with `= + - @` / tab / CR are prefixed with `'` so
  they can't execute if the CRM is later exported to a spreadsheet; numeric
  values keep full fidelity.
- **Credential-store mode enforced on read, not just write.** A pre-existing
  `credentials.json` with group/other permissions is re-tightened to 0600 (and
  warned) on read, closing the inherited-loose-permissions gap.

Known residuals tracked for follow-up: `marketMapToMarkdown` does not
HTML-escape (safe in terminals/GitHub; only a risk if a downstream renderer
trusts raw HTML — to be addressed with the report work); the credential read
check is reactive (a loose file is exposed until the next CLI read).

## [0.25.1] — 2026-06-12

Docs-sync release — no code changes.

### Fixed

- README, INSTALL_FOR_AGENTS.md, the agent skill, and docs/api.md corrected
  against the shipped surface: the MCP tool list now enumerates all 8 tools
  (read-only vs gated), the builtin rule count is 12, docs/api.md gains a
  Schedule section and the `schedule` command in its CLI list, the README
  cites the 612-run CRM-ops benchmark and the `diff --fail-on-new-findings`
  CI gate, the bulk-update section covers `!~` / `--create-task` /
  `--force-archive-duplicates`, and the skill's verb map completes the
  `schedule`, `market`, and `plans` rows and adds `report`.
- The 0.23.0 entry below is amended retroactively: `dedupe`, `reassign`,
  `fix`, and `--set <field>=from:<sourceField>` shipped in 0.23.0 without a
  changelog record.

## [0.25.0] — 2026-06-12

### Added

- **Agent skill distribution** — `npx skills add fullstackgtm/core` installs
  [skills/fullstackgtm/SKILL.md](./skills/fullstackgtm/SKILL.md) into any
  skills-compatible agent (Claude Code, Cursor, Codex, …): a compact operating
  guide covering the governed audit → suggest → approve → apply loop, the
  non-negotiable safety invariants, the verb map, and the credential ladder.
  Documentation only — no runtime surface changes.

## [0.24.0] — 2026-06-12

### Added

- **The schedule layer (MVP)** — the horizontal scheduler (spec:
  docs/schedule.md in the monorepo): declare once that a CLI command should
  run on a cadence, materialize the timers through a provider, and keep an
  append-only run history. No feature namespace owns cron logic.
  - The governance invariant: **scheduling never auto-approves.** The
    schedulable allowlist is read/plan-side only (`audit`, `snapshot`,
    `enrich append|refresh`, `market capture|refresh`, `suggest`, `report`,
    `doctor`) — unattended runs accumulate proposals, never CRM writes.
    `apply` is schedulable ONLY as `apply --plan-id <id>`, and every firing
    re-checks the plan's status is `approved`: an unapproved plan records a
    `plan_not_approved` no-op run instead of executing, with no relaxing
    flag. Argv must resolve to a known fullstackgtm command — validated at
    `add` time AND re-checked at run time; arbitrary shell is not
    schedulable (execution dispatches in-process, never through a shell).
  - `schedule add "<command>" --cron "<expr>" [--label <name>]
    [--provider local]` — allowlist + cron validation, then a declarative
    entry in `~/.fullstackgtm/profiles/<profile>/schedules.json`; nothing
    touches the crontab until `install` (the plan/apply split: declare,
    then deliberately activate). Plus `list`, `remove`, `enable|disable`.
  - `schedule run <id>` — the single entry point every provider's timer
    calls (and a human can call: `trigger: manual` vs `cron`). Executes the
    command in-process, records exit code, ~50-line output tail, and
    artifacts (plan ids / enrich run labels, attributed by store diff)
    under `<profile>/schedule/runs/<id>/`, and propagates the exit code.
  - `schedule install|uninstall [--provider local]` — renders enabled
    entries into a sentinel-delimited managed crontab block
    (`# >>> fullstackgtm <profile> >>>` … `# <<< fullstackgtm <profile> <<<`);
    re-install replaces the block wholesale and never touches lines outside
    the sentinels; uninstall removes only the block. Crontab access is an
    injected seam (`CrontabIo`) — tests never read or write a real crontab.
    Providers beyond `local` (`modal`, `aws`) are refused as "not yet
    implemented"; they arrive later as scaffold generators calling the same
    `schedule run <id>` contract.
  - `schedule status [<id>] [--runs <n>]` — next firing per the cron
    expression, last run + success/failure streak + artifacts, and missed
    firings (expected-vs-actual since the last run record; visibility only,
    no catch-up — local cron skips silently when the laptop sleeps).
  - Minimal dependency-free 5-field cron parser: `*`, lists, ranges, steps,
    day-of-week 7=Sunday, vixie day-of-month/day-of-week OR semantics;
    clear validation errors at `add` time (including expressions that never
    fire), next-firing computation for `status`.

## [0.23.2] — 2026-06-12

Documentation catch-up: the README, llms.txt, and docs/api.md now cover
everything that shipped 0.19–0.23. (No code changes.)

### Fixed

- README: new "Routine maintenance as governed verbs" section (`bulk-update`,
  `dedupe`, `reassign`, `fix`) and a market-map paragraph for `market overlay`
  (directives from your own ground truth) and `market scale` (citable,
  calibrated size estimates).
- llms.txt: governed-write-verbs invariants block; overlay/scale invariants
  added to the market-map block.
- docs/api.md: CLI command list completed (write verbs, `enrich`, market
  `overlay`/`scale`); new "Governed write verbs" and "Enrich" export
  sections; market-map section updated for 0.16–0.23 exports incl.
  `computeDirectives`/`directivesToPlan` and `computeScaleIndex`.

## [0.23.1] — 2026-06-12

### Fixed

- **Literal `${vendorHeads}` leaked into expanded claim-group tables** — a
  templating slip in the 0.22.0 narrative restructure left the vendor header
  row unrendered (and masked a use-before-declaration). Fixed, plus a
  regression guard: the HTML must contain no unrendered `${` placeholders
  and expanded groups must carry real vendor headers.
- Claims section heading renamed to "Market Claims".

## [0.23.0] — 2026-06-12

### Added

- **The enrich layer (MVP)** — governed append/refresh of third-party data
  into the CRM (spec: docs/enrich.md in the monorepo). Where every enrichment
  vendor ships fire-and-forget writeback, enrich emits a diff you approve:
  source data → deterministic matcher → fill-blanks patch plan → the
  existing plans approve → apply chain, with the source payload stored as
  `GtmEvidence` on the plan and `beforeValue` set on every operation for
  apply-time compare-and-set.
  - `enrich append [--source <id>] [--objects companies,contacts] [--save] [--config <path>]`
    — pull (Apollo) or read staged ingest data (Clay), match via ordered
    keys (unique-hit-wins, zero-hits-next-key, multi-hit → `onAmbiguous`
    skip-with-candidates-recorded or `requires_human_record_selection`
    placeholders into the suggest chain), emit a fill-blanks-only plan.
    Without `--save`: dry-run diff, nothing written.
  - `enrich refresh [--source <id>] [--stale-days <n>] [--save]` — work set
    from run-store stamps older than the staleness window (per-field
    `staleDays` → `policy.defaultStaleDays` → 90); operations only where the
    source value actually changed, and only on fields the ledger proves
    enrich stamped.
  - `enrich ingest <file.csv|payload.json> --source <id> [--run-label <l>]`
    — stage Clay CSV exports (dependency-free CSV parser) or webhook payload
    JSON for a subsequent append/refresh.
  - `enrich status [--runs] [--source <id>]` — last run per source, counts,
    staleness distribution, interrupted-run cursor.
  - `enrich.config.json` (sources / ordered match keys / field mappings /
    policy) with strict up-front validation; the `system-only` and `always`
    conflict-ladder rungs error as "not yet implemented (phase 2)" instead
    of being silently accepted. MVP policy: `never` (fill blanks only).
  - Apollo source client: raw `fetch` against the people-match /
    organization-enrich endpoints, BYO key via `login apollo` (0600 cred
    store) or `APOLLO_API_KEY`, and 429-aware retry with capped exponential
    backoff honoring `Retry-After` — local to the Apollo client; the shared
    connector contract is unchanged.
  - Profile-scoped append-only run store
    (`~/.fullstackgtm/profiles/<p>/enrich/runs/<runLabel>.json`): resume
    checkpoint (cursor + already-paid-for payloads), per-record/per-field
    `enrichedAt` staleness ledger, and the surface `enrich status` reads.
    State stays local — no `fsgtm_enriched_at`-style properties are written
    into the customer's portal.
  - Every `enrich` subcommand catches `--help`/`-h` before config load,
    credential resolution, or any network call. No scheduling/cron logic —
    that is the horizontal schedule layer's job (docs/schedule.md).
- **Four task-shaped verbs** (entry added retroactively — these shipped in
  0.23.0 without a changelog record). The 612-run benchmark's gated-agent
  failures clustered into four missing verbs; all four compile to plans
  through the existing plan → approve → apply gate — nothing writes directly.
  - `dedupe <account|contact|deal> --key <domain|email|name>` — duplicate
    groups by normalized identity key, one `merge_records` operation per
    group with a deterministic survivor (`richest` = most populated data
    fields, ties to lowest id; `oldest` = lowest id). High risk, approval
    required; merges are irreversible on apply.
  - `reassign --from <ownerId> --to <ownerId>` — the ownership-handoff
    playbook: one bulk-update-style plan per object type, extra `--where`
    scoping account-lifted for deals/contacts, `--except-deal-stage`
    excluding the stage AND records whose account has an open deal in it —
    re-verified per record at apply time.
  - `fix --rule <id>` — one-shot composite: audit one rule → save → suggest
    → approve only suggestion-backed values at the confidence bar → apply
    (`--yes` required), with a stage-by-stage summary.
  - `bulk-update --set <field>=from:<sourceField>` — per-record derived
    values resolved from the filter view (relational sources like
    `account.ownerId` included); empty-source records are skipped and
    counted, never guessed. Plus the `--archive` duplicate guard: archiving
    a record that shares its identity key with another is refused and
    pointed at `dedupe`, overridable with `--force-archive-duplicates`.

## [0.22.0] — 2026-06-12

The report becomes a narrative: map → claims → where to attack.

### Changed

- **Reading order rebuilt around the insight.** The strategic map is now the
  hero, directly under the header: contenders and their positions first.
  The claim detail follows, then the report CLOSES on the reasoned takeaway.
  The front-summary stat cards are gone (numbers without referents).
- **"Where to attack"** — a generated closing section that walks the open
  fronts as an argument: each open claim names its closest quiet contenders,
  whether the anchor already ships it quietly (promote candidate) or it's
  unclaimed (first-mover), plus held ground (anchor-owned fronts to defend)
  and crowded ground (saturated fronts where message budget buys least).
  Ends by pointing at `market overlay` for evidence-backed directives.
- **Claims grouped and collapsed**: the matrix splits into Open / Contested /
  Owned / Saturated `<details>` groups, default collapsed, each summary
  carrying the skimmer's stats (count, definition of the state, anchor's
  loud count within the group).
- **Evidence appendix grouped by vendor**, collapsed — receipts on demand.
  All groups auto-expand on print (beforeprint).

## [0.21.2] — 2026-06-12

Scatter interactivity + honest sizing fallbacks.

### Changed

- **Hover tooltips on the strategic map**: rich tooltip (vendor, both axis
  positions, LOUD count, estimated revenue/share with signal spread) follows
  the cursor; hovering a bubble raises it to the front, so a bubble born
  fully underneath a bigger one is one mouse-over from visible; hovering
  dims the rest. Legend rows cross-highlight their bubbles.
- **No more implied share**: without scaleSignals the map renders UNIFORM
  dots with the caption "Dot size carries no meaning on this map" — the
  LOUD-count sizing fallback is gone (a map owner read it as market share;
  the legend still lists LOUD counts). With partial coverage (majority of
  vendors estimated), scale mode holds and signal-less vendors render as
  minimal DASHED bubbles — visibly "no measurable scale", never silently
  resized; their legend row shows "—".
- Numbers move above bubbles too small to contain them.

## [0.21.1] — 2026-06-12

Report design pass: analyst-grade restraint, legible dense scatters.

### Changed

- **De-slopped the field report**: removed the rotated stamp, paper-grain
  background, parchment palette, letterspaced kickers, and editorial hero
  voice. White page, hairline rules, plain headings — the design recedes,
  the data reads.
- **Strategic map legibility**: bubbles are now numbered and colored
  (Okabe–Ito colorblind-safe palette) with a legend table beside the chart
  that doubles as the share table (number · color · vendor · est. share or
  LOUD count, anchor bolded). Larger bubbles render first so overlapping
  clusters stay readable; the number resolves what overlapping name labels
  never could. Hover tooltips keep the names.
- **Axis pole labels can no longer collide**: wrapped to ≤2 short lines
  (parentheticals dropped first), x poles at the bottom corners, y poles
  rotated along the left margin — four positions, standard chart
  convention.

## [0.21.0] — 2026-06-12

Scale estimation v2 — dimensional, calibrated, SMB-bias-robust.

### Changed

- **`market scale` estimates revenue, not a normalized blend.** v1 averaged
  [0,1]-normalized signals, which quietly mixed dimensions: review/customer
  counts proxy CUSTOMER COUNT while employees/revenue proxy REVENUE, so
  many-small-customer vendors outranked fewer-bigger-customer ones (observed
  live: a ~$20M SMB dialer outranked a ~$33M mid-market platform). v2
  converts every signal into revenue space first: revenue signals are used
  directly; headcount × a revenue-per-employee ratio; customer counts × a
  revenue-per-customer ratio **calibrated within the set (median over
  vendors that have both) and stratified by the vendor's new `acvBand`** —
  revenue-per-review spans ~75× between SMB tools and enterprise suites,
  which is the bias, killed at the source. Per-vendor output is an
  estimated revenue (weighted geometric mean: revenue 3 / headcount 2 /
  customers 1) with a disclosed max/min **uncertainty spread**, an index =
  share of the set's summed estimates, and the full calibration table.
  Uncalibratable metrics (no revenue pair anywhere) are skipped and named.
- Report bubbles: dot area ∝ estimated revenue share (normalized to the
  set's max for visual range — ratios preserved); caption now says
  "estimated revenue share … citable but NOT audited" and points at
  `market scale` for the per-vendor estimates and spreads.
- New config fields: `MarketVendor.acvBand` ("smb" | "mid" | "enterprise"
  by convention — usually obvious from the pricing page the map already
  captures) and `ScaleSignal.dimension` override.
- SMB-bias regression test: many cheap-product reviews must not outrank
  fewer expensive-product reviews when band calibration says otherwise.

## [0.20.0] — 2026-06-12

The directive layer: the market map joined to your own CRM ground truth.
Two companies mapping the same category see the same fronts; their own
conversion fingerprints produce different directives.

### Added

- **`fullstackgtm market overlay`** — joins the observation store to a CRM
  snapshot and a call corpus, and emits OCCUPY / PROMOTE / URGENT / RETREAT
  directives. Deterministic throughout: claim mentions are word-boundary
  matches of each claim's configured `terms` (and vendor `aliases`) against
  call documents (`call parse` output, optionally deal-linked via a manifest);
  every directive carries ≥1 observation id and ≥1 CRM statistic **with its
  sample size**; explicit minimum-evidence thresholds (`--min-mentions`,
  `--promote-lift`) refuse to mint strategy from small samples — and an
  empty directive list is reported as an answer, not a failure.
  - OCCUPY: open front the anchor doesn't own, buyers demonstrably discuss it.
  - PROMOTE: anchor-quiet claim whose mentioned-deal win rate beats baseline.
  - URGENT: a front the anchor is loud on drifted toward saturation
    (`--prior-run`).
  - RETREAT: saturated front, loud anchor, zero presence in won-deal calls.
  - `--save --task-account <id>|--task-deal <id>` turns directives into
    approval-gated `create_task` operations through the normal
    plans → approve → apply gate. Nothing writes without approval.
- **`fullstackgtm market scale` + scale-sized report bubbles** — vendors may
  carry `scaleSignals` (citable G2 review counts, LinkedIn headcount,
  disclosed revenue, self-reported customers — each with sourceUrl, verbatim
  quote, asOf, and caveat). A deterministic composite (log-normalized
  per metric within the set, mean over available metrics, singleton metrics
  skipped) yields a **relative scale index — never "market share"
  unqualified** — and the strategic map's dot area becomes proportional to
  it when every placeable vendor has signals (LOUD-count sizing otherwise;
  the caption always states which, and bubbles are now area-proportional
  either way).
- `MarketClaim.terms` and `MarketVendor.aliases` for deterministic mention
  matching; `MarketVendor.scaleSignals`.

## [0.19.0] — 2026-06-11

Governed bulk writes, plus fixes from the 0.18 published-artifact verification.

### Added

- **`fullstackgtm bulk-update <account|contact|deal>`** — generic writes
  through the same plan gate as everything else: `--where` filters (`=`,
  `!=`, `~` substring, `:empty`/`:notempty`, `|` alternation) select records,
  `--set`/`--archive`/`--create-task` define the change, and the result is a
  dry-run patch plan needing explicit approval before `apply` — never a
  direct write. `--require <field>=<value>` preconditions and
  `--guard <object>:<where>:<none|some>` cross-record eligibility checks are
  re-verified at apply time against the live CRM (mid-apply rechecks shrink
  the audit→apply TOCTOU window); `--max-operations` caps blast radius.
- Eval tool card teaches agents to encode eligibility conditions in filters
  rather than hand-selecting record ids.

### Fixed

- `--help` no longer executes: every `market` subcommand now short-circuits
  to usage before config loads, credential checks, or side effects
  (`market capture --help` used to *run the capture* — live fetches and
  manifest writes; `market axes --help` ran the analysis). Top-level
  commands without bespoke help (`audit`, `snapshot`, `suggest`, …) print
  usage on `--help` instead of executing (`audit --help` used to silently
  run the sample audit).
- `market report --format html` no longer crashes with a bare TypeError on
  axes missing pole labels: `parseMarketConfig` now requires
  `negativePole`/`positivePole` on every axis and says so.
- The 0.18.0 entry below documented the axis shape with a `poles` field that
  never existed; the real fields are `negativePole`/`positivePole` (entry
  corrected in place).
- `forcedToolCall` is now actually exported from the package root, as the
  0.17.0 entry claimed.
- MCP `fullstackgtm_market_worksheet`/`_observe` with no
  `market.config.json` in the server cwd return a "run `fullstackgtm market
  init`" hint instead of a raw ENOENT.

## [0.18.0] — 2026-06-11

Axis discovery: earn a strategic 2×2 from the observations instead of
asserting one.

### Added

- **Axes as config** — `axes` in `market.config.json`: each axis is a
  claim-scoring rubric (`{ id, label, negativePole, positivePole, rubric, status, claimScores }`,
  null = axis doesn't apply to that claim); a vendor's position is the
  intensity-weighted mean (loud=1, quiet=½) of the claims it voices.
  `primaryAxes: [x, y]` picks the report's strategic map. Config validation
  rejects axes scoring unknown claims.
- **`fullstackgtm market axes`** — the discovery math, pure and
  dependency-free: PCA (power iteration) over the vendor × claim intensity
  matrix — PC1 is the category's own primary axis, PC2 the
  maximum-differentiation direction orthogonal to it; triangulation of every
  configured axis against the PCs (a real axis is *derivable* from the data,
  not just felt); and an orthogonality screen (|r| ≥ 0.75 = one axis twice —
  sometimes the finding: the category couples the ideas and the empty
  quadrant is the white space). Fully-unobservable vendors are excluded,
  never zeroed.
- **Report: strategic map** — section 03 renders the primary 2×2 (positions
  computed, not asserted; dot size = LOUD count; axis status in the caption)
  when axes are configured; the evidence appendix renumbers accordingly. The
  report deliberately carries only the one earned 2×2 — best foot forward
  for the client; axis exploration (every pairing, r, verdicts) is `market
  axes` territory for the analyst or agent doing the iterating.
- **Golden regression**: the 280-cell creative-intelligence validation
  dataset ships as a test fixture — PCA must recover the buyer axis as PC1
  (|r| ≥ 0.9) and value-mode as PC2 (|r| ≥ 0.85), and flag the documented
  buyer × operating-model redundancy.

## [0.17.0] — 2026-06-11

Market map classification: intensity readings become a one-command step, and
the verbatim-quote rule becomes a mechanical gate instead of a prompt
instruction.

### Added

- **`fullstackgtm market classify`** — LLM intensity readings for every
  vendor × claim cell from the stored captures, through the same
  bring-your-own-key constrained-tool-call seam as `call parse`
  (provenance `extractor: "llm:<provider>:<model>"`). Vendors with no
  usable captures score UNOBSERVABLE deterministically, without an LLM
  call. `--vendor` classifies one vendor to `--out` for hand-merging;
  `--model` overrides the provider default.
- **Mechanical span verification** — because market sources are *stored*
  captures (unlike transcripts, which pass through), every quoted evidence
  span is checked character-for-character (whitespace-normalized) against
  the capture it cites. Readings that fail bounce back to the model once
  with the failures named; persistent failures abort with nothing stored.
  The same gate now guards `market observe` (escape hatch: `--unverified`,
  for sets whose captures genuinely live elsewhere) and the MCP submission
  path — every proposal channel passes the same gate.
- **`fullstackgtm market worksheet --vendor <id>`** — the no-key channel:
  a self-contained packet (claims with judging definitions, surface rule,
  captured page texts) for an agent or human to classify by hand and
  submit via `observe`.
- **`fullstackgtm market refresh`** — capture → classify → front drift →
  HTML field report, one command. The weekly refresh is now a single
  invocation (schedule it however you schedule things).
- **MCP**: `fullstackgtm_market_worksheet` and `fullstackgtm_market_observe`
  (validates + verifies + appends; returns the computed front states on
  acceptance).
- `forcedToolCall` exported from `llm.ts` — the one seam every LLM feature
  in the package goes through.

## [0.16.0] — 2026-06-11

The market map: a live model of the competitive category a company sells
into — claim taxonomy as reviewable config, append-only observations with
verbatim-quote evidence, deterministic front states and drift.

### Added

- **`fullstackgtm market`** — `init` scaffolds a `market.config.json`
  (vendor registry + claim taxonomy + the LOUD/QUIET/ABSENT surface rule);
  `capture` fetches vendor pages into a content-addressed text cache (the
  change detector, replay buffer, and evidence chain); `observe --from`
  ingests intensity readings after validating full coverage and the
  verbatim-evidence rule (a loud/quiet reading with no quote is rejected);
  `fronts` computes deterministic front states (open / contested / owned /
  saturated / vacant) and `--diff` reports drift between runs; `report`
  renders the claim × vendor matrix as markdown or a self-contained
  printable HTML field report with an evidence appendix.
- **Division of labor matches call intelligence:** intensity readings are
  proposals (provenance-marked extractor, always with quoted evidence);
  everything downstream is deterministic over the stored observations —
  same observations, same map. A failed capture reads as UNOBSERVABLE,
  never as absence.
- **Profile-scoped storage:** captures and observations live under
  `~/.fullstackgtm/market/<category>` (or the active profile's home), so one
  client org's category intel never bleeds into another's.
- `ObservationStore` contract + file implementation (append-only, one JSON
  document per run) — like the plan store, the file layout and the hosted
  backend are two implementations of the same contract.
- `"web"` joined `GtmEvidenceSourceSystem`: market observations carry
  standard `GtmEvidence` with `metadata.url` + `metadata.captureHash`.

## [0.15.1] — 2026-06-11

Fixes from the 0.15.0 journey verification (4 agents, 26 checks).

### Fixed

- **Name-only deal resolution is gated**: `resolve deal --name X` without
  `--account-id` returned safe_to_create even when open deals named X
  existed — a gate that ignores name collisions protects nobody. It now
  returns ambiguous with the colliding open deals and tells the caller to
  supply `--account-id` for a definitive answer.
- The closed-deals-share-name note is account-scoped (it previously counted
  closed deals on *other* accounts).
- The `hs_object_source_detail_2` stamp on CLI-created companies now
  carries the operation id for precise attribution.

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
1.0 will be declared via [docs/roadmap-to-1.0.md](https://github.com/fullstackgtm/core/blob/main/docs/roadmap-to-1.0.md)
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
  0.3.x work (see https://github.com/fullstackgtm/core/blob/main/docs/roadmap-to-1.0.md).

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

# fullstackgtm

[![CI](https://github.com/fullstackgtm/core/actions/workflows/ci.yml/badge.svg)](https://github.com/fullstackgtm/core/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/fullstackgtm)](https://www.npmjs.com/package/fullstackgtm) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**Guardrails for AI agents working in your CRM.**

Let Claude or Codex loose on Salesforce or HubSpot and it will make predictable mistakes — duplicates, bad batch edits, silent overwrites. fullstackgtm is the wrapper that knows those mistakes: every change becomes a reviewable plan before anything is written.

Instead of overwriting records, an agent using fullstackgtm sets out a **patch plan**: what it wants to change, field by field, with before/after values and the reason. You review it, roll it out incrementally (approve 10 operations, then 100, then all), and every write records the before value — so a mistake is visible and reversible, not silently absorbed. Think `terraform plan` for your CRM.

**What it catches:** duplicates, orphaned records, bad batch edits, stale deals, missing owners — deterministic rules, not LLM guesses. Works as a CLI, a library, or an MCP server your agent calls directly.

Open source (Apache-2.0), zero runtime dependencies. Beta (0.x): APIs may shift before 1.0; the safety invariants never do. Connectors: HubSpot, Salesforce (read/write), Stripe (read-only).

## Install

```bash
npx fullstackgtm audit --demo               # zero-install try-it path
npm install fullstackgtm                    # library + CLI in a project
npm install github:fullstackgtm/core        # or straight from this repo (project-local)
npx github:fullstackgtm/core audit --demo   # zero-install from the repo
```

(Global `npm install -g` from a git URL is unreliable on npm 11 — it symlinks into npm's temp cache. Use the registry for global installs, or the project-local/npx forms above.)

Requires Node 20+. The core has zero runtime dependencies; only the MCP server entrypoint uses the optional peers `@modelcontextprotocol/sdk` and `zod`.

```bash
npx fullstackgtm doctor   # verify the install: node version, credentials, MCP peers, next step
```

Installing for an AI agent? The fastest path is the agent skill:

```bash
npx skills add fullstackgtm/core   # Claude Code, Cursor, Codex, and other skills-compatible agents
```

It installs a compact operating guide ([skills/fullstackgtm/SKILL.md](./skills/fullstackgtm/SKILL.md)) — the governed loop, the safety invariants, and the verb map — so the agent reaches for plans instead of raw writes. For a deterministic install-and-verify script with expected outputs, hand it [INSTALL_FOR_AGENTS.md](./INSTALL_FOR_AGENTS.md). A documentation map lives in [llms.txt](./llms.txt).

## Five-minute loop

```bash
# 0. Scaffold a workspace: a starter icp.json, an enrich.config.json acquire
#    preset, and a PLAYBOOK.md wired for your provider + discovery source
npx fullstackgtm init --provider hubspot --source pipe0

# 1. No credentials? Try it on a realistic, deliberately messy demo CRM
npx fullstackgtm audit --demo

# 2. Audit your real HubSpot portal (private app token or OAuth access token)
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm audit --provider hubspot --out plan.json

# 3. Review plan.json, then apply ONLY the operations you approve
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm apply \
  --plan plan.json --provider hubspot \
  --approve op_abc123,op_def456 \
  --value op_def456=2026-09-30
```

Nothing is ever written without an explicit `--approve`. Operations whose value is a human decision (`requires_human_*` placeholders, e.g. which owner to assign) are refused unless you supply a concrete `--value` override.

`init` keeps any files you already have (`--force` overwrites) and works with `--source pipe0|explorium|linkedin` and `--provider hubspot|salesforce`. The PLAYBOOK.md it writes wires the cold-start and outbound-loop recipes to your workspace; the full play set — cold start, trigger-based outbound, scheduling, ABM, hygiene-gating, TAM — is [docs/recipes.md](./docs/recipes.md).

## Call workflows: calls become governed evidence

Calls are where pipeline truth lives. `call parse` normalizes any transcript dialect — `Speaker: text` lines (Fathom, Gong exports), `[Speaker]:` labels, or raw Granola utterance JSON — into canonical segments, insights, and `GtmEvidence` records.

**Extraction is LLM-powered by default, with your own key.** The first time you run `call parse` or `call score`, the CLI asks for an Anthropic or OpenAI API key (auto-detected from the prefix), validates it against the provider, and stores it in the 0600 credential store — same treatment as CRM logins. Or skip the prompt: set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or `echo "$KEY" | fullstackgtm login anthropic` (or `openai`). The key talks directly to your provider — raw fetch, no SDK, no middleman. `--model` overrides the defaults (claude-haiku-4-5 / gpt-4o-mini). LLM insights carry verbatim-quote evidence and, for next steps, owner/deadline/commitment. Pass `--deterministic` for the free, instant, byte-stable keyword baseline (no key needed — right for CI and warehouse bulk loads). Every insight is provenance-marked (`extractor: "llm:anthropic:…"` vs `"deterministic"`).

**`call classify`** picks the call type before scoring, because a renewal scored on "Depth of Discovery" is just wrong. It runs a **deterministic, key-free** signal classifier over the transcript — 12 call types (prospecting, discovery, demo, technical_validation, negotiation, closing, onboarding, check_in, renewal_expansion, qbr, internal, other) — returning the type with a confidence and a written reason; pass `--llm` for a model tiebreak on the ambiguous middle. It needs no API key, so it runs free in CI and on warehouse bulk loads (`--list` prints the taxonomy).

**`call score`** rates the call against a coaching rubric. By default it **auto-selects the type-specific rubric** from the classification — each call type ships its own dimensions with anchored high/low examples and evidence cues (cuts scoring variance). Override with `--call-type <type>` to force a preset, or `--rubric rubric.json` for your own (`{ scale, name?, callType?, bands?, dimensions: [{ name, weight, rubric, anchorsHigh?, anchorsLow?, evidenceCues?, coachingPrompts? }] }`). The weighted overall is computed deterministically client-side, mapped to a qualitative band, every dimension score is evidence-quoted, and the rubric file is where your client-specific coaching framework lives (`--list-rubrics` prints the built-in presets).

`call link` answers "which deal was this call about" from attendee domains (account domain or contact emails → open deals, most recent activity first, with confidence + reason). `call plan` turns next-step insights into the same governed plan lifecycle as everything else.

```bash
# Coaching pipeline (Slack + CRM): parse → classify → score → link → govern the writeback
fullstackgtm call parse --transcript call.txt --title "Acme disco" --out parsed.json   # LLM extraction
fullstackgtm call classify --call parsed.json                                          # deterministic call type
fullstackgtm call score --call parsed.json                                            # auto-selects the type's rubric
fullstackgtm call score --call parsed.json --rubric team-rubric.json                   # …or bring your own framework
fullstackgtm call link --attendees jane@acme.com --provider hubspot                    # → deal id + reason
fullstackgtm call plan --call parsed.json --deal 123 --provider hubspot --save
# review → plans approve → apply: deal.next_step + follow-up tasks, compare-and-set protected
# (pipe the parse/score JSON into Slack/Notion however you like)

# Analytics pipeline (warehouse): one flat NDJSON row per insight
for t in transcripts/*; do fullstackgtm call parse --transcript "$t" --ndjson --deterministic; done > insights.ndjson
# free keyword baseline for bulk loads; drop --deterministic for LLM-quality rows
# COPY into your warehouse (stable call/evidence ids make reloads idempotent)
```

The boundary that remains: Slack/Notion/warehouse sinks are *your* pipeline, composed around the JSON — and your rubrics and keys stay yours.

## The create gate: no new dupes

Detection cleans up yesterday's duplicates; the **resolve gate** prevents tomorrow's. Before any writer — a sync job, a webhook handler, an agent, your own script — creates a record, ask the gate:

```bash
fullstackgtm resolve contact --email jane@acme.com --input snap.json   # exit 0 = safe to create
fullstackgtm resolve account --domain acme.com --provider hubspot      # exit 2 = exists/ambiguous: do NOT create
fullstackgtm resolve deal --name "Acme Expansion" --account-id 123 --input snap.json
```

Identity keys match the audit/merge engines exactly: account domain (normalized), contact email, and the open-deal key (account + normalized name). Names alone are never identity — they return `ambiguous` with the candidates, not a guess. Exit codes are gate-shaped for scripts: `0` safe to create, `2` match found, `1` error. For high-volume writers, pair it with a cron-refreshed snapshot file rather than a live `--provider` fetch per call. Also exposed as `resolveRecord()` and the MCP tool `fullstackgtm_resolve`.

**Provenance attribution** closes the loop on recurring dupes: snapshots now capture each record's source (HubSpot's read-only `hs_object_source*` fields), and duplicate findings name the writer — `"3 accounts share acme.com … Created by: Gojiberry (app-123) ×2, CRM_UI"` — so you fix the integration, not just the records. Records created by this CLI stamp their own provenance (`hs_object_source_detail_2`, best-effort).

## From findings to fixes: the suggest chain

Most placeholder answers are already derivable from your own CRM data. `suggest` computes them deterministically — account-name matching cross-checked against contact associations — with a confidence level and a written reason per operation, so you (or an agent) approve evidence, not guesses:

```bash
fullstackgtm audit --provider hubspot --save        # → Saved plan patch_plan_abc123
fullstackgtm suggest --plan-id patch_plan_abc123 --provider hubspot --out suggestions.json
# review suggestions.json: every value carries confidence (high/low/create/none) + a reason
fullstackgtm plans approve patch_plan_abc123 --values-from suggestions.json   # high-confidence only by default
fullstackgtm apply --plan-id patch_plan_abc123 --provider hubspot
```

Widen the bar deliberately: `--min-confidence low` accepts single-signal matches and **merge survivor suggestions** (irreversible merges are capped at low confidence by design, so the default bar never bulk-approves one); `--include-creates` accepts `create:<Name>` values — approving one **creates the missing company/account record and links to it** in a single audited operation, so even record creation stays inside the typed, human-approved model. Conflicting or ambiguous evidence always yields *no* suggestion with an explanation, never a guess.

```bash
# 3. Hand the findings to whoever owns the CRM: a client-ready report
npx fullstackgtm report --provider hubspot --client "Acme" --out acme-health.html
```

`report` renders the same audit as a deliverable — severity counts up front, a prose summary, per-rule detail with example records, and next steps — as markdown or self-contained HTML (printable, emailable, no external assets).

## Routine maintenance as governed verbs: bulk-update, dedupe, reassign, fix

The maintenance work RevOps actually does in bulk — backfills, book transfers, duplicate sweeps, "just fix everything that rule found" — gets first-class verbs. Each one *builds a plan*; nothing executes without the same approve → apply gauntlet as everything else.

```bash
fullstackgtm bulk-update deal --where "stage=closedwon" --where "amount:empty" \
  --set amount=from:account.annualrevenue --save     # per-record derived values; empty sources skipped, never guessed
fullstackgtm dedupe account --key domain --keep richest --save   # one merge_records op per duplicate group
fullstackgtm reassign --from 411 --to 902 --except-deal-stage closing --save   # ownership handoff playbook
fullstackgtm reassign --assign-unowned --to 902 --save          # claim every ownerless record for an owner
fullstackgtm fix --rule missing-deal-owner --provider hubspot --yes  # audit one rule → suggest → approve → apply, one command
fullstackgtm backfill stripe --save     # paid Stripe invoices → proposed closed-won deals, deduped by invoice id
```

`backfill stripe` makes the CRM honest when Stripe is the revenue source of truth: one closed-won deal per paid invoice (amount = invoice total, close date = paid date, company association by billing-email domain). A customer the CRM doesn't know gets a proposed account create in the same approval-gated plan (freemail billing domains are never used as a company domain; `--skip-unmatched` keeps them report-only), and apply re-resolves each invoice id so re-running never double-creates.

`bulk-update` filters the snapshot (`=`, `!=`, `~` substring, `!~` not-substring, `:empty`/`:notempty`, type-aware comparisons `<` `>` `<=` `>=` where `today` resolves to the policy date — e.g. `closeDate<today` — and date/numeric fields coerce by value form, `|` any-of, relational pseudo-fields like `account.domain` or `openDealStages`) into a dry-run patch plan — and **the full filter is re-verified per record at apply time**, with mid-apply rechecks, so a record that stopped matching between audit and apply is skipped, not clobbered. For date/count hygiene (past close dates, stale deals, missing accounts, duplicates), prefer the rule-backed `fix --rule <id>` — the rule encodes the open-deal + date logic deterministically; use `bulk-update` only when no rule covers the task. Equality filters double as preconditions; `--require` adds explicit ones; `--guard` asserts cross-record conditions; `--max-operations` caps blast radius. `--set field=from:<sourceField>` derives values per record; `--create-task <text>` is the third change mode, emitting approval-gated `create_task` operations instead of field writes; `--archive` refuses records whose identity key (account domain, contact email) is shared with another record — that's a duplicate, and duplicates are merged with `dedupe`, not archived around (`--force-archive-duplicates` overrides that refusal explicitly).

`dedupe` finds duplicate groups by normalized identity key and emits one `merge_records` operation per group with a deterministic survivor (`richest` = most populated fields, ties to lowest id; `oldest`). Merges stay irreversible-and-therefore-low-confidence-capped on approval, exactly like merge suggestions from the audit. `reassign` is the ownership-handoff playbook: one plan per object type, extra scoping account-lifted to deals and contacts, and `--except-deal-stage` excludes both deals in that stage and every record whose account has an open deal in it. `fix` is the one-shot composite for a single rule: audit → save → suggest → approve suggestion-backed operations at the confidence bar → with `--yes`, apply and print the stage-by-stage summary; without it, stop after approval and print the apply command.

## The market map: the category, observed

Your CRM records what happened in your own deals; nothing records the shape of the category you sell into. The **market map** does: vendors and a claim taxonomy live in a reviewable `market.config.json`, vendor pages are captured into a content-addressed cache, every vendor × claim cell gets a messaging-intensity reading (LOUD / QUIET / ABSENT — with UNOBSERVABLE for failed captures, never a fake absence), and deterministic front states fall out per claim: open, contested, owned, saturated.

```bash
fullstackgtm market init --category creative-intelligence   # seed vendors + claims, edit by hand
fullstackgtm market capture                                 # fetch pages → content-addressed captures
fullstackgtm market classify                                # LLM readings (BYO key), every quote verified
fullstackgtm market fronts --diff run-1                     # what changed since last run
fullstackgtm market report --format html --out map.html     # the client-ready field report
fullstackgtm market refresh                                 # all of the above, weekly, one command
```

The discipline matches the rest of the tool. Intensity readings are *proposals* — from the LLM (`classify`, same bring-your-own-key seam as `call parse`, provenance-marked) or from any agent/human (`market worksheet` → `market observe`) — and **every quoted evidence span is verified character-for-character against the stored capture it cites** before an observation is accepted. Quotes that aren't on the page bounce. Everything downstream of the store is deterministic: same observations, same map.

`market axes` is for earning a strategic 2×2 instead of asserting one: PCA over the intensity matrix (PC1 = the category's own primary axis, PC2 = the most differentiating direction orthogonal to it), triangulation of your configured axes against the data, and an orthogonality screen that flags two axes that are secretly one. Axes are claim-scoring rubrics in the config; the report renders the primary pair as the strategic map. Captures and observations are profile-scoped (`~/.fullstackgtm/market/<category>`), so one client's category intel never bleeds into another's.

Two more derivations close the loop from map to action. `market overlay --snapshot <crm.json> [--calls <files>]` joins the observation store against your own ground truth — which claims and vendors actually come up in your deals and call transcripts (deterministic word-boundary matching, no LLM) — and emits OCCUPY / PROMOTE / URGENT / RETREAT directives, each carrying at least one observation and one CRM stat with its sample size; below the evidence thresholds the honest answer is *no directive*. `--save` turns directives into approval-gated `create_task` operations through the normal plan chain. `market scale` estimates each vendor's size from **citable** signals you record in the config (G2 review counts, LinkedIn headcount, revenue claims — each with source URL, verbatim quote, and caveat): every signal is converted into revenue space first, calibrated within the vendor set and stratified by ACV band, then combined as a weighted geometric mean with the uncertainty spread and calibration table disclosed. The report's strategic-map bubbles become area-proportional to estimated revenue share — captioned "citable but NOT audited" — and without signals, dots are uniform and the caption says size carries no meaning.

## Governed enrichment: a diff you approve before third-party data touches your CRM

Every enrichment vendor ships fire-and-forget writeback. The **enrich layer** inverts that: declare once which fields come from which source under which conflict policy (`enrich.config.json` — sources, ordered match keys, field mappings, policy), then `enrich append` fills the gaps and `enrich refresh` keeps them current — with every write passing through the normal dry-run → approval → apply contract, and every value traceable to the source payload that produced it.

```bash
echo "$APOLLO_API_KEY" | fullstackgtm login apollo          # BYO key, stored 0600
fullstackgtm enrich append --provider hubspot               # pull → match → dry-run diff, writes NOTHING
fullstackgtm enrich append --provider hubspot --save        # persist the plan (needs_approval) + run record
fullstackgtm enrich ingest clay-export.csv --source clay    # stage a push-style source (Clay CSV / webhook JSON)
fullstackgtm enrich refresh --source apollo --save          # re-check stale stamped fields; ops only where the source changed
fullstackgtm enrich status --runs                           # last run per source, counts, staleness, interrupted-run cursor
```

Matching is deterministic: ordered keys, unique hit wins, zero hits falls through to the next key, and multiple hits are never guessed away — they skip (recorded with candidate ids) or flow into the existing `suggest` → `plans approve` chain as `requires_human_record_selection` placeholders. The MVP conflict policy is `never`: enrich only fills blank fields, and `refresh` only re-touches fields its own run-store ledger proves it stamped (per-record/per-field `enrichedAt`, profile-scoped, never written into your portal as custom properties). The `system-only` and `always` rungs of the ladder are phase 2 and are refused explicitly, not silently accepted. Recurring execution belongs to the scheduler — enrich owns no cron logic.

## Acquire: net-new leads, ICP-targeted and dupe-safe by default

`enrich append/refresh` fill blanks on records you already have. **`enrich acquire`** creates *net-new* ones — and routes them through the same dry-run → approve → apply gate, so prospecting can never silently write to your CRM. It discovers people, resolves their work email, scores them against your ICP, dedupes against your CRM, and proposes governed `create_record` operations.

```bash
fullstackgtm icp interview                                  # emit the ICP question spec; an agent asks it (AskUserQuestion)
fullstackgtm icp set answers.json --name "RevOps ICP"       # write icp.json (firmographics + persona + fit threshold)
echo "$PIPE0_API_KEY" | fullstackgtm login pipe0            # discovery + work-email provider, stored 0600

fullstackgtm enrich acquire --provider hubspot              # zero-config: ICP → discover → score → dedup → dry-run diff
fullstackgtm enrich acquire --provider hubspot --max 25 --save   # cap the batch, persist the needs_approval plan
fullstackgtm enrich acquire --provider hubspot --max 25 --scan-limit 500 --save # scan through duplicate-heavy pages for 25 fresh leads
fullstackgtm plans approve <id> --operations all
fullstackgtm apply --plan-id <id> --provider hubspot        # the only step that creates contacts
```

The **ICP** (`icp.json`) is the single targeting artifact: it generates each provider's discovery filters (Explorium, pipe0/Crustdata) *and* fit-scores every discovered prospect — only above-threshold leads are proposed. Develop one by interview; the CLI can't run `AskUserQuestion` itself, so `icp interview` emits the spec and an agent (Claude Code / Codex) drives it.

**You don't pay to re-discover dupes.** Before the (credit-spending) email step, acquire drops prospects already in your CRM and any seen in a prior run:

- **Pre-email CRM dedup** matches the live snapshot. The LinkedIn URL (`hs_linkedin_url`, read into the snapshot by default — safe everywhere, HubSpot ignores unknown properties) is the strong key; name+domain is the fallback. Created contacts get their LinkedIn URL written back, so coverage — and dedup precision — grows over time. If your CRM has no LinkedIn URLs, acquire says so and recommends populating it.
- **A cross-run seen cache** remembers everyone already resolved, so re-running the same ICP costs nothing for known people.
- Two more checkpoints stay precise: the email-level match at plan build, and **resolve-first at apply** (re-checks the live CRM, never double-creates, never charges the meter).

Every run is **metered**: a per-profile budget caps both record count and provider spend (per-day + per-month, whichever binds first), charged only for creates that actually land. `enrich acquire` runs with just an `icp.json` and a `login` — sensible defaults for budget, provider, and create-mapping ship in the box.

Discovery continuation is profile-scoped and independently keyed by the exact
provider, source, list, and ICP query. Scheduled runs resume the saved Pipe0
cursor or HeyReach offset instead of rereading page one, even when several
lists alternate. When the CLI is paired, this non-PII checkpoint is mirrored
to the hosted organization with compare-and-swap so another authenticated
worker can resume without moving a newer cursor backwards. `--max` is the desired net-new plan size;
`--scan-limit` independently bounds raw candidates scanned after ICP filtering
and dedupe. `enrich status --runs` exposes the full funnel and whether the
audience is continuing or provider-confirmed exhausted.

When paired, every saved plan is also mirrored into the hosted Patch Plans
review queue and the CLI prints its exact deep-link. The mirror is immutable
and organization-scoped: replaying the same plan is idempotent, while the same
id with different content is rejected. Hosted reviewers can approve or reject;
the plan is executable from any synchronized surface with a compatible CRM
connection. A CLI-created plan can be applied in hosted, and a hosted approval
can be applied from the CLI—the plan's origin does not permanently own it.

This is local-first replication, not remote control. The local plan store works
offline, and plan commands perform a best-effort hosted check-in. Run
`fullstackgtm plans sync` to explicitly exchange every plan's latest approval,
execution claim, status, and receipts. If hosted applies while the CLI is
offline, the next check-in imports the exact per-operation results and marks
the local plan applied. If the CLI applies while hosted is unavailable, it
keeps the result locally and uploads the receipt on a later check-in.

Before either surface writes, it verifies the immutable plan hash, selected
operation ids, current approval revision, connector capability, and provider
state. Online replicas use a short-lived execution claim to coordinate; stable
operation ids, resolve-before-create, compare-and-set guards, and provider
readback protect offline retries. Receipts record each operation as `applied`,
`skipped`, or `failed`, plus provider record ids when available, so another
replica learns what happened rather than inferring it from plan status. A
conflicting plan body or approval revision is surfaced for review and is never
merged by expanding authority.

Interactive command output is decision-first by default: compact cards show
status, selected scope, expected effect, per-record outcomes, hosted links, and
the next safe command. Use `--verbose` on supported human-facing commands for
the complete findings/evidence/payload document; use `--json` for the stable
machine-readable contract. Progress and warnings remain on stderr, while JSON
and requested report data remain clean on stdout.

Local signing keys and HMAC digests never upload. Operation before/after values
do upload to the paired organization because they are required for informed
review and hosted execution.

**Discovery sources** are zero-config presets behind `--source`: `explorium` and `pipe0` run ICP-driven people search, while `linkedin` (Phase 1 — discovery + dry-run) reads a pre-built **HeyReach** lead list:

```bash
echo "$HEYREACH_API_KEY" | fullstackgtm login heyreach        # or set HEYREACH_API_KEY
fullstackgtm enrich acquire --source linkedin --list <listId> --provider hubspot   # score → dedup → dry-run diff
```

LinkedIn is just another discovery source on the same scored → deduped → metered → dry-run→approve→apply spine; the LinkedIn profile URL is the match key and the list costs `$0`/record. **It never sends** — connect/message operations are out of scope for Phase 1, so without `--save` there is zero send/ToS exposure.

**Leads are never born ownerless.** An `acquire.assign` policy stamps an owner onto every created lead at create time (mapped to HubSpot `hubspot_owner_id`), routed by one of four strategies — `fixed`, `round-robin` (distributed deterministically, no rotation state to drift), `territory` (by geo / industry / size / department / title), or `account-owner` (inherit the matched company's owner). With no policy and a single-owner portal, acquire defaults every lead to that owner (or pass `--assign-owner <id>`); with multiple owners and no policy it warns and leaves them unassigned rather than guess. To clear *existing* ownerless records, `reassign --assign-unowned --to <ownerId>` applies the same intent as a backfill.

## Signal-based outbound: reach accounts the week something changes

Cleaning and filling the CRM tells you *who* to reach; it never tells you *when*. The **signal → judge → draft** loop adds timing — and, like everything else, it stays on the dry-run → approve → apply spine and sends nothing.

```bash
# 1. Watch for movement. Free, no-auth public job boards in the box; pull from
#    connected platforms via source connectors; webhook platforms via the spool.
fullstackgtm signals fetch --bucket job --source greenhouse,lever,ashby --keywords "revops,growth" --save
fullstackgtm signals fetch --connector serpapi-news,hubspot-forms --save   # news + first-party form demand
fullstackgtm signals fetch --connector file --save                         # webhook landing zone (see docs/signal-spool-format.md)
echo "$EXA_API_KEY" | fullstackgtm login exa                              # once; or keep the key in env
fullstackgtm signals discover --icp ./icp.json --source exa --since 30d --max-searches 12 --max-usd 0.25 --save
fullstackgtm signals list --since 7d                         # ranked triggers, each with a verbatim source quote

# 2. Decide who's worth a touch — and who isn't. Scores timing × fit × memory into send/nurture/skip.
fullstackgtm icp judge --signals-from latest --with-history --save
fullstackgtm icp eval --golden default                       # gate: prove the judge is calibrated before any send (exits 2 if not)

# 3. Draft the opener from the trigger. A create_task plan — proposed, never transmitted.
fullstackgtm draft --from-judge latest --min-score 80 --channel email --save
fullstackgtm plans approve <id> --operations all
fullstackgtm apply --plan-id <id> --provider hubspot          # log the touch as a CRM task
fullstackgtm apply --plan-id <id> --channel outbox            # OR render to the outbox for a sender — transmits nothing (docs/outbox-format.md)

# 4. Close the loop. Outcomes re-weight which signals earn a touch.
fullstackgtm signals outcome --account acme.com --result replied
```

**`signals`** is Detect-side — it captures triggers into a local, profile-scoped ledger and writes *nothing* to your CRM. The five buckets (`demand`, `funding`, `job`, `company`, `social`) are not equal: a fresh round outweighs a lone social like, and a *reposted* role — the first hire fell through — outweighs a first-time post. Public ATS boards (Greenhouse, Lever, Ashby) are the free, no-auth source shipped in the box; funding/company/social arrive through `--from` staged ingest (an agent or a feed supplies them — the CLI scrapes no one), and `demand` (first-party intent) is reserved for a privileged source.

**`icp judge`** turns raw signals into a short ranked list: it scores each account on **timing × fit × memory** — the signal's weight and recency, your ICP fit, and whether you've touched the account in the last 7 days — and returns `send` / `nurture` / `skip`. Every *why-now* it produces must quote a real trigger **verbatim** (the same evidence gate as `call` and `market`); an ungrounded why-now is never stored. With no LLM key it runs a deterministic baseline. **`icp eval`** is the gate the demos skip: it grades the judge against a labeled golden set (and, once outcomes exist, checks that accounts scored hot actually book more than cold), exiting `2` below the bar so a miscalibrated judge can't reach a live send.

**`draft`** writes one opener per hot account whose first line quotes the trigger in the buyer's own words — no "Hi {{firstName}}", one ask, no manufactured urgency. It emits a `create_task` plan through the normal approval gate; it has **no send capability** and adds none — execution stays in your sender of choice. Without an LLM key it emits a clearly-labeled stub, never wooden copy passed off as a draft.

**Runs on any model.** Every LLM step honors `ANTHROPIC_API_BASE_URL` / `OPENAI_API_BASE_URL`, so the same loop runs on Claude, a GLM/z.ai endpoint, or a local Ollama by pointing one env var — `--model` picks the model id.

## Schedules: declare a cadence once, keep the governance contract under automation

Everything the CLI produces is accurate the moment it runs and silently stale afterward. The **schedule layer** is the horizontal fix — any read/plan-side command on a cron cadence, one component, every verb (no feature owns its own cron logic):

```bash
fullstackgtm schedule add "enrich refresh --source apollo --save" --cron "0 6 * * 1" --label weekly-apollo
fullstackgtm schedule add "audit --provider hubspot --save" --cron "0 2 * * *"   # nightly drift baseline
fullstackgtm schedule list                       # declarative entries; nothing runs yet
fullstackgtm schedule install                    # materialize enabled entries into the system timer (launchd on macOS, crontab elsewhere)
fullstackgtm schedule run <id>                   # execute now; same run record a cron firing produces
fullstackgtm schedule status --runs 5            # last runs, exit codes, artifacts, next + missed firings
fullstackgtm schedule uninstall                  # remove the managed block, touch nothing else
```

**Scheduling never auto-approves.** Schedulable commands are read/plan-side only — `audit`, `snapshot`, `enrich append|refresh`, `enrich acquire --save`, `market capture|refresh`, `signals fetch|discover`, `icp judge`, `icp eval`, `draft`, `suggest`, `report`, `doctor` — so unattended runs accumulate *proposals* (plans in the queue, run records, reports), never CRM writes. `apply` is schedulable only as `apply --plan-id <id>`, and every firing re-checks the plan's status is approved: an unapproved plan records a `plan_not_approved` no-op run instead of executing, and no flag relaxes this. Arbitrary shell is not schedulable — an entry's argv must resolve to a known fullstackgtm command (validated at `add` time and re-checked at run time), and the timer line you audit — crontab entry or LaunchAgent `ProgramArguments` — is always `fullstackgtm schedule run <id>` and nothing else.

`install` materializes enabled entries into the system timer; `--timer` defaults by platform. On macOS it writes one LaunchAgent plist per entry (`com.fullstackgtm.<profile>.<id>` in `~/Library/LaunchAgents`, loaded via `launchctl bootstrap`) — macOS gates `crontab` writes behind Full Disk Access, a permission no program can request, while LaunchAgents need none; launchd also coalesces firings missed during sleep into one run on wake. Re-install replaces the profile's plist fleet wholesale and never touches foreign plists. Elsewhere (or with `--timer crontab`) it renders a sentinel-delimited block (`# >>> fullstackgtm <profile> >>>` … `# <<< fullstackgtm <profile> <<<`) in your user crontab; re-install replaces the block wholesale and never touches lines outside it. Honest limitation: cron has no catch-up — a laptop asleep at firing time means a missed run. `schedule status` surfaces missed firings by comparing expected-vs-actual run history, so the gap is at least visible. Entries are provider-agnostic; cloud providers (Modal, AWS) arrive as scaffold generators that call the same `schedule run <id>` contract, and are refused as "not yet implemented" until then.

### Working across organizations

Consultants and fractional operators hold credentials for several CRMs at once. A profile scopes stored logins *and* stored plans to one organization:

```bash
fullstackgtm --profile acme login hubspot
fullstackgtm --profile acme audit --provider hubspot --save
fullstackgtm profiles            # list profiles, * marks the active one
```

Set `FULLSTACKGTM_PROFILE=acme` to pin a shell (or agent sandbox) to one client. Plans saved under a profile are invisible to every other profile, so a patch plan proposed against one client's CRM can never be applied through another client's credentials.

## Built for agents (and the RevOps humans they work for)

Every command is designed to compose in an agent loop — deterministic output, machine-readable everywhere, meaningful exit codes:

```bash
# Discover the machine-readable contract: every command, read-only vs
# write-shaped access, exit codes, safety defaults (derived from the same
# help table humans read, so it can't drift)
fullstackgtm capabilities --json

# Per-command help as JSON; plain --help stays human-shaped
fullstackgtm audit --help --json

# Print the shipped agent operating guide (the same SKILL.md `npx skills add` installs)
fullstackgtm robot-docs

# Discover what the auditor checks
fullstackgtm rules --json

# Fetch once (expensive), audit offline as many times as you like (cheap)
fullstackgtm snapshot --provider hubspot --out snap.json
fullstackgtm audit --input snap.json --json
fullstackgtm audit --input snap.json --rules stale-deal --stale-days 45 --json

# Gate a nightly CI job or agent run on hygiene: exit 2 if findings ≥ threshold
fullstackgtm audit --provider hubspot --fail-on warning

# Gate CI on hygiene drift instead: exit 2 only when a NEW (rule, record) finding appears
fullstackgtm diff --before old.json --after new.json --fail-on-new-findings
```

- Terminal polish never leaks into machine output: color, spinners, progress bars, and sparklines render **only on an interactive TTY** (stderr for anything animated). Piped, redirected, `--json`, CI, and `NO_COLOR` output carries **zero ANSI bytes** — enforced by tests and a CI contract check — so transcripts and pipes see the same plain text they always did (`FORCE_COLOR=1` opts back in).
- Finding and operation ids are **stable hashes** of rule + record, so two runs over the same data produce identical ids — agents can diff plans, track findings across runs, and approve operations by id without re-parsing.
- `--demo` (with `--seed`) generates a realistic mid-market CRM with injected real-world failure modes — departed owners, unlinked deals, orphan accounts, stale pipeline — so agents and CI can exercise the full snapshot → audit → apply pipeline with zero credentials.
- Exit codes: `0` success, `1` error, `2` findings at/above `--fail-on`.

"Built for agents" is measured, not asserted: a 1,904-run benchmark (17 CRM-operations scenarios × 3 tool-surface arms × up to 4 trials, across ten models from six vendors, deterministic graders over final CRM state, τ-bench-style pass^k) shows the gated CLI surface matching or beating raw CRM-API access on completion-under-policy for every model tested — strictly better in nine of ten — and the effect is vendor-independent. Full matrix and methodology: [the leaderboard](https://github.com/fullstackgtm/core/blob/main/evals/crm/leaderboard/RESULTS.md).

Caveat: the leaderboard documents the Opus reduced protocol and mixed-version Informed arms; treat the headline as a pointer to those exact RESULTS.md conditions.

The design is **deterministic apply, governed suggest**: the parts that touch your CRM — the audit rules, the plan/apply contract, compare-and-set, the survivor/merge logic — are deterministic and replayable; the parts that read free text (`call parse`/`score`, `market classify`) are LLM-powered but bounded, with every quoted span mechanically verified against the source before it can drive a writeback. Nondeterministic suggestion, deterministic governance.

## Authentication: CLI-first, browser only at the consent moment

Credential resolution is a ladder — the first rung that yields a token wins:

1. **`--token-env <NAME>`** — explicit env var for one invocation (agent sandboxes, scripts)
2. **`HUBSPOT_ACCESS_TOKEN` / Salesforce env** — ambient env (CI)
3. **BYO direct login** — advanced token/OAuth paths stored in `~/.fullstackgtm/credentials.json` (0600; override location with `FSGTM_HOME`); these override hosted
4. **Hosted OAuth / broker** — `fullstackgtm login hubspot` or `fullstackgtm login salesforce` opens hosted browser OAuth by default, stores only a broker credential locally, and mints provider tokens server-side

### Teams: auth once, point every CLI at the stored sync credentials

```bash
fullstackgtm login --via https://gtm.yourco.com
#   Pairing code: ABCD-2345
#   Approve this CLI in your dashboard: https://gtm.yourco.com/dashboard/cli-auth?code=ABCD-2345
```

An admin connects HubSpot **once** in the hosted dashboard (the org's OAuth tokens live encrypted in the deployment). Pairing a CLI is a device-flow handshake: the CLI prints a code, an admin or manager approves it in the dashboard, and the CLI receives a long-lived broker token (stored hashed server-side, revocable per CLI). From then on, every provider command silently exchanges the broker token for a short-lived CRM access token minted from the org's stored sync credentials — and inherits the org's field mappings. No one pastes CRM tokens; revoking a laptop is one row.

**Run observability (paired CLIs).** Once paired, each command best-effort reports a run record — command, status (`success`/`partial`/`error`), duration, headline counts (e.g. ops emitted, leads created, est. cost), and structured events (plan saved, meter charged) — to the deployment's **run timeline** in the dashboard. It's opt-in by pairing (an unpaired CLI sends nothing), a 4-second-capped POST that swallows every error, and never changes the command's exit code. Setup/inspection verbs (`login`, `doctor`, `help`, `--version`) are skipped.

### Individuals: hosted OAuth by default, BYO still available

```bash
# Default: hosted first-party OAuth. No provider app or provider secret in the npm package.
fullstackgtm login hubspot
fullstackgtm login salesforce
# optional: point at a self-hosted/team deployment
fullstackgtm login hubspot --hosted --via https://gtm.yourco.com

# Advanced HubSpot private app token (validated, then stored; token on stdin).
# Note: hosted HubSpot OAuth covers reads and object writes but cannot create
# tasks (HubSpot exposes no tasks scope to public apps) — use a private-app
# token if your workflow relies on `create_task` proposals.
echo "$HUBSPOT_TOKEN" | fullstackgtm login hubspot --private-token

# Advanced HubSpot BYO-app OAuth. Client secret is read from stdin/prompt — never a flag.
echo "$CLIENT_SECRET" | fullstackgtm login hubspot --oauth --client-id <id>
#   (register http://localhost:8763/callback as a redirect URL on your app)

# Advanced Salesforce BYO Connected App device flow.
fullstackgtm login salesforce --device --client-id <consumer key>
# ...or a session token directly (token on stdin, never as a flag):
echo "$SF_SESSION_TOKEN" | fullstackgtm login salesforce --instance-url https://yourorg.my.salesforce.com

fullstackgtm logout hubspot   # or: salesforce | broker
```

BYO direct credentials always win over a hosted broker pairing, so an operator can override the team default. First-party app secrets never ship in the npm package; hosted login stores a local broker token and mints provider tokens server-side. HubSpot does not support the device-authorization grant or secretless public clients, which is why the bring-your-own-app OAuth path requires client credentials; they are stored locally for silent refresh, the same model as `gcloud` and `aws` CLI profiles.

Salesforce credential-bearing URLs are restricted to canonical HTTPS
Salesforce-owned production, sandbox, and My Domain origins. Lookalike hosts,
userinfo, paths/query/fragment, nonstandard ports, unsafe token-response
instance URLs, and credential-forwarding redirects are refused both when the
credential is stored and every time it is used.

## Connect your CRM

What each provider actually requires before `audit --provider <name>` works on your data.

### Connector capabilities

Connectors differ in what the provider's API allows — stated up front so nothing surprises you mid-evaluation:

| Operation | HubSpot | Salesforce | Stripe |
| --- | --- | --- | --- |
| Read / snapshot / audit | ✅ | ✅ | ✅ (read-only) |
| Field writes (`set_field`, `clear_field`, `link_record`) | ✅ | ✅ | — |
| `create_task` | ✅ | ✅ | — |
| `archive_record` | ✅ | ✅ | — |
| `merge_records` (`dedupe`) | ✅ | ✅ Account/Contact (SOAP); ❌ Opportunity | — |

**Salesforce merge** uses the SOAP `merge()` call (REST has no merge resource), so `dedupe` works on Salesforce **Accounts and Contacts** — the OAuth token doubles as the SOAP session, and groups larger than three records are merged in batches (master + 2 per call). **Opportunities cannot be merged** (Salesforce exposes no opportunity merge in the API or the UI) — for duplicate opportunities, pick a survivor and close/archive the rest. As always, merges are irreversible and go through the same approval gate + drift guard as every other write. (Validate against a sandbox first if you're wiring it into automation — the SOAP path is exercised by unit tests but a live Salesforce org is the real proof.)

### HubSpot: create a private app (~2 minutes, needs super-admin)

1. In HubSpot: **Settings → Integrations → Private Apps → Create a private app.**
2. On the **Scopes** tab, grant the read scopes the audit needs:
   - `crm.objects.owners.read`
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
3. If you plan to **apply** approved operations (not just audit), also grant write scopes for the objects you'll let it touch: `crm.objects.deals.write` (covers `deal.next_step` and other deal fields), plus `crm.objects.contacts.write` / `crm.objects.companies.write` for contact/company patches, and the **Tasks** write scope for `create_task` operations (search "tasks" in the scope picker; naming varies by portal).
4. Create the app, copy the token (`pat-...`), then: `echo "$TOKEN" | fullstackgtm login hubspot --private-token`.

If a scope is missing you'll see a `403` mid-run whose body names the exact missing scope (`requiredGranularScopes`) — add it to the private app and re-run. Note that `login` only validates the token itself; it can't tell whether every scope you'll need is granted.

### Salesforce: a Connected App (one-time, usually needs an admin)

Device-flow login requires a Connected App in your org — if you're not an admin, this is the step to ask one for:

1. **Setup → App Manager → New Connected App**, enable OAuth settings.
2. Check **Enable Device Flow**.
3. OAuth scopes: **Manage user data via APIs (`api`)** and **Perform requests at any time (`refresh_token`)** — the CLI requests exactly these.
4. Save (Salesforce can take ~2–10 minutes to propagate a new Connected App), copy the **Consumer Key**, then: `fullstackgtm login salesforce --device --client-id <consumer key>`.

Writeback needs no extra OAuth scope — applies are gated by the logged-in user's normal object/field permissions.

**Quickest token for a one-off or sandbox test (the `sf` CLI).** If you already have the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) authenticated to an org, you can skip the Connected App entirely and feed a session token straight in:

```bash
# --verbose is required to include the access token. Note: the command prints a
# sensitive-info warning *before* the JSON, so slice from the first '{' when parsing.
sf org display --target-org <alias> --verbose --json
# then hand the accessToken + instanceUrl to the CLI (token on stdin, never a flag):
echo "$ACCESS_TOKEN" | fullstackgtm login salesforce --instance-url "$INSTANCE_URL"
```

This is a **short-lived session token with no refresh** — ideal for a one-off audit or a sandbox parity test, but it expires within hours and `doctor` will show it as a static login. For durable, unattended use, set up the Connected App device flow above instead (it refreshes silently).

### Stripe: a restricted key is enough (read-only connector)

The Stripe connector reads customers, subscriptions, and paid invoices (`backfill stripe` calls `/v1/invoices`), and `apply` is read-only by construction. Create a **restricted key** with just **Customers: Read**, **Subscriptions: Read**, and **Invoices: Read** (Developers → API keys → Create restricted key) instead of pasting a full-access secret key: `echo "$KEY" | fullstackgtm login stripe`.

## Concepts

| Concept | What it is |
|---|---|
| **Canonical snapshot** | Provider-independent view of users, accounts, contacts, deals, activities. Records carry `identities` — `(provider, externalId)` claims — so the same real-world entity can be tracked across several systems. |
| **Audit rule** | A deterministic function `(context) => { findings, operations }`. Twelve built-ins cover orphan accounts, ownerless/unlinked/amount-less deals, past close dates, stale pipeline, duplicates, and more — `fullstackgtm rules` lists them all. Write your own in ~10 lines. |
| **Patch plan** | The dry-run output of an audit: findings plus typed patch operations with before/after values, reasons, risk levels, and approval flags. Always a proposal, never a mutation. |
| **Connector** | A provider adapter: `fetchSnapshot()` for reads, optional `applyOperation()` for writes. HubSpot and Salesforce reference connectors ship in the package; connectors never drop records they can't fully resolve — the audit flags them instead. |
| **Patch plan run** | The audit record of one apply attempt: per-operation applied/failed/skipped results. |

## Write a custom rule

```ts
import {
  auditSnapshot, auditFindingId, builtinAuditRules, defaultPolicy,
  type GtmAuditRule,
} from "fullstackgtm";

const missingAmount: GtmAuditRule = {
  id: "missing-deal-amount",
  title: "Deal has no amount",
  description: "Amountless deals make forecast coverage meaningless.",
  evaluate: ({ snapshot }) => ({
    findings: snapshot.deals
      .filter((deal) => !deal.amount)
      .map((deal) => ({
        id: auditFindingId("missing-deal-amount", deal.id),
        objectType: "deal", objectId: deal.id,
        ruleId: "missing-deal-amount",
        title: "Deal has no amount", severity: "warning",
        summary: `${deal.name} has no amount.`,
        recommendation: "Set an amount or close the deal out.",
      })),
    operations: [],
  }),
};

const plan = auditSnapshot(snapshot, defaultPolicy(), [...builtinAuditRules, missingAmount]);
```

## Use a connector programmatically

```ts
import { applyPatchPlan, auditSnapshot, createHubspotConnector } from "fullstackgtm";

const hubspot = createHubspotConnector({
  getAccessToken: () => process.env.HUBSPOT_ACCESS_TOKEN!,
});

const snapshot = await hubspot.fetchSnapshot();
const plan = auditSnapshot(snapshot);

// Later, after human review:
const run = await applyPatchPlan(hubspot, plan, {
  approvedOperationIds: ["op_abc123"],
  valueOverrides: { op_abc123: "9001" },
});
```

Implementing a new provider means implementing one type:

```ts
import type { GtmConnector } from "fullstackgtm";

const myConnector: GtmConnector = {
  provider: "my-crm",
  fetchSnapshot: async () => ({ /* canonical snapshot */ }),
  applyOperation: async (operation) => ({ operationId: operation.id, status: "applied" }),
};
```

## MCP server

The MCP entrypoint needs the optional peer dependencies `@modelcontextprotocol/sdk` and `zod` — plain `npx fullstackgtm-mcp` won't install optional peers, so pull them in explicitly:

```bash
# In a project
npm install fullstackgtm @modelcontextprotocol/sdk zod
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm-mcp

# Zero-install (the fullstackgtm-mcp wrapper package bundles the MCP peers)
npx -y fullstackgtm-mcp
```

Add it to Claude Code in one command:

```bash
claude mcp add fullstackgtm -e HUBSPOT_ACCESS_TOKEN=pat-... -- npx -y fullstackgtm-mcp
```

Or configure any MCP client (Cursor, Claude Desktop, …) with:

```json
{
  "mcpServers": {
    "fullstackgtm": {
      "command": "npx",
      "args": ["-y", "fullstackgtm-mcp"],
      "env": { "HUBSPOT_ACCESS_TOKEN": "pat-..." }
    }
  }
}
```

Nine tools are exposed over stdio.

**Read-only:** `fullstackgtm_audit` (sample, demo, file, or live provider sources with optional rule scoping), `fullstackgtm_capabilities` (server/tool capability manifest), `fullstackgtm_rules` (rule discovery), `fullstackgtm_suggest` (deterministic placeholder values with confidence + reasons), `fullstackgtm_call_parse` (transcripts → provenance-marked segments, insights, and evidence), `fullstackgtm_resolve` (the create gate: exists / ambiguous / safe_to_create), and `fullstackgtm_market_worksheet` (the classification packet for one vendor: claims, judging rules, captured page texts).

**Gated:** `fullstackgtm_apply` (accepts only a stored plan id; approvals and values must already be human-approved and HMAC-signed in the plan store) and `fullstackgtm_market_observe` (verifies every quoted span against the stored captures before appending — nothing is stored unless the whole set passes).

Tokens stored via `fullstackgtm login` are picked up automatically — the env var is only needed when no stored login exists.

Rule packages are executable JavaScript and are disabled by default. In the CLI,
review the modules and use `--config <path> --allow-plugins`; use `--no-plugins`
to apply only declarative config. MCP never executes rule packages: mutable
tool-call paths are not a durable code-trust boundary.

## Safety model

1. Reads are safe by default; audits never mutate anything.
2. Every proposed write is a typed patch operation with before/after values, a reason, and a risk level.
3. `applyPatchPlan` enforces the contract for all connectors: only explicitly approved operation ids are written, placeholders require concrete override values, and every attempt produces a per-operation result record.

## License & boundary

Licensed under [Apache-2.0](./LICENSE). The boundary is deliberate and stable: the framework, CLI, and MCP server are open source; the hosted Full Stack GTM application (dashboard, sync backend, broker service, team workflows) is a separate, proprietary product built on top of this package. Features never move from open to closed. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how development and mirroring work.

The surfaces in [docs/api.md](./docs/api.md) — the canonical model, rule interface, plan/apply contract, connector contract, merge/diff, config, CLI, and MCP tools — are settling but may still break in minor releases until 1.0. The safety invariants (read-only audits, approval-gated writes, placeholder refusal) are not beta and do not change.

## Development

```bash
npm run build   # compiles src/ to dist/ (tsc, type declarations included)
```

Tests live in the repository root `tests/` directory and run with `npm test`.

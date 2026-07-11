// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { DEFAULT_LOOPBACK_PORT } from "../connectors/hubspotAuth.ts";
import type { Paint } from "./ui.ts";


export function usage() {
  return `FullStackGTM — audit GTM data across providers, propose reviewable patch plans,
and apply only explicitly approved operations.

Usage:
  fullstackgtm login hubspot                  hosted browser OAuth (default; no app needed)
  fullstackgtm login salesforce               hosted browser OAuth (default; no app needed)
  fullstackgtm login hubspot --hosted [--via <url>]
  fullstackgtm login salesforce --hosted [--via <url>]
  fullstackgtm login --via <hosted url>        pair with a team deployment (broker only)
  fullstackgtm login hubspot --private-token [--no-validate]      advanced: paste private app token
  fullstackgtm login hubspot --oauth --client-id <id> [--port ${DEFAULT_LOOPBACK_PORT}] [--scopes a,b]  advanced: BYO HubSpot app
  fullstackgtm login salesforce --device --client-id <consumer key> [--login-url <url>]  advanced: BYO Connected App
  fullstackgtm login salesforce --instance-url <url> [--no-validate]  advanced: paste access token
  fullstackgtm login stripe [--no-validate]
  fullstackgtm login anthropic | openai        store an LLM API key for call parse/score
  fullstackgtm login apollo | clay             store a data-provider Public API key
  fullstackgtm login pipe0 | explorium | theirstack  store a discovery-provider key (theirstack = technographic TAM)
  fullstackgtm login heyreach                  store a HeyReach key for enrich acquire --source linkedin
  fullstackgtm logout <hubspot|salesforce|stripe|anthropic|openai|apollo|clay|pipe0|explorium|heyreach|broker>

  Secrets (tokens, client secrets) are NEVER passed as flags — they leak via
  the process list and shell history. Pipe them on stdin or enter them at the
  interactive prompt:
    echo "$HUBSPOT_TOKEN" | fullstackgtm login hubspot --private-token
  fullstackgtm init [--source pipe0|explorium|clay|linkedin] [--provider hubspot|salesforce] [--out <dir>] [--force]
                                               cold start: scaffold icp.json + enrich.config.json + a
                                               PLAYBOOK wired for this workspace (the CLI ships primitives,
                                               your agent is the orchestrator — see docs/recipes.md)
  fullstackgtm snapshot [source options] [--since <iso>] [--out <path> | --archive <dir>]
  fullstackgtm audit [source options] [audit options] [--save]
  fullstackgtm report [source options] [audit options] [report options]
  fullstackgtm diff --before <a.json> --after <b.json> [--json] [--fail-on-new-findings]
  fullstackgtm merge --input <a.json> --input <b.json> [...] --out <merged.json> [--json]
  fullstackgtm call parse --transcript <file> [--title t] [--source fathom|granola|...] [--model m] [--llm] [--heuristics] [--json|--ndjson] [--out <path>]
  fullstackgtm call classify --transcript <file>|--call <parsed.json> [--llm] [--deterministic] [--json]
  fullstackgtm call score --transcript <file>|--call <parsed.json> [--call-type <t>] [--rubric <rubric.json>] [--model m] [--json|--out <path>]
  fullstackgtm call link --attendees <a@x.com,...> | --domain <x.com>  [source options] [--json]
  fullstackgtm call plan --transcript <file>|--call <parsed.json> --deal <id> [source options] [--save|--json]
                                               calls become evidence: chunked LLM extraction by default when a
                                               key resolves (ANTHROPIC_API_KEY/OPENAI_API_KEY or \`login
                                               anthropic|openai\`), free deterministic fallback when none does;
                                               --heuristics (alias --deterministic) forces the deterministic
                                               engine, --llm forces the LLM path. Model: --model, else env
                                               FSGTM_INSIGHTS_MODEL. Then link the call to its deal and propose
                                               governed next-step writes.
  fullstackgtm resolve <account|contact|deal> [--name N] [--domain D] [--email E] [--account-id A] [source options] [--json]
                                               the create gate: exit 0 = safe to create, exit 2 = match
                                               found (exists/ambiguous) — call before ANY record creation
  fullstackgtm route leads [source options] [--match domain|company|both] [--no-inherit-owner] [--reassign-owned] [--policy <json|path>] [--save|--json|--out <path>]
                                               lead-to-account matching + owner routing as a governed plan
  fullstackgtm hierarchy report [source options] [--json|--out <path>]
                                               account hierarchy view from native parents + subdomains
  fullstackgtm relationships account (--account-id <id>|--domain <d>) [source options] [--json|--out <path>]
                                               relationship map from contacts, deals, and activity evidence
  fullstackgtm market init --category <name>   start a market map: vendors + claim taxonomy as reviewable config
  fullstackgtm market capture [--config <path>] [--run <label>]
  fullstackgtm market classify [--run <label>] [--vendor <id>] [--model m] [--out <path>]
  fullstackgtm market worksheet --vendor <id> [--out <path>]
  fullstackgtm market observe --from <observations.json|sets.jsonl|spool-dir> [--unverified]
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
  fullstackgtm tam estimate [--name <n>] [--icp <path>] (--accounts <n> | --source theirstack|explorium) (--acv <annual-usd> | --acv-from-crm --deal-period monthly|quarterly|annual) [--acv-basis account|buyer] [--buyers-per-account <n>] [--cross-checks <file.json>] [source options] [--json]
  fullstackgtm tam status [--name <n>] <source options> [--save] [--json]
  fullstackgtm tam report [--name <n>] [--out <path>]
  fullstackgtm tam populate [--name <n>] --cron "<expr>" [--source pipe0|explorium|clay|linkedin] [--provider hubspot|salesforce] [--label <l>]
                                               size the reachable market FROM the ICP (a real account count ×
                                               ACV; buyers/account = the contact population target), then fill
                                               it: populate schedules plan-only enrich acquire --save (apply
                                               stays gated), status --save stamps a coverage timeline, report
                                               projects a burn-up + ETA. estimate --source probes the provider's
                                               ICP-match count (else --accounts), always labeled provider-vs-assumption
  fullstackgtm enrich append [--source apollo] [--objects companies,contacts] [--save] [--config <path>] [source options]
  fullstackgtm enrich refresh [--source apollo] [--stale-days <n>] [--save] [--config <path>] [source options]
  fullstackgtm enrich ingest <file.csv|payload.json|spool.jsonl|spool-dir> --source clay [--run-label <label>]
  fullstackgtm enrich status [--runs] [--source <id>] [--json]
                                               governed enrichment: pull (Apollo) or stage (Clay) third-party
                                               data, match it to CRM records deterministically, and emit a
                                               fill-blanks-only patch plan through the normal dry-run →
                                               approve → apply gate. refresh re-checks stale stamped fields
                                               and proposes updates only where the source value changed.
  fullstackgtm backfill stripe|runs [--since <iso>] [--pipeline <id|label>] [--match-property <name>] [--skip-unmatched] [source options] [--save] [--dry-run] [--json]
                                               revenue truth backfill: one closed-won deal per PAID Stripe
                                               invoice (amount = invoice total, close date = paid date,
                                               associated to the matched customer account, deduped by
                                               invoice id). Reads Stripe + the CRM snapshot, emits a
                                               dry-run create_record plan through the normal approve →
                                               apply gate; unmatched customers get a proposed NEW account
                                               in the same plan (freemail domains never used;
                                               --skip-unmatched = report-only). HubSpot-only for now.
  fullstackgtm signals fetch [--bucket job,…] [--source greenhouse,lever,ashby] [--watchlist <path|crm:seg>] [--keywords …] [--from <file.json|spool.jsonl|spool-dir>] [--save]
  fullstackgtm signals list [--since 7d] [--bucket b] [--account d] [--unjudged]
  fullstackgtm signals outcome --account <d> [--touch <id>] --result replied|meeting|bounced|no_reply
  fullstackgtm signals weights [--explain]
                                               detect fresh buying triggers (ATS hiring scrapes + staged
                                               funding/company/social ingest), rank them, persist a local
                                               signal ledger. READ-ONLY re: CRM — fetch NEVER emits a plan;
                                               --save persists only the signal ledger. outcome feeds the
                                               learned per-bucket weights.
  fullstackgtm icp interview | set <answers.json> | show
  fullstackgtm icp judge [--signals-from latest|<label>] [--with-history] [--prompt <path>] [--min-score 0] [--save]
  fullstackgtm icp eval [--golden <path>|default] [--against-outcomes] [--min-accuracy 0.8] [--json]
                                               build the ICP, then judge fresh signals into
                                               send/nurture/skip (timing × fit × memory). Deterministic
                                               baseline; LLM why-now + play with a key (gated verbatim).
                                               eval grades the judge and exits 2 below the bar — the
                                               probabilistic-judgment gate. Read-only; --save writes only
                                               the local judge store.
  fullstackgtm draft [--from-judge latest|<label>] [--min-score 80] [--prompt <path>] [--channel email|linkedin|task] [--save]
                                               author one trigger-grounded opener per hot judge decision as
                                               a governed create_task plan. First line must contain a
                                               verbatim span of the why-now or the draft is rejected. Never
                                               sends — --save stages a needs_approval plan for approve → apply.
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
  fullstackgtm reassign (--from <ownerId> | --assign-unowned) --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--except-deal-stage <stage>] [--include-closed-deals] [source options] [--save] [--json] [--out <path>]
                                               ownership handoff playbook: one bulk-update-style plan per
                                               object type (ownerId=<from> → <to>). --assign-unowned instead
                                               claims every ownerless record (ownerId:empty) for --to. Extra --where scoping
                                               is account-lifted for deals/contacts (domain~.de becomes
                                               account.domain~.de); --except-deal-stage <stage> excludes
                                               deals in that stage AND every record whose account has an
                                               open deal in it, re-verified per record at apply time.
                                               Deal plans cover open deals only unless
                                               --include-closed-deals.
  fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--today <iso>] [--yes|--confirm] [--dry-run]
                                               one-shot composite: audit ONE rule → save the plan →
                                               suggest values → approve only suggestion-backed operations
                                               meeting the confidence bar (plus operations that need no
                                               value) → with --yes (alias: --confirm), apply through the
                                               provider and print a stage-by-stage summary. Without --yes
                                               it stops after approval and prints the apply command;
                                               --dry-run locks that stop even if --yes is present.
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
  fullstackgtm plans list [--status <s>] | show <id> [--verbose] | sync | reject <id>
  fullstackgtm plans approve <id> --operations <ids|all> [--value <opId>=<v>]
  fullstackgtm plans approve <id> --values-from <suggestions.json> [--min-confidence high|low] [--include-creates]
  fullstackgtm plans recover <id> --acknowledge-uncertain-writes
  fullstackgtm apply --plan-id <id> --provider <name> [--verbose|--json]
  fullstackgtm apply --plan-id <id> --channel outbox          (render approved openers; transmits nothing)
  fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [options]
  fullstackgtm audit-log export [--out <path>] | verify --in <path>   tamper-evident apply-run record
  fullstackgtm rules [--json]
  fullstackgtm profiles [--json]               list credential profiles
  fullstackgtm doctor [--json]                 check install, credentials, and next step
  fullstackgtm capabilities [--json]           machine-readable CLI contract for agents
  fullstackgtm robot-docs                      print the shipped agent guide (SKILL.md)

Profiles (multi-organization use):
  --profile <name>       Scope credentials AND stored plans to a named profile
                         (also: FULLSTACKGTM_PROFILE). One profile per client
                         org keeps logins isolated and prevents a plan proposed
                         against one CRM from being applied through another's
                         credentials. Omitted = the default profile.

Plan lifecycle:
  audit --save persists the dry-run plan to ~/.fullstackgtm/plans. Approve
  specific operations (optionally with --value <opId>=<v> for placeholders),
  then apply by id — the store enforces approval and records every run. When
  paired, local and hosted are replicas of the same immutable plan: either
  capable surface may approve or apply, and each CLI check-in imports missing
  approvals and exact operation receipts. Use \`plans sync\` for an explicit
  check-in; offline changes reconcile later without blocking local work.

Authentication (checked in order):
  1. --token-env <name>        explicit env var for this invocation (hubspot)
  2. ambient env               HUBSPOT_ACCESS_TOKEN, or SALESFORCE_ACCESS_TOKEN +
                               SALESFORCE_INSTANCE_URL (CI, agent sandboxes)
  3. stored provider login     BYO direct credentials kept in ~/.fullstackgtm
                               (hubspot: --private-token or loopback OAuth;
                               salesforce: pasted token or device flow). These
                               direct credentials override broker-hosted tokens.
  4. hosted/broker login        fullstackgtm login hubspot|salesforce (or --hosted):
                               hosted browser OAuth stores a broker credential;
                               provider tokens are minted server-side. \`login --via
                               <url>\` pairs with an existing team deployment broker.

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
  --allow-plugins        Execute rulePackages from an explicit --config path after review
  --no-plugins           Ignore rulePackages; use declarative config and built-in rules only
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

export type HelpEntry = {
  summary: string; // one line, shown in the grouped map
  phase: string; // where the verb sits in Prevent→Detect→Remediate→Verify
  synopsis: string[]; // invocation form(s)
  detail?: string; // a sentence or two on behavior
  options?: Array<[string, string]>; // the flags that matter most
  seeAlso?: string[]; // related verbs to chain
};

// Exported as the CLI's single source of truth for the command inventory:
// `capabilities` and `--help --json` derive their command lists and
// read-only/write-shaped classification from this table (via each entry's
// `phase`) instead of maintaining parallel hand-written lists.
export const HELP: Record<string, HelpEntry> = {
  // Get started
  init: {
    summary: "scaffold a workspace (icp.json + enrich.config.json + PLAYBOOK)",
    phase: "Setup",
    synopsis: [
      "fullstackgtm init [--source pipe0|explorium|clay|linkedin] [--provider hubspot|salesforce] [--out <dir>] [--force]",
    ],
    detail:
      "Cold start: writes a starter ICP, an acquire-ready enrich.config.json (with a visible assign seam so leads are never ownerless), and a PLAYBOOK wired with the cold-start + outbound-loop recipes for this workspace. Pure file-writer — no network, keeps existing files unless --force. The CLI ships governed primitives; your coding agent is the orchestrator (see docs/recipes.md).",
    seeAlso: ["icp", "enrich", "signals"],
  },
  // Setup & health
  login: {
    summary: "connect a provider or LLM key (secrets via stdin/env, never argv)",
    phase: "Setup",
    synopsis: [
      "fullstackgtm login hubspot | salesforce          hosted browser OAuth (default)",
      "fullstackgtm login --via <hosted url>            pair with a team deployment",
      "fullstackgtm login stripe",
      "fullstackgtm login anthropic | openai | apollo | clay",
    ],
    detail:
      "HubSpot/Salesforce use hosted browser OAuth by default; BYO app/token paths are advanced. Secrets are NEVER passed as flags — pipe on stdin or enter at the prompt: `echo \"$TOKEN\" | fullstackgtm login hubspot --private-token`.",
    seeAlso: ["doctor", "logout", "profiles"],
  },
  logout: {
    summary: "remove stored credentials for a provider",
    phase: "Setup",
    synopsis: ["fullstackgtm logout <hubspot|salesforce|stripe|anthropic|openai|apollo|clay|pipe0|explorium|broker>"],
    seeAlso: ["login", "doctor"],
  },
  doctor: {
    summary: "check install, credentials, and the next step",
    phase: "Setup",
    synopsis: ["fullstackgtm doctor [--json]"],
    detail: "Verifies Node version, the credential store, MCP peers, and prints what to run next.",
    seeAlso: ["login", "audit"],
  },
  capabilities: {
    summary: "print the machine-readable CLI contract (JSON)",
    phase: "Setup",
    synopsis: ["fullstackgtm capabilities [--json]"],
    detail:
      "The agent front door: the command inventory with read-only vs write-shaped access (derived from this help table), the exit-code contract, safety defaults, and the MCP entrypoint — as JSON. Always prints JSON; --json is accepted for symmetry.",
    seeAlso: ["robot-docs", "doctor"],
  },
  "robot-docs": {
    summary: "print the shipped agent operating guide (SKILL.md)",
    phase: "Setup",
    synopsis: ["fullstackgtm robot-docs"],
    detail:
      "Prints the packaged skills/fullstackgtm/SKILL.md — the maintained agent guide (the governed loop, safety invariants, and verb map; the same content `npx skills add fullstackgtm/core` installs) — instead of a third parallel hand-written guide.",
    seeAlso: ["capabilities", "doctor"],
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
      ["--input <path>", "load a canonical GTM snapshot JSON file (from `snapshot --out`)"],
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

  hierarchy: {
    summary: "account hierarchy report (native parents + subdomain inference)",
    phase: "Prevent",
    synopsis: ["fullstackgtm hierarchy report [source options] [--json|--out <path>]"],
    detail:
      "Builds a report-only account tree from provider-native parent ids (when present in raw payloads) and deterministic subdomain inference. It surfaces duplicate-domain and ambiguous-parent conflicts instead of guessing writes.",
    seeAlso: ["route", "relationships"],
  },
  relationships: {
    summary: "relationship map for an account from contacts/deals/activity evidence",
    phase: "Prevent",
    synopsis: ["fullstackgtm relationships account (--account-id <id>|--domain <d>) [source options] [--json|--out <path>]"],
    detail:
      "Builds a stakeholder map with inferred buyer roles, sentiment from activity subjects, open deals, and missing-role gaps. Read-only evidence surface; no CRM writes.",
    seeAlso: ["call", "route"],
  },

  // Remediate — governed writes (all produce plans; nothing writes outside approve → apply)
  route: {
    summary: "lead-to-account matching and owner routing plan",
    phase: "Remediate",
    synopsis: ["fullstackgtm route leads [source options] [--match domain|company|both] [--no-inherit-owner] [--reassign-owned] [--policy <json|path>] [--save|--json|--out <path>]"],
    detail:
      "Matches contact-shaped leads to accounts by domain and/or company name, inherits account owners (or applies an assignment policy), and emits every change as a dry-run patch plan for approve → apply. Ambiguous matches are surfaced, never guessed.",
    seeAlso: ["resolve", "reassign"],
  },
  fix: {
    summary: "one-shot composite: audit one rule → suggest → approve → apply",
    phase: "Remediate",
    synopsis: ["fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--yes|--confirm] [--dry-run]"],
    detail:
      "The whole governed loop for a single rule in one command. Without `--yes` (alias: `--confirm`) it stops after approval and prints the apply command; with `--yes` it applies suggestion-backed operations meeting the confidence bar and prints a stage-by-stage summary. `--dry-run` locks the stop-before-apply path even when `--yes` is present.",
    seeAlso: ["audit", "suggest", "plans", "apply"],
  },
  // bulk-update previously had NO entry here even though shortUsage()'s
  // Remediate group listed it — the render loop silently skipped it, so the
  // front door never showed the verb and `help bulk-update` fell back to the
  // short map. The entry also completes the derived `capabilities` inventory.
  "bulk-update": {
    summary: "governed generic writes: filter the snapshot into a dry-run plan",
    phase: "Remediate",
    synopsis: [
      "fullstackgtm bulk-update <account|contact|deal> --where <expr> (--set <field>=<value> | --archive | --create-task <text>) [--save] …  (run `bulk-update --help` for full options)",
    ],
    detail:
      "Filters the snapshot (field=value, field~substr, field:empty, '|' = any-of; relational pseudo-fields like account.domain) into a dry-run patch plan. The full filter is re-verified per record at apply time, equality filters double as preconditions, and per-record ops apply all-or-nothing.",
    seeAlso: ["dedupe", "reassign", "plans", "apply"],
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
    synopsis: ["fullstackgtm reassign (--from <ownerId> | --assign-unowned) --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--save] [--json]"],
    detail:
      "Extra `--where` scoping is account-lifted for deals/contacts. `--except-deal-stage <stage>` excludes that stage and any record whose account has an open deal in it, re-verified per record at apply.",
    seeAlso: ["bulk-update", "plans", "apply"],
  },
  backfill: {
    summary: "Stripe paid invoices → closed-won deal proposals (governed)",
    phase: "Remediate",
    synopsis: [
      "fullstackgtm backfill stripe|runs [--since <iso>] [--pipeline <id|label>] [--match-property <name>] [--skip-unmatched] [source options] [--save] [--dry-run] [--json]",
    ],
    detail:
      "`backfill runs` replays LOCAL execution history to the paired hosted app (idempotent: deterministic run ids + server-side dedupe): every stored plan's apply runs and the health.jsonl timeline, so the hosted feed and Home health trend cover the engagement from its CLI-only beginning. Requires `login --via`; only what live reporting sends leaves the machine (statuses, counts, timestamps, scores — never CRM field values). `backfill stripe`: billing is the revenue source of truth — proposes ONE closed-won deal per paid Stripe invoice (amount = invoice total, close date = paid date, associated to the matched customer account, deduped by invoice id). Customers are matched to CRM accounts by domain, then exact name; a customer the CRM doesn't know gets an explicit proposed ACCOUNT create in the same plan (billing-email domain used unless it is freemail; a customer with no usable name/domain stays report-only; `--skip-unmatched` restores report-only for all unmatched). Emits a dry-run create_record plan — nothing is written until `plans approve` → `apply`, where the connector re-resolves each invoice id (and each account by domain/name) and creates only on a confirmed miss. Deal creation is HubSpot-only for now.",
    options: [
      ["--since <iso>", "only invoices created on/after this timestamp"],
      ["--pipeline <id|label>", "target deal pipeline (default: the portal's default pipeline)"],
      ["--match-property <name>", "deal dedupe property stamped with the invoice id (default stripe_invoice_id)"],
      ["--skip-unmatched", "do not propose accounts for unmatched customers (report-only, the pre-1.3 behavior)"],
      ["--provider <name>", "CRM snapshot to match against: hubspot | salesforce"],
      ["--input <path>", "match against a saved snapshot JSON instead of a live pull"],
      ["--save", "persist the dry-run plan for approve → apply"],
      ["--json", "machine-readable {plan, counts, unmatched, proposedAccounts} (stripe) or replay summary (runs)"],
      ["--dry-run", "(runs) count what would be replayed without sending anything"],
    ],
    seeAlso: ["enrich", "plans", "apply", "resolve"],
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
      "`parse` normalizes any transcript into canonical segments + evidence — chunked LLM extraction by default when a key resolves (ANTHROPIC_API_KEY/OPENAI_API_KEY or `login anthropic|openai`), free deterministic fallback when none does; `--heuristics` forces the deterministic engine, `--llm` forces the LLM path, model via `--model` or env FSGTM_INSIGHTS_MODEL. `classify` picks the call type, `score` rates it against the type's rubric, `link` finds the deal, `plan` proposes governed next-step writes.",
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
    summary: "replicated plan lifecycle: list / show / sync / approve / reject",
    phase: "Govern",
    synopsis: [
      "fullstackgtm plans list [--status <s>] | show <id> [--verbose] | sync | reject <id>",
      "fullstackgtm plans approve <id> --operations <ids|all> [--value <opId>=<v>]",
      "fullstackgtm plans approve <id> --values-from <suggestions.json> [--min-confidence high|low]",
      "fullstackgtm plans recover <id> --acknowledge-uncertain-writes",
    ],
    detail:
      "Approval is explicit and per-operation; placeholders need a concrete --value or a suggestion to be approvable. When paired, hosted and CLI are eventually consistent replicas of one immutable plan. `plans sync` explicitly exchanges approval revisions, execution state, and exact per-operation receipts; ordinary plan commands also check in best-effort. Either surface may apply when its CRM connector supports the selected operations.",
    seeAlso: ["audit", "suggest", "apply"],
  },
  apply: {
    summary: "write ONLY explicitly approved operations to a provider",
    phase: "Govern / Verify",
    synopsis: [
      "fullstackgtm apply --plan-id <id> --provider <name> [--verbose|--json]",
      "fullstackgtm apply --plan-id <id> --channel outbox   (render approved drafted openers to the outbox; transmits nothing)",
      "fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [--value <opId>=<v>]",
    ],
    detail:
      "The CLI CRM-write verb. Writes only operations approved locally or imported from the shared hosted replica, with an online execution claim when available, stable operation ids, compare-and-set, resolve-before-create, and readback. Default output is a compact outcome card; --verbose prints the full run document and --json preserves structured output. Hosted may execute the same synchronized plan when it has a compatible CRM connection; its exact operation receipts are imported on the next CLI check-in. Never writes requires_human_* placeholders without a --value override.",
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
    seeAlso: ["tam"],
  },
  tam: {
    summary: "size the reachable market from your ICP, then populate + track coverage",
    phase: "Intelligence",
    synopsis: ["fullstackgtm tam estimate|status|report|populate …  (run `tam --help` for full options)"],
    detail:
      "Estimate a defensible TAM from the ICP: a real account count (Explorium company count or --accounts) × a confirmed ANNUAL ACV (explicit --acv, or --acv-from-crm --deal-period to derive+annualize from closed-won — no band defaults, a bare --provider does NOT set ACV, refuses without one); buyers/account (explicit or CRM-derived) gives the contact target. Then iteratively fill it with scheduled `enrich acquire --save` runs (plan-only; apply stays gated). `status --save` stamps a coverage timeline so `report` projects how long full coverage will take.",
    seeAlso: ["icp", "enrich", "schedule", "market"],
  },

  // Outbound intelligence — signals → judge → draft (the GTM brain)
  signals: {
    summary: "detect fresh buying triggers (ATS hiring + source connectors), ranked",
    phase: "Detect",
    synopsis: [
      "fullstackgtm signals fetch [--bucket job,…] [--source greenhouse,lever,ashby] [--connector file,serpapi-news,hubspot-forms] [--connector-opt k=v] [--watchlist <path|crm:seg>] [--keywords …] [--from <file.json|spool.jsonl|spool-dir>] [--save]",
      "fullstackgtm signals list [--since 7d] [--bucket b] [--account d] [--unjudged]",
      "fullstackgtm signals outcome --account <d> [--touch <id>] --result replied|meeting|bounced|no_reply",
      "fullstackgtm signals weights [--explain]",
    ],
    detail:
      "Read-only re: CRM — `fetch` NEVER emits a patch plan; `--save` persists only the local signal ledger. ATS adapters are no-auth; source connectors (`--connector`) pull from connected platforms with secrets via the credential ladder, never argv. `outcome` feeds the learned per-bucket `weights`.",
    seeAlso: ["icp", "draft"],
  },
  icp: {
    summary: "build the ICP, then judge fresh signals into send/nurture/skip",
    phase: "Detect",
    synopsis: [
      "fullstackgtm icp interview | set <answers.json> | show",
      "fullstackgtm icp judge [--signals-from latest|<label>] [--with-history] [--prompt <path>] [--min-score 0] [--save]",
      "fullstackgtm icp eval [--golden <path>|default] [--against-outcomes] [--min-accuracy 0.8] [--json]",
    ],
    detail:
      "`judge` ranks unjudged signals by timing × fit × memory (deterministic baseline; LLM why-now + play with a key, gated verbatim). `eval` is the probabilistic-judgment gate — exits 2 below the bar. Read-only; --save writes only the local judge store.",
    seeAlso: ["signals", "draft", "enrich"],
  },
  draft: {
    summary: "author one trigger-grounded opener per hot decision as a governed plan",
    phase: "Remediate",
    synopsis: [
      "fullstackgtm draft [--from-judge latest|<label>] [--min-score 80] [--prompt <path>] [--channel email|linkedin|task] [--save]",
    ],
    detail:
      "Takes hot judge decisions (send, score>=min) and stages ONE create_task opener each. The first line must contain a verbatim span of the why-now or the draft is rejected. Never sends — --save stages a needs_approval plan for `plans approve` -> `apply`.",
    seeAlso: ["icp", "plans", "apply"],
  },
};

// Verbs that print their own richer multi-subcommand help; runCli routes their
// `--help` to themselves, so commandHelp() only renders these via `help <verb>`.
export const BESPOKE_HELP = ["init", "call", "market", "tam", "enrich", "schedule", "signals", "icp", "draft"];

export const GLOBAL_FLAGS = ["--help", "--full"];
export const GLOBAL_SHORT_FLAGS = ["-h"];
export const SOURCE_FLAGS = ["--provider", "--token-env", "--input", "--demo", "--sample", "--seed", "--today"];
export const AUDIT_FLAGS = ["--config", "--allow-plugins", "--no-plugins", "--rules", "--stale-days", "--fail-on", "--save", "--dry-run", "--json", "--out", "--full", "--verbose"];

// Complete per-command flag registry used by runCli's fail-closed flag
// validation. Keep this next to HELP so focused help, machine capabilities,
// and the parser safety gate have one command inventory to reconcile against.
export const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["--source", "--provider", "--out", "--force"],
  login: ["--via", "--hosted", "--private-token", "--token", "--key", "--api-key", "--client-id", "--client-secret", "--scopes", "--port", "--oauth", "--device", "--instance-url", "--login-url", "--no-validate"],
  logout: [],
  doctor: ["--verbose", "--json"],
  capabilities: ["--json"],
  "robot-docs": [],
  profiles: ["--json"],
  health: ["--json"],
  snapshot: [...SOURCE_FLAGS, "--since", "--out", "--archive"],
  audit: [...SOURCE_FLAGS, ...AUDIT_FLAGS],
  report: [...SOURCE_FLAGS, ...AUDIT_FLAGS, "--plan", "--client", "--title", "--prepared-by", "--format", "--max-examples"],
  diff: ["--before", "--after", "--config", "--allow-plugins", "--no-plugins", "--stale-days", "--today", "--json", "--fail-on-new-findings"],
  rules: ["--config", "--allow-plugins", "--no-plugins", "--json"],
  resolve: [...SOURCE_FLAGS, "--name", "--domain", "--email", "--account-id", "--json"],
  hierarchy: [...SOURCE_FLAGS, "--json", "--out"],
  relationships: [...SOURCE_FLAGS, "--account-id", "--domain", "--json", "--out"],
  route: [...SOURCE_FLAGS, "--match", "--no-inherit-owner", "--reassign-owned", "--policy", "--reason", "--max-operations", "--save", "--dry-run", "--json", "--out"],
  fix: [...SOURCE_FLAGS, "--config", "--allow-plugins", "--no-plugins", "--rule", "--provider", "--min-confidence", "--include-creates", "--yes", "--confirm", "--dry-run", "--verbose"],
  "bulk-update": [...SOURCE_FLAGS, "--where", "--set", "--guard", "--require", "--create-task", "--archive", "--force-archive-duplicates", "--reason", "--max-operations", "--save", "--dry-run", "--verbose", "--json", "--out"],
  dedupe: [...SOURCE_FLAGS, "--key", "--keep", "--reason", "--max-operations", "--save", "--dry-run", "--verbose", "--json", "--out"],
  reassign: [...SOURCE_FLAGS, "--from", "--assign-unowned", "--to", "--objects", "--where", "--except-deal-stage", "--include-closed-deals", "--reason", "--max-operations", "--save", "--dry-run", "--verbose", "--json", "--out"],
  backfill: [...SOURCE_FLAGS, "--since", "--pipeline", "--match-property", "--skip-unmatched", "--save", "--dry-run", "--verbose", "--json"],
  enrich: [...SOURCE_FLAGS, "--config", "--source", "--icp", "--input", "--provider", "--list", "--stale-days", "--assign-owner", "--objects", "--max", "--scan-limit", "--staged-run", "--run-label", "--label", "--runs", "--save", "--dry-run", "--verbose", "--json", "--out"],
  call: [...SOURCE_FLAGS, "--transcript", "--title", "--source", "--model", "--deterministic", "--heuristics", "--llm", "--verbose", "--json", "--ndjson", "--out", "--call", "--call-type", "--rubric", "--list", "--list-rubrics", "--attendees", "--domain", "--deal", "--save", "--dry-run"],
  suggest: [...SOURCE_FLAGS, "--plan-id", "--plan", "--json", "--out"],
  plans: ["--status", "--operations", "--value", "--values-from", "--min-confidence", "--include-creates", "--acknowledge-uncertain-writes", "--verbose", "--json"],
  apply: ["--plan", "--plan-id", "--provider", "--channel", "--token-env", "--approve", "--value", "--verbose", "--json", "--config"],
  "audit-log": ["--in", "--out", "--json"],
  merge: ["--input", "--out", "--json"],
  market: ["--category", "--config", "--vendor", "--snapshot", "--task-account", "--task-deal", "--capture-run", "--run", "--prior-run", "--diff", "--from", "--calls", "--anchor", "--min-mentions", "--max-claims", "--promote-lift", "--model", "--format", "--auto", "--unverified", "--save", "--dry-run", "--verbose", "--json", "--out"],
  tam: [...SOURCE_FLAGS, "--source", "--name", "--icp", "--accounts", "--acv", "--acv-basis", "--acv-from-crm", "--deal-period", "--buyers-per-account", "--cross-checks", "--max", "--max-credits", "--usd-per-credit", "--dry-run", "--confirm", "--cron", "--label", "--save", "--verbose", "--json", "--out"],
  icp: [...SOURCE_FLAGS, "--name", "--icp", "--domain", "--no-interactive", "--signals-from", "--with-history", "--prompt", "--min-score", "--from-judge", "--golden", "--against-outcomes", "--min-accuracy", "--model", "--label", "--save", "--verbose", "--json", "--out"],
  signals: ["--bucket", "--source", "--connector", "--connector-opt", "--watchlist", "--keywords", "--from", "--label", "--since", "--account", "--contact", "--unjudged", "--touch", "--result", "--save", "--verbose", "--json", "--explain"],
  draft: ["--from-judge", "--min-score", "--prompt", "--model", "--channel", "--save", "--dry-run", "--verbose", "--json", "--out"],
  schedule: ["--cron", "--label", "--provider", "--trigger", "--timer", "--runs", "--verbose", "--json"],
};

export const FLAGS_WITH_VALUES = new Set([
  "--account", "--account-id", "--accounts", "--acv", "--acv-basis", "--after", "--anchor", "--api-key", "--approve", "--archive", "--assign-owner", "--attendees", "--before", "--bucket", "--buyers-per-account", "--call", "--call-type", "--calls", "--capture-run", "--category", "--channel", "--client", "--client-id", "--client-secret", "--config", "--connector", "--connector-opt", "--contact", "--cron", "--cross-checks", "--deal", "--deal-period", "--diff", "--domain", "--email", "--except-deal-stage", "--format", "--from", "--from-judge", "--golden", "--guard", "--icp", "--in", "--input", "--instance-url", "--keep", "--key", "--keywords", "--label", "--list", "--login-url", "--match", "--match-property", "--max", "--max-claims", "--max-credits", "--max-examples", "--max-operations", "--min-accuracy", "--min-confidence", "--min-mentions", "--min-score", "--model", "--name", "--objects", "--operations", "--out", "--pipeline", "--plan", "--plan-id", "--policy", "--port", "--prepared-by", "--prior-run", "--profile", "--promote-lift", "--prompt", "--provider", "--reason", "--require", "--result", "--rubric", "--rule", "--rules", "--run", "--run-label", "--runs", "--scan-limit", "--scopes", "--seed", "--set", "--signals-from", "--since", "--snapshot", "--source", "--staged-run", "--stale-days", "--status", "--task-account", "--task-deal", "--timer", "--title", "--to", "--today", "--token", "--token-env", "--touch", "--transcript", "--trigger", "--usd-per-credit", "--value", "--values-from", "--vendor", "--via", "--watchlist", "--where",
]);

// Lifecycle-grouped front door. One line per verb, organized by the
// Prevent→Detect→Remediate→Verify loop so a new user sees ~6 jobs, not 22 verbs.
export function shortUsage() {
  const groups: Array<[string, string[]]> = [
    ["Get started", ["init"]],
    ["Setup & health", ["login", "logout", "doctor", "capabilities", "robot-docs", "profiles", "health"]],
    ["Detect — read-only", ["audit", "report", "snapshot", "diff", "rules", "hierarchy", "relationships"]],
    ["Prevent — gate writes", ["resolve"]],
    ["Remediate — governed writes", ["fix", "bulk-update", "dedupe", "reassign", "route", "enrich", "backfill"]],
    ["Calls → evidence", ["call"]],
    ["Govern — the plan/apply spine", ["suggest", "plans", "apply", "audit-log", "merge"]],
    ["Market intelligence", ["market", "tam"]],
    ["Outbound — signals → judge → draft", ["signals", "icp", "draft"]],
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

/**
 * Interactive-terminal styling for the short front door: a dimmed one-line
 * brand header (name · version · active profile), bold title and command
 * names, cyan lifecycle-group titles. Never applied to piped output — the
 * plain shortUsage() text stays byte-identical (and `capabilities` keeps
 * deriving from the HELP table, which this never touches).
 */
export function stylizeShortUsage(
  text: string,
  p: Paint,
  info: { version: string; profile: string },
): string {
  if (!p.enabled) return text;
  const lines = text.split("\n").map((line, index) => {
    if (index === 0) return p.bold(line);
    if (/^[A-Z][^:]*:$/.test(line)) return p.cyan(line);
    const row = line.match(/^  (\S+)(\s{2,})(.*)$/);
    if (row) return `  ${p.bold(row[1])}${row[2]}${row[3]}`;
    if (line.startsWith("Safety:")) return p.dim(line);
    return line;
  });
  return [p.dim(`fullstackgtm ${info.version} · profile ${info.profile}`), "", ...lines].join("\n");
}

// Focused help for a single command. Falls back to shortUsage() for anything
// unknown so `--help` never dead-ends on the full wall.
export function commandHelp(command: string) {
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

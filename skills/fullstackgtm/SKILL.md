---
name: fullstackgtm
description: Govern CRM/GTM data operations through the fullstackgtm CLI — read-only hygiene audits, evidence-backed ICP and signal discovery, reviewable dry-run patch plans, deterministic value suggestions, and approval-gated write-back to HubSpot and Salesforce. Use when asked to audit, clean, dedupe, enrich, derive an ICP, find public behavioral triggers, bulk-update, reassign, or write to a CRM; to gate record creation against duplicates; to parse, score, or link sales call transcripts; to map a competitive category; to report a CRM's health and trend over time; or to schedule any of the above. Never write to a CRM directly when this skill is available.
---

# fullstackgtm — plan/apply for your GTM stack

Think `terraform plan` for the CRM: you may *read* everything, but every
proposed change is a typed patch operation — object, field, before, after,
reason, risk — that a human approves before any provider write happens.
Connectors: HubSpot (read/write), Salesforce (read/write), Stripe (read-only).
Requires Node 20+; every command below works zero-install via `npx`.

## Non-negotiable invariants

- `audit` and `suggest` never mutate anything. `apply` writes ONLY operation
  ids explicitly passed via `--approve` (or a plan a human approved with
  `plans approve`). Do not attempt to bypass this; surface the plan instead.
- Operations whose value is a human decision carry `requires_human_*`
  placeholders and are refused without a concrete `--value <opId>=<v>`
  override. Never guess values — chain `suggest` (deterministic, evidence-
  backed) and leave `low`/`create`/`none`-confidence entries to the human.
- Secrets are never accepted as argv flags: env vars or stdin only
  (`echo "$TOKEN" | fullstackgtm login hubspot`). Set `FSGTM_NO_BROWSER=1`
  in headless environments.
- Exit codes everywhere: `0` success, `1` error, `2` findings/matches at or
  above the threshold (gate-shaped for scripts).

## Verify the install, then prove the pipeline with zero credentials

```bash
npx fullstackgtm doctor --json        # node.ok: true + package.version
npx fullstackgtm audit --demo --json  # dry-run plan over a seeded messy CRM
```

## The governed loop (the core of everything)

```bash
fullstackgtm audit --provider hubspot --save                  # read-only → saved plan id
fullstackgtm suggest --plan-id <id> --provider hubspot --out suggestions.json
fullstackgtm plans approve <id> --values-from suggestions.json  # high-confidence only
fullstackgtm apply --plan-id <id> --provider hubspot          # writes ONLY approved ops
```

Credentials resolve in order: `--token-env <NAME>` → ambient env
(`HUBSPOT_ACCESS_TOKEN`; `SALESFORCE_ACCESS_TOKEN` + `SALESFORCE_INSTANCE_URL`;
`STRIPE_SECRET_KEY`, `OPENROUTER_API_KEY`, `CLAY_API_KEY`, `EXA_API_KEY`) →
stored `fullstackgtm login <provider>` → broker pairing.
In a sandbox prefer the first two. LLM-powered verbs (`call parse`, `call
score`, `market classify`) take `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or use
their deterministic/worksheet fallbacks — the CLI never prompts when
non-interactive. `--profile <name>` (or `FULLSTACKGTM_PROFILE`) scopes
credentials AND stored plans per client org.

## Verb map

| Verb | What it does |
| --- | --- |
| `resolve <contact\|account\|deal>` | Create gate: exit 0 = safe to create, 2 = exists/ambiguous — never blind-create |
| `dedupe <object> --key <domain\|email\|name>` | One merge op per duplicate group, deterministic survivor; merges are irreversible |
| `bulk-update <object> --where … --set\|--archive\|--create-task` | Filtered dry-run plan; filter re-verified per record at apply time |
| `reassign --from <owner> --to <owner>` | Ownership handoff plans per object type; `--assign-unowned --to <id>` backfills every ownerless record |
| `fix --rule <id>` | audit one rule → suggest → approve at the confidence bar → apply only with `--yes` |
| `backfill stripe\|runs [--since <iso>] [--pipeline <id\|label>]` | Paid Stripe invoices → proposed closed-won deals (amount = invoice total, close date = paid date, company matched by billing-email domain then name); deduped by a `stripe_invoice_id` deal property re-resolved at apply, so re-running never double-creates; a customer the CRM doesn't know gets a proposed account create in the same plan (freemail domains never used; `--skip-unmatched` = report-only); `--save` → approve → `apply`. `backfill runs` replays LOCAL run history + health timeline to the paired hosted app (idempotent; `--dry-run` to preview) |
| `call parse\|score\|link\|plan` | Transcripts → evidence-quoted insights, rubric scorecards, deal linking, governed next-step writes |
| `enrich append\|refresh\|ingest\|status` | Governed enrichment (Apollo pull / Clay ingest), fill-blanks-only plans |
| `enrich acquire [--source clay\|explorium\|pipe0\|linkedin] [--company-domain <domain>] [--max <new>] [--scan-limit <raw>]` | Net-new ICP-targeted lead gen: Clay uses adaptive exact→relaxed searches while canonical local scoring remains the qualification gate; `--company-domain` constrains discovery to a named account; independent per-provider/list/query checkpoints traverse full audiences instead of rereading page one; paired CLIs CAS-sync opaque, non-PII continuation to the hosted org; resolve-first deduped `create_record` plans, meter-capped and owner-stamped; `enrich status --runs` exposes funnel + continuation; never auto-writes |
| `signals fetch\|discover\|list\|outcome\|weights` | Detect-side timing layer: capture fresh buying triggers into a profile-scoped ledger (free Greenhouse/Lever/Ashby watchlist scans; `discover --source exa --icp <path>` searches public evidence against ICP trigger hypotheses; `--from` staged files; `--connector file\|serpapi-news\|hubspot-forms` to pull connected platforms / read the webhook spool `<home>/signals/spool`, secrets via the credential ladder), ranked by learned weights. `--save` mirrors the evidence run to a human-paired hosted workspace for analysis while the local ledger stays authoritative. Writes NOTHING to the CRM; `outcome --account <domain> --contact <id> --result …` re-weights which triggers earn a touch |
| `icp derive\|interview\|set\|show\|judge\|eval` | `derive --domain <company.com> --out icp.json` builds an evidence-quoted, editable ICP plus behavioral trigger hypotheses; a paired CLI mirrors the reviewed derivation to the hosted workspace for analysis. `judge` ranks fresh signals into send/nurture/skip — pass a snapshot (`--provider`/`--input`) and each decision resolves its CRM target (`accountId` + the `contact`/`contacts` to reach). `eval` is the calibration gate (exit 2 below the bar) |
| `draft [--from-judge latest] [--channel email\|linkedin\|task]` | One trigger-grounded opener per hot account → a governed `create_task` targeting the resolved `contact.id` (or `accountId`); rejects a domain-only decision ("acquire it first"). **Never sends** — after `plans approve`, `apply --provider <crm>` logs it as a CRM task, or `apply --channel outbox` renders it to `<home>/signals/outbox/<channel>.jsonl` for a downstream sender to drain; the CLI transmits nothing |
| `market init\|capture\|classify\|worksheet\|observe\|fronts\|axes\|overlay\|scale\|report\|refresh` | Competitive category map; evidence quotes verified verbatim against stored captures |
| `tam estimate\|accounts\|status\|report\|populate` | Size the reachable market FROM the ICP (real account count × real ACV; buyers/account → contact target), then iteratively fill it: `populate` schedules plan-only `enrich acquire --save` (apply stays gated), `status` classifies CRM accounts vs the TAM ICP into **in-TAM / out-of-TAM / unknown** (only in-TAM counts — junk loaded from elsewhere doesn't inflate coverage; checked on size+industry, geo/tech need re-enrich) and flips to "estimate was a FLOOR, revise up" when bottom-up in-CRM exceeds the top-down estimate; `--save` stamps a timeline, `report` projects burn-up + ETA on the in-TAM rate. **`estimate --source theirstack`** counts companies that USE a CRM/MAP (`firmographics.technologies`) — the real RevOps universe — and **`tam accounts --source theirstack`** pulls the actual company LIST (names+domains, `--out csv`) at ~3 credits/company — `--dry-run [--usd-per-credit <r>]` prices the pull + full TAM for 0 credits, `--confirm` gates pulls above `--max-credits` (default 150). `--source explorium` = firmographic count only (no list, 60k cap = floor); else `--accounts`. **ACV must be a real ANNUAL figure you confirm** — `--acv <annual-usd>`, or `--acv-from-crm --deal-period monthly\|quarterly\|annual` (median closed-won, annualized); NO band defaults, a bare `--provider` does NOT set ACV (HubSpot=coverage), refuses without one. Buyers/account = CRM avg-contacts or explicit. Every number labeled with its source |
| `schedule add\|list\|remove\|enable\|disable\|run\|install\|uninstall\|status` | Horizontal cron; read/plan-side allowlist only — scheduling NEVER auto-approves |
| `report` | Client-ready audit deliverable (markdown or self-contained HTML) |
| `health [--json]` | Per-profile CRM health timeline: deterministic 0–100 score, trend, per-rule deltas — accrues from `audit --save`, read-only |
| `plans list\|show\|approve\|reject` / `snapshot` / `rules` / `doctor` | Plan lifecycle, raw snapshots, rule registry, machine state |

All write-shaped verbs produce plans; none writes outside approve → apply.
Add `--json` for machine-readable output on any command.

## MCP server (alternative surface, same gates)

```bash
npx -y fullstackgtm-mcp
```

Tools over stdio: `fullstackgtm_audit` (read-only), `fullstackgtm_rules`,
`fullstackgtm_suggest`, `fullstackgtm_call_parse`,
`fullstackgtm_apply` (stored `planId` only; approvals and values come from the
HMAC-signed plan store and cannot be supplied by the MCP caller),
`fullstackgtm_resolve`, `fullstackgtm_market_worksheet`,
`fullstackgtm_market_observe`.

MCP never executes rule packages or external plans. An uncertain apply is
never replayed automatically: reconcile provider state, then use
`fullstackgtm plans recover <id> --acknowledge-uncertain-writes`, which clears
approvals and requires a fresh review.

## Composing the primitives into plays

This CLI ships governed **primitives** — there is no `outbound` mega-command.
**You (the agent) are the orchestrator:** chain these verbs into the play the
operator wants, surface the one approve gate, and bridge the last mile to the
sender (**the package never sends**). [docs/recipes.md](https://github.com/fullstackgtm/core/blob/main/docs/recipes.md)
has five worked plays — cold-start lead-fill, the trigger→judge→draft outbound
loop, scheduled-continuous, ABM-from-companies, and hygiene-gated outbound.
`fullstackgtm init` scaffolds a workspace (icp.json + enrich config + a PLAYBOOK
pointing at those recipes) to start from.

## Going deeper

- [docs/recipes.md](https://github.com/fullstackgtm/core/blob/main/docs/recipes.md) — five composable GTM plays over the primitives (cold-start, outbound loop, scheduled, ABM, hygiene-gated)
- [llms.txt](https://github.com/fullstackgtm/core/blob/main/llms.txt) — the full invariant map per layer (calls, market, write verbs, enrich, schedule, engagement/health)
- [INSTALL_FOR_AGENTS.md](https://github.com/fullstackgtm/core/blob/main/INSTALL_FOR_AGENTS.md) — deterministic install-and-verify with expected outputs
- [docs/api.md](https://github.com/fullstackgtm/core/blob/main/docs/api.md) — semver-covered surfaces: canonical model, rule interface, plan/apply contract, connectors, config, CLI, MCP

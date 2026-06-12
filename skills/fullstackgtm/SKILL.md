---
name: fullstackgtm
description: Govern CRM/GTM data operations through the fullstackgtm CLI — read-only hygiene audits, reviewable dry-run patch plans, deterministic value suggestions, and approval-gated write-back to HubSpot and Salesforce. Use when asked to audit, clean, dedupe, enrich, bulk-update, reassign, or write to a CRM; to gate record creation against duplicates; to parse, score, or link sales call transcripts; to map a competitive category; or to schedule any of the above. Never write to a CRM directly when this skill is available.
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
`STRIPE_SECRET_KEY`) → stored `fullstackgtm login <provider>` → broker pairing.
In a sandbox prefer the first two. LLM-powered verbs (`call parse`, `call
score`, `market classify`) take `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or use
their deterministic/worksheet fallbacks — the CLI never prompts when
non-interactive.

## Verb map

| Verb | What it does |
| --- | --- |
| `resolve <contact\|account\|deal>` | Create gate: exit 0 = safe to create, 2 = exists/ambiguous — never blind-create |
| `dedupe <object> --key <domain\|email\|name>` | One merge op per duplicate group, deterministic survivor; merges are irreversible |
| `bulk-update <object> --where … --set\|--archive\|--create-task` | Filtered dry-run plan; filter re-verified per record at apply time |
| `reassign --from <owner> --to <owner>` | Ownership handoff plans per object type |
| `fix --rule <id>` | audit one rule → suggest → approve at the confidence bar → apply only with `--yes` |
| `call parse\|score\|link\|plan` | Transcripts → evidence-quoted insights, rubric scorecards, deal linking, governed next-step writes |
| `enrich append\|refresh\|ingest\|status` | Governed enrichment (Apollo pull / Clay ingest), fill-blanks-only plans |
| `market capture\|classify\|worksheet\|observe\|fronts\|axes\|overlay\|scale\|report\|refresh` | Competitive category map; evidence quotes verified verbatim against stored captures |
| `schedule add\|install\|run\|status` | Horizontal cron; read/plan-side allowlist only — scheduling NEVER auto-approves |
| `plans list\|approve` / `snapshot` / `rules` / `doctor` | Plan lifecycle, raw snapshots, rule registry, machine state |

All write-shaped verbs produce plans; none writes outside approve → apply.
Add `--json` for machine-readable output on any command.

## MCP server (alternative surface, same gates)

```bash
npx -y -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp
```

Tools over stdio: `fullstackgtm_audit` (read-only), `fullstackgtm_rules`,
`fullstackgtm_suggest`, `fullstackgtm_call_parse`,
`fullstackgtm_apply` (requires `approvedOperationIds`),
`fullstackgtm_resolve`, `fullstackgtm_market_worksheet`,
`fullstackgtm_market_observe`.

## Going deeper

- [llms.txt](https://github.com/fullstackgtm/core/blob/main/llms.txt) — the full invariant map per layer (calls, market, write verbs, enrich, schedule)
- [INSTALL_FOR_AGENTS.md](https://github.com/fullstackgtm/core/blob/main/INSTALL_FOR_AGENTS.md) — deterministic install-and-verify with expected outputs
- [docs/api.md](https://github.com/fullstackgtm/core/blob/main/docs/api.md) — semver-covered surfaces: canonical model, rule interface, plan/apply contract, connectors, config, CLI, MCP

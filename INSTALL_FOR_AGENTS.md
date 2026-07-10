# Installing fullstackgtm (for AI agents)

Deterministic install-and-verify steps. Every command is non-interactive, every
check has an expected output, and nothing here writes to a CRM.

If your harness supports agent skills, `npx skills add fullstackgtm/core`
installs the compact operating guide; this document remains the deterministic
install-and-verify path.

## 1. Install

```bash
npm install -g fullstackgtm
# or project-local: npm install fullstackgtm
# or zero-install: prefix the commands below with `npx`
```

Requires Node >= 20. No other runtime dependencies.

## 2. Verify

```bash
fullstackgtm doctor --json
```

Expect a JSON object with `node.ok: true` and `package.version` set. The
`providers` map shows `"source": "none"` for every provider on a fresh
machine — that is normal and does not block the next step.

## 3. First value, zero credentials

```bash
fullstackgtm audit --demo --json
```

Expect a JSON patch plan with `dryRun: true`, a non-empty `findings` array, and
matching proposed operations over a generated, deliberately messy CRM. The
exact count can grow as built-in rules are added; the stable contract is
determinism per release and seed. `--seed 7` is the default, so two runs on the
same version produce identical finding and operation ids. Exit code 0.

This proves the whole pipeline (snapshot → audit → plan) without any account.

## 4. Connect a real provider (requires a human or stored credentials)

Credential resolution ladder, first match wins:

1. `--token-env <NAME>` — explicit env var for one invocation
2. Ambient env: `HUBSPOT_ACCESS_TOKEN`, or `SALESFORCE_ACCESS_TOKEN` + `SALESFORCE_INSTANCE_URL`, or `STRIPE_SECRET_KEY`
3. BYO direct login: advanced token/OAuth paths stored locally; these override hosted
4. Hosted OAuth / broker: `fullstackgtm login hubspot` or `fullstackgtm login salesforce` (default browser OAuth; stores a broker credential and mints provider tokens server-side) or `login --via <hosted url>`

In an agent sandbox, prefer rung 1 or 2. If a human is at a browser, the next
command is usually `fullstackgtm login hubspot --hosted` or
`fullstackgtm login salesforce --hosted`. Never echo tokens into argv — BYO
secret paths read from stdin only. Set `FSGTM_NO_BROWSER=1` in headless
environments — login flows then print verification URLs instead of opening
the OS browser. First-party app secrets never ship in the npm package.

LLM calls (`call parse`, `call score`, `market classify`): set
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment, or have the human
run `echo "$KEY" | fullstackgtm login anthropic` once. Without a key, use
`call parse --deterministic` (free keyword baseline, no prompt) — or, for the
market map, classify it yourself: `fullstackgtm market worksheet --vendor <id>`
returns the claims, judging rules, and captured page texts; submit your
readings via `market observe --from <file>`. Quote evidence VERBATIM from the
page texts — every span is checked character-for-character against the stored
capture, and paraphrased quotes are rejected. In non-interactive contexts the
CLI never prompts — it fails with this guidance.

Apollo enrichment (`enrich append --source apollo`) needs `APOLLO_API_KEY` in
the environment, or have the human run `echo "$KEY" | fullstackgtm login apollo`
once. Without it, `enrich ingest <file> --source clay` still stages push-style
data keyless.

`enrich acquire` differs from `append`/`refresh`: instead of filling blanks on
existing records it creates net-new, ICP-targeted leads via governed
`create_record` plans (resolve-first dedupe re-checks the key at apply, never
double-creates) and is capped by a per-profile windowed meter bounding record
count and provider spend per day and per month. It still flows through
dry-run → approve → apply and never auto-writes — expect it to refuse rather
than silently exceed the meter.

Provider prerequisites for BYO fallback (what the human must create, and which
scopes) are in the README's **"Connect your CRM"** section: HubSpot private app
or BYO OAuth app scopes, Salesforce admin-created Connected App for device
flow, and Stripe restricted key (Customers + Subscriptions read). Hosted
HubSpot/Salesforce OAuth is the default when available.

```bash
HUBSPOT_ACCESS_TOKEN=$TOKEN fullstackgtm audit --provider hubspot --json --out plan.json
```

Exit codes everywhere: `0` success, `1` error, `2` findings at/above `--fail-on`.

## 5. Writes are approval-gated — by design

`audit` never mutates anything. `apply` writes only operation ids explicitly
passed via `--approve`, and refuses `requires_human_*` placeholder values
unless a concrete `--value <opId>=<v>` override is supplied. Do not attempt to
bypass this; surface the plan to a human instead:

```bash
fullstackgtm audit --provider hubspot --save     # persists plan to ~/.fullstackgtm/plans
fullstackgtm plans list                          # a human reviews and approves
```

For `requires_human_*` placeholders, chain the deterministic suggestion engine
instead of guessing values yourself:

```bash
fullstackgtm suggest --plan-id <id> --provider hubspot --out suggestions.json   # read-only
fullstackgtm plans approve <id> --values-from suggestions.json                  # high-confidence only
fullstackgtm apply --plan-id <id> --provider hubspot
```

Every suggestion carries a confidence (`high`/`low`/`create`/`none`) and a
reason derived from snapshot evidence. Surface `low`/`create`/`none` entries
to your human rather than widening the bar unilaterally — `create:<Name>`
values create a new CRM record when applied.

## 6. MCP server (optional)

The MCP entrypoint needs optional peers that plain `npx fullstackgtm-mcp`
does not install:

```bash
npx -y -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp
```

If the working directory's project already has the peers in its node_modules,
the server resolves them from there (peer-dependency semantics) — so this
works from inside existing projects too.

Tools exposed over stdio — read-only: `fullstackgtm_audit`,
`fullstackgtm_capabilities`, `fullstackgtm_rules`, `fullstackgtm_suggest`,
`fullstackgtm_call_parse`, `fullstackgtm_resolve`, `fullstackgtm_market_worksheet`. Gated:
`fullstackgtm_apply` (stored `planId` only; approvals and values must already be
human-approved and HMAC-signed in the local plan store),
`fullstackgtm_market_observe` (every quoted span is verified against the
stored captures before anything is appended).

MCP cannot execute rule packages, apply external plan files, or supply its own
approvals/value overrides. For an interrupted apply, reconcile provider state,
then run `fullstackgtm plans recover <id> --acknowledge-uncertain-writes`; this
replays nothing and clears approvals so a fresh review is required.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `fullstackgtm: command not found` | Re-run with `npx fullstackgtm`, or check global npm bin is on PATH |
| `No HubSpot credentials` (exit 1) | Set `HUBSPOT_ACCESS_TOKEN` or have a human run `fullstackgtm login hubspot --hosted` |
| MCP server prints peer-dependency help | Install `@modelcontextprotocol/sdk` and `zod` (see step 6) |
| Need machine state for orchestration | `fullstackgtm doctor --json` |
| Plan is `applying` after an interrupted request | Reconcile provider state, then run `fullstackgtm plans recover <id> --acknowledge-uncertain-writes`; review and approve again |

# fullstackgtm

[![CI](https://github.com/fullstackgtm/core/actions/workflows/ci.yml/badge.svg)](https://github.com/fullstackgtm/core/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/fullstackgtm)](https://www.npmjs.com/package/fullstackgtm) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**Plan/apply for your GTM stack.** An open-source framework for managing disparate go-to-market data spread across third-party systems: a canonical CRM/GTM data model, deterministic hygiene audits, reviewable dry-run patch plans, and approval-gated write-back to providers.

Think `terraform plan` for your CRM: agents and scripts may *read* everything, but every proposed change becomes a typed patch operation — object, field, before, after, reason, risk — that a human approves before any provider write happens.

Licensed under [Apache-2.0](./LICENSE). The boundary is deliberate and stable: the framework, CLI, and MCP server are open source; the hosted Full Stack GTM application (dashboard, sync backend, broker service, team workflows) is a separate, proprietary product built on top of this package. Features never move from open to closed. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how development and mirroring work.

**Status: beta (0.x).** The surfaces in [docs/api.md](./docs/api.md) — the canonical model, rule interface, plan/apply contract, connector contract, merge/diff, config, CLI, and MCP tools — are settling but may still break in minor releases until 1.0; the path there is [docs/roadmap-to-1.0.md](./docs/roadmap-to-1.0.md). The safety invariants (read-only audits, approval-gated writes, placeholder refusal) are not beta and do not change. Connectors: HubSpot (read/write), Salesforce (read/write), Stripe (read-only billing).

## Install

```bash
npm install fullstackgtm                    # library + CLI in a project
npx fullstackgtm audit --demo               # or zero-install via npx
npm install github:fullstackgtm/core        # or straight from this repo (project-local)
npx github:fullstackgtm/core audit --demo   # zero-install from the repo
```

(Global `npm install -g` from a git URL is unreliable on npm 11 — it symlinks into npm's temp cache. Use the registry for global installs, or the project-local/npx forms above.)

Requires Node 20+. The core has zero runtime dependencies; only the MCP server entrypoint uses the optional peers `@modelcontextprotocol/sdk` and `zod`.

```bash
npx fullstackgtm doctor   # verify the install: node version, credentials, MCP peers, next step
```

Installing for an AI agent? Hand it [INSTALL_FOR_AGENTS.md](./INSTALL_FOR_AGENTS.md) — a deterministic install-and-verify script with expected outputs. A documentation map lives in [llms.txt](./llms.txt).

## Five-minute loop

```bash
# 0. No credentials? Try it on a realistic, deliberately messy demo CRM
npx fullstackgtm audit --demo

# 1. Audit your real HubSpot portal (private app token or OAuth access token)
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm audit --provider hubspot --out plan.json

# 2. Review plan.json, then apply ONLY the operations you approve
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm apply \
  --plan plan.json --provider hubspot \
  --approve op_abc123,op_def456 \
  --value op_def456=2026-09-30
```

Nothing is ever written without an explicit `--approve`. Operations whose value is a human decision (`requires_human_*` placeholders, e.g. which owner to assign) are refused unless you supply a concrete `--value` override.

## Call workflows: calls become governed evidence

Calls are where pipeline truth lives. `call parse` normalizes any transcript dialect — `Speaker: text` lines (Fathom, Gong exports), `[Speaker]:` labels, or raw Granola utterance JSON — into canonical segments, insights, and `GtmEvidence` records.

**Extraction is LLM-powered by default, with your own key.** The first time you run `call parse` or `call score`, the CLI asks for an Anthropic or OpenAI API key (auto-detected from the prefix), validates it against the provider, and stores it in the 0600 credential store — same treatment as CRM logins. Or skip the prompt: set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or `echo "$KEY" | fullstackgtm login anthropic` (or `openai`). The key talks directly to your provider — raw fetch, no SDK, no middleman. `--model` overrides the defaults (claude-haiku-4-5 / gpt-4o-mini). LLM insights carry verbatim-quote evidence and, for next steps, owner/deadline/commitment. Pass `--deterministic` for the free, instant, byte-stable keyword baseline (no key needed — right for CI and warehouse bulk loads). Every insight is provenance-marked (`extractor: "llm:anthropic:…"` vs `"deterministic"`).

**`call score`** rates the call against a coaching rubric — five built-in dimensions (discovery, next steps, stakeholders, value, objections) or your own via `--rubric rubric.json` (`{ scale, dimensions: [{ name, weight, rubric }] }`); the weighted overall is computed deterministically client-side, every dimension score is evidence-quoted, and the rubric file is where your client-specific coaching framework lives.

`call link` answers "which deal was this call about" from attendee domains (account domain or contact emails → open deals, most recent activity first, with confidence + reason). `call plan` turns next-step insights into the same governed plan lifecycle as everything else.

```bash
# Coaching pipeline (Slack + CRM): parse → score → link → govern the writeback
fullstackgtm call parse --transcript call.txt --title "Acme disco" --out parsed.json   # LLM extraction
fullstackgtm call score --call parsed.json --rubric team-rubric.json                   # evidence-quoted scorecard
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
# Discover what the auditor checks
fullstackgtm rules --json

# Fetch once (expensive), audit offline as many times as you like (cheap)
fullstackgtm snapshot --provider hubspot --out snap.json
fullstackgtm audit --input snap.json --json
fullstackgtm audit --input snap.json --rules stale-deal --stale-days 45 --json

# Gate a nightly CI job or agent run on hygiene: exit 2 if findings ≥ threshold
fullstackgtm audit --provider hubspot --fail-on warning
```

- Finding and operation ids are **stable hashes** of rule + record, so two runs over the same data produce identical ids — agents can diff plans, track findings across runs, and approve operations by id without re-parsing.
- `--demo` (with `--seed`) generates a realistic mid-market CRM with injected real-world failure modes — departed owners, unlinked deals, orphan accounts, stale pipeline — so agents and CI can exercise the full snapshot → audit → apply pipeline with zero credentials.
- Exit codes: `0` success, `1` error, `2` findings at/above `--fail-on`.

## Authentication: CLI-first, browser only at the consent moment

Credential resolution is a ladder — the first rung that yields a token wins:

1. **`--token-env <NAME>`** — explicit env var for one invocation (agent sandboxes, scripts)
2. **`HUBSPOT_ACCESS_TOKEN`** — ambient env (CI)
3. **Stored login** — `fullstackgtm login hubspot`, kept in `~/.fullstackgtm/credentials.json` (0600; override location with `FSGTM_HOME`)
4. **Broker pairing** — `fullstackgtm login --via <hosted url>`: the team's deployment holds the CRM credentials; the CLI holds only a revocable pairing token

### Teams: auth once, point every CLI at the stored sync credentials

```bash
fullstackgtm login --via https://gtm.yourco.com
#   Pairing code: ABCD-2345
#   Approve this CLI in your dashboard: https://gtm.yourco.com/dashboard/cli-auth?code=ABCD-2345
```

An admin connects HubSpot **once** in the hosted dashboard (the org's OAuth tokens live encrypted in the deployment). Pairing a CLI is a device-flow handshake: the CLI prints a code, an admin or manager approves it in the dashboard, and the CLI receives a long-lived broker token (stored hashed server-side, revocable per CLI). From then on, every provider command silently exchanges the broker token for a short-lived CRM access token minted from the org's stored sync credentials — and inherits the org's field mappings. No one pastes CRM tokens; revoking a laptop is one row.

### Individuals: no deployment needed

```bash
# HubSpot, zero web flow: paste a private app token once (validated, then stored)
fullstackgtm login hubspot

# HubSpot, bring-your-own-app OAuth. The browser is used exactly once — the
# consent grant — captured on a 127.0.0.1 loopback (RFC 8252); the CLI
# exchanges the code itself and refreshes silently from then on. The client
# secret is read from stdin or an interactive prompt — never as a flag.
echo "$CLIENT_SECRET" | fullstackgtm login hubspot --oauth --client-id <id>
#   (register http://localhost:8763/callback as a redirect URL on your app)

# Salesforce: native device flow — confirm a code on any device, no localhost
# server, no client secret, silent refresh. Needs a Connected App consumer key
# with device flow enabled (see "Connect your CRM" below).
fullstackgtm login salesforce --device --client-id <consumer key>
# ...or a session token directly (token on stdin, never as a flag):
echo "$SF_SESSION_TOKEN" | fullstackgtm login salesforce --instance-url https://yourorg.my.salesforce.com

fullstackgtm logout hubspot   # or: salesforce | broker
```

A direct `login hubspot` always wins over a broker pairing, so an operator can override the team default. HubSpot does not support the device-authorization grant or secretless public clients, which is why the bring-your-own-app OAuth path requires client credentials; they are stored locally for silent refresh, the same model as `gcloud` and `aws` CLI profiles.

## Connect your CRM

What each provider actually requires before `audit --provider <name>` works on your data.

### HubSpot: create a private app (~2 minutes, needs super-admin)

1. In HubSpot: **Settings → Integrations → Private Apps → Create a private app.**
2. On the **Scopes** tab, grant the read scopes the audit needs:
   - `crm.objects.owners.read`
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
3. If you plan to **apply** approved operations (not just audit), also grant write scopes for the objects you'll let it touch: `crm.objects.deals.write` (covers `deal.next_step` and other deal fields), plus `crm.objects.contacts.write` / `crm.objects.companies.write` for contact/company patches, and the **Tasks** write scope for `create_task` operations (search "tasks" in the scope picker; naming varies by portal).
4. Create the app, copy the token (`pat-...`), then: `echo "$TOKEN" | fullstackgtm login hubspot`.

If a scope is missing you'll see a `403` mid-run whose body names the exact missing scope (`requiredGranularScopes`) — add it to the private app and re-run. Note that `login` only validates the token itself; it can't tell whether every scope you'll need is granted.

### Salesforce: a Connected App (one-time, usually needs an admin)

Device-flow login requires a Connected App in your org — if you're not an admin, this is the step to ask one for:

1. **Setup → App Manager → New Connected App**, enable OAuth settings.
2. Check **Enable Device Flow**.
3. OAuth scopes: **Manage user data via APIs (`api`)** and **Perform requests at any time (`refresh_token`)** — the CLI requests exactly these.
4. Save (Salesforce can take ~2–10 minutes to propagate a new Connected App), copy the **Consumer Key**, then: `fullstackgtm login salesforce --device --client-id <consumer key>`.

Writeback needs no extra OAuth scope — applies are gated by the logged-in user's normal object/field permissions.

### Stripe: a restricted key is enough (read-only connector)

The Stripe connector only reads customers and subscriptions, and `apply` is read-only by construction. Create a **restricted key** with just **Customers: Read** and **Subscriptions: Read** (Developers → API keys → Create restricted key) instead of pasting a full-access secret key: `echo "$KEY" | fullstackgtm login stripe`.

## Concepts

| Concept | What it is |
|---|---|
| **Canonical snapshot** | Provider-independent view of users, accounts, contacts, deals, activities. Records carry `identities` — `(provider, externalId)` claims — so the same real-world entity can be tracked across several systems. |
| **Audit rule** | A deterministic function `(context) => { findings, operations }`. Eleven built-ins cover orphan accounts, ownerless/unlinked/amount-less deals, past close dates, stale pipeline, duplicates, and more — `fullstackgtm rules` lists them all. Write your own in ~10 lines. |
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

# Zero-install
npx -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp
```

Add it to Claude Code in one command:

```bash
claude mcp add fullstackgtm -e HUBSPOT_ACCESS_TOKEN=pat-... -- npx -y -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp
```

Or configure any MCP client (Cursor, Claude Desktop, …) with:

```json
{
  "mcpServers": {
    "fullstackgtm": {
      "command": "npx",
      "args": ["-y", "-p", "fullstackgtm", "-p", "@modelcontextprotocol/sdk", "-p", "zod", "fullstackgtm-mcp"],
      "env": { "HUBSPOT_ACCESS_TOKEN": "pat-..." }
    }
  }
}
```

Exposes `fullstackgtm_audit` (read-only; sample, demo, file, or live provider sources with optional rule scoping), `fullstackgtm_rules` (rule discovery), and `fullstackgtm_apply` (requires explicit `approvedOperationIds`) over stdio. Tokens stored via `fullstackgtm login` are picked up automatically — the env var is only needed when no stored login exists.

## Safety model

1. Reads are safe by default; audits never mutate anything.
2. Every proposed write is a typed patch operation with before/after values, a reason, and a risk level.
3. `applyPatchPlan` enforces the contract for all connectors: only explicitly approved operation ids are written, placeholders require concrete override values, and every attempt produces a per-operation result record.

## Development

```bash
npm run build   # compiles src/ to dist/ (tsc, type declarations included)
```

Tests live in the repository root `tests/` directory and run with `npm test`.

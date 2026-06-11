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
# exchanges the code itself and refreshes silently from then on.
fullstackgtm login hubspot --oauth --client-id <id> --client-secret <secret>
#   (register http://localhost:8763/callback as a redirect URL on your app)

# Salesforce: native device flow — confirm a code on any device, no localhost
# server, no client secret, silent refresh. Needs a Connected App consumer key
# with device flow enabled.
fullstackgtm login salesforce --device --client-id <consumer key>
# ...or a session token directly:
fullstackgtm login salesforce --token <t> --instance-url https://yourorg.my.salesforce.com

fullstackgtm logout hubspot   # or: salesforce | broker
```

A direct `login hubspot` always wins over a broker pairing, so an operator can override the team default. HubSpot does not support the device-authorization grant or secretless public clients, which is why the bring-your-own-app OAuth path requires client credentials; they are stored locally for silent refresh, the same model as `gcloud` and `aws` CLI profiles.

## Concepts

| Concept | What it is |
|---|---|
| **Canonical snapshot** | Provider-independent view of users, accounts, contacts, deals, activities. Records carry `identities` — `(provider, externalId)` claims — so the same real-world entity can be tracked across several systems. |
| **Audit rule** | A deterministic function `(context) => { findings, operations }`. Five built-ins cover orphan accounts, ownerless deals, unlinked deals, past close dates, and stale pipeline. Write your own in ~10 lines. |
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

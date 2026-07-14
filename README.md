# fullstackgtm

[![CI](https://github.com/fullstackgtm/core/actions/workflows/ci.yml/badge.svg)](https://github.com/fullstackgtm/core/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/fullstackgtm)](https://www.npmjs.com/package/fullstackgtm) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**The open-source control plane and safety toolbox for AI agents working in your CRM.**

An agent can read HubSpot or Salesforce in seconds. The dangerous part is what happens next: duplicate creation, stale-data overwrites, unbounded batch edits, guessed owners, and writes nobody can reconstruct later.

fullstackgtm puts one governed contract between the agent and the CRM:

```text
source data → canonical snapshot → deterministic checks → patch plan → human approval → guarded apply → receipt
```

Every proposed change carries its before/after value, reason, risk, and stable operation ID. Nothing is written until specific operations are approved. At apply time, the connector re-checks identity, preconditions, and current provider state rather than trusting an old plan.

Think **`terraform plan` for your CRM**.

fullstackgtm is not another B2B database, autonomous SDR, or enrichment vendor. It is the provider-neutral control layer around those systems. HubSpot and Salesforce are the first write targets; Stripe, Apollo, Clay, ZoomInfo, Pipe0, Explorium, HeyReach, and other systems can supply evidence or source data without bypassing the same safety gate.

Open source under Apache-2.0. Beta (0.x): APIs may shift before 1.0; the safety invariants do not.

## Install

```bash
npx fullstackgtm audit --demo               # zero-install try-it path
npm install fullstackgtm                    # library + CLI in a project
npm install github:fullstackgtm/core        # or straight from this repo (project-local)
npx github:fullstackgtm/core audit --demo   # zero-install from the repo
```

Requires Node 20+. The core has zero runtime dependencies. The MCP entrypoint uses the optional peers `@modelcontextprotocol/sdk` and `zod`.

```bash
npx fullstackgtm doctor
```

Installing for an agent:

```bash
npx skills add fullstackgtm/core
```

See [INSTALL_FOR_AGENTS.md](./INSTALL_FOR_AGENTS.md) for deterministic install verification and [llms.txt](./llms.txt) for the machine-readable documentation map.

## The governed CRM loop

```bash
# 1. Read the CRM and produce a plan. This never writes.
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm audit \
  --provider hubspot --out plan.json

# 2. Review findings and proposed operations.
npx fullstackgtm plans show <plan-id>

# 3. Approve only the operations you intend to authorize.
npx fullstackgtm plans approve <plan-id> --operations op_abc123,op_def456

# 4. Apply the approved subset. Current provider state is checked again.
HUBSPOT_ACCESS_TOKEN=pat-... npx fullstackgtm apply \
  --plan-id <plan-id> --provider hubspot

# 5. Verify the signed execution record.
npx fullstackgtm audit-log verify
```

For an unsaved file plan, `apply --plan plan.json --approve <ids>` provides the same explicit operation selection. A `requires_human_*` placeholder is never executable until a concrete value is supplied.

## The safety contract

These rules apply across the CLI, library, scheduler, and MCP server:

1. **Read and plan by default.** Audits and previews do not mutate providers.
2. **Explicit authority.** Apply writes only approved operation IDs; approval is never inferred from a prompt.
3. **No guessed decisions.** Human placeholders require concrete value overrides.
4. **Resolve before create.** Domain, email, and open-deal identity gates stop duplicate creation.
5. **Compare before set.** Before-values and preconditions prevent silent stale-plan overwrites.
6. **Bound the blast radius.** Bulk operations support guards, filters, and operation caps.
7. **Record the outcome.** Every attempt returns applied, skipped, or failed receipts; audit logs are tamper-evident.
8. **Separate clients.** Profiles scope credentials, plans, enrichment state, and schedules to one organization.
9. **Never auto-approve.** Scheduled work may generate plans; it cannot grant itself authority to execute them.

## CRM safety toolbox

### Prevent

```bash
# Exit 0: safe to create. Exit 2: exists or ambiguous; do not create.
fullstackgtm resolve contact --email jane@acme.com --provider hubspot
fullstackgtm resolve account --domain acme.com --provider salesforce
```

Identity is based on normalized account domains, contact emails, and account + deal-name keys. Names alone are not identity. When the provider exposes record provenance, duplicate findings identify the writer that created them.

### Detect

```bash
fullstackgtm snapshot --provider hubspot --out snapshot.json
fullstackgtm audit --input snapshot.json --json
fullstackgtm audit --provider hubspot --fail-on warning
fullstackgtm diff --before old.json --after new.json --fail-on-new-findings
fullstackgtm health
```

Built-in deterministic rules cover duplicates, orphaned records, missing owners, unlinked or amount-less deals, stale pipeline, past close dates, and related hygiene failures. Stable finding and operation IDs make repeated runs diffable.

### Remediate

Every write-shaped command below produces a patch plan before it can execute:

```bash
fullstackgtm fix --rule missing-deal-owner --provider hubspot
fullstackgtm bulk-update deal --where "stage=closedwon" --where "amount:empty" \
  --set amount=from:account.annualrevenue --save
fullstackgtm dedupe account --key domain --keep richest --save
fullstackgtm reassign --from 411 --to 902 --except-deal-stage closing --save
fullstackgtm route --provider hubspot --save
fullstackgtm backfill stripe --save
```

Irreversible merges remain low-confidence-capped. Filters and guards are re-evaluated against live state during apply, so a record that stopped matching is skipped rather than clobbered.

### Govern third-party enrichment

Enrichment data never writes directly to the CRM. A source record is matched deterministically, mapped under a declared policy, and rendered as a reviewable diff. The current conflict policy is deliberately conservative: fill blanks, and refresh only fields the enrichment ledger proves it previously stamped.

```bash
# Apollo pull
fullstackgtm enrich append --source apollo --provider hubspot --save

# Clay export / push-style source
fullstackgtm enrich ingest clay.csv --source clay --provider hubspot --save

# Inspect source runs, stamps, and stale fields
fullstackgtm enrich status --runs
```

#### ZoomInfo as a governed source

fullstackgtm uses ZoomInfo's official [`gtm` CLI](https://github.com/Zoominfo/gtm-ai-cli) for read-only retrieval. ZoomInfo keeps ownership of OAuth, entitlements, and credit accounting; fullstackgtm keeps ownership of matching, policy, approval, CRM apply, and receipts. No ZoomInfo token is copied into the fullstackgtm credential store.

```bash
brew install zoominfo/gtm-ai/gtm-ai-cli  # or: npm install -g @zoominfo/gtm-ai-cli
gtm auth login
```

Declare ZoomInfo paths in `enrich.config.json` (the raw JSON record is retained as operation evidence):

```json
{
  "sources": { "zoominfo": { "kind": "api" } },
  "match": {
    "company": { "keys": ["domain", "name"], "onAmbiguous": "skip" },
    "contact": { "keys": ["email", "name"], "onAmbiguous": "skip" }
  },
  "fields": {
    "company": [
      { "crm": "employeeCount", "from": { "zoominfo": "attributes.employeeCount" }, "refresh": true },
      { "crm": "annualRevenue", "from": { "zoominfo": "attributes.revenue" }, "refresh": true }
    ],
    "contact": [
      { "crm": "title", "from": { "zoominfo": "attributes.jobTitle" }, "refresh": true },
      { "crm": "phone", "from": { "zoominfo": "attributes.phone" }, "refresh": true }
    ]
  },
  "policy": { "overwrite": "never", "defaultStaleDays": 90 }
}
```

Then preview or save the plan:

```bash
fullstackgtm enrich append --source zoominfo --provider hubspot
fullstackgtm enrich append --source zoominfo --provider hubspot --save
fullstackgtm enrich refresh --source zoominfo --provider hubspot --save
```

`ZOOMINFO_GTM_BIN` can point to a non-default `gtm` executable. Source retrieval can consume ZoomInfo bulk data credits even when the resulting FullstackGTM plan is only a dry run; use ZoomInfo admin credit limits and start with a small CRM snapshot. The CRM still receives no write until the plan is approved and applied.

### Verify and recover

```bash
fullstackgtm plans list
fullstackgtm plans show <id>
fullstackgtm plans approve <id> --operations <ids|all>
fullstackgtm plans reject <id>
fullstackgtm plans sync
fullstackgtm audit-log export
fullstackgtm audit-log verify
```

Stored plans are signed. Apply receipts preserve per-operation outcomes and provider record IDs. An interrupted provider attempt is not blindly replayed; reconcile provider state before issuing fresh authority.

## Connectors and authentication

| Provider | Read | Governed writes | Notes |
|---|---:|---:|---|
| HubSpot | Yes | Yes | OAuth/broker or private-app token |
| Salesforce | Yes | Yes | Field writes and Account/Contact merges; Opportunities cannot be merged |
| Stripe | Yes | No | Restricted read key; source for revenue backfill plans |
| Apollo | Source | No direct CRM write | API key; enrichment input |
| Clay | Source | No direct CRM write | CSV/webhook ingest or Public API |
| ZoomInfo | Source | No direct CRM write | Official `gtm` CLI OAuth; enrichment input |

Secrets are accepted through environment variables, stdin, the owner-only local credential store, or a paired hosted broker—never argv flags.

```bash
fullstackgtm login hubspot
fullstackgtm login salesforce --device --client-id <consumer-key>
echo "$HUBSPOT_TOKEN" | fullstackgtm login hubspot --private-token
echo "$APOLLO_API_KEY" | fullstackgtm login apollo

# Keep client credentials and plans isolated.
fullstackgtm --profile acme audit --provider hubspot --save
FULLSTACKGTM_PROFILE=acme fullstackgtm plans list
```

Run `fullstackgtm doctor --json` to inspect the active profile and credential state. Detailed provider setup and data flows: [DATA-FLOWS.md](./DATA-FLOWS.md).

## Built for agents

```bash
fullstackgtm capabilities --json
fullstackgtm audit --help --json
fullstackgtm rules --json
fullstackgtm robot-docs
```

Machine output is kept clean: progress stays on stderr, `--json` stays on stdout, IDs are stable, and exit codes are meaningful (`0` success, `1` error, `2` policy finding or create-gate match).

The safety surface has been benchmarked across models and providers. See the [evaluation methodology and results](https://github.com/fullstackgtm/core/blob/main/evals/crm/leaderboard/RESULTS.md) for the exact protocol and caveats.

## MCP server

```bash
# Zero-install wrapper with MCP peers bundled
npx -y fullstackgtm-mcp

# Or in a project
npm install fullstackgtm @modelcontextprotocol/sdk zod
npx fullstackgtm-mcp
```

Nine tools are exposed over stdio.

**Read-only:** `fullstackgtm_audit`, `fullstackgtm_capabilities`, `fullstackgtm_rules`, `fullstackgtm_suggest`, `fullstackgtm_call_parse`, `fullstackgtm_resolve`, and `fullstackgtm_market_worksheet`.

**Gated:** `fullstackgtm_apply` accepts only a stored plan ID whose operation approvals and values are already HMAC-signed in the plan store; `fullstackgtm_market_observe` verifies quoted evidence before storage.

The MCP caller cannot approve its own operations, inject an external plan, or execute rule-package code. See [docs/api.md](./docs/api.md) for the public contracts.

## Library

The framework-independent package exports the same canonical model, rule engine, plan contract, connectors, and apply orchestrator used by the CLI.

```ts
import { applyPatchPlan, auditSnapshot, createHubspotConnector } from "fullstackgtm";

const hubspot = createHubspotConnector({
  getAccessToken: () => process.env.HUBSPOT_ACCESS_TOKEN!,
});

const snapshot = await hubspot.fetchSnapshot();
const plan = auditSnapshot(snapshot); // read-only

// Later, after review:
const run = await applyPatchPlan(hubspot, plan, {
  approvedOperationIds: ["op_abc123"],
});
```

Implement another CRM by satisfying the `GtmConnector` contract. Add deterministic organization policy with a `GtmAuditRule`. Architecture and extension points are documented in [docs/architecture.md](./docs/architecture.md) and [docs/api.md](./docs/api.md).

## Appendix: additional modules and recipes

The package includes composable GTM workflows, but they are intentionally downstream of the control-plane story above. None bypasses the patch-plan safety contract.

- **Call evidence:** parse, classify, score, and link transcripts; convert next steps into governed CRM plans. Run `fullstackgtm call --help`.
- **ICP and net-new acquire:** discover, score, dedupe, meter, assign, and propose new contacts. See [docs/recipes.md](./docs/recipes.md).
- **Signals and drafting:** collect buying triggers, judge timing/fit, and produce governed task/outbox plans; the package never sends. See [docs/signal-spool-format.md](./docs/signal-spool-format.md) and [docs/outbox-format.md](./docs/outbox-format.md).
- **TAM:** estimate a transparent market model, populate it through governed acquire, and track coverage. See [docs/tam.md](./docs/tam.md).
- **Competitive market map:** capture and verify category evidence, classify messaging fronts, and generate reports. Run `fullstackgtm market --help`.
- **LinkedIn list intake:** read prebuilt HeyReach lists as a discovery source; no connect/message operation ships. See [docs/linkedin-connector-spec.md](./docs/linkedin-connector-spec.md).
- **Scheduling:** run read/plan-side commands continuously without auto-approval. Run `fullstackgtm schedule --help`.
- **End-to-end playbooks:** [docs/recipes.md](./docs/recipes.md).

## License, boundary, and development

Licensed under [Apache-2.0](./LICENSE). The canonical model, audits, patch plans, connectors, CLI, and MCP server are open source. The hosted Full Stack GTM dashboard, sync backend, broker, and team workflows are a separate proprietary product built on the package. Features never move from open to closed.

Public API stability and the open-core boundary are documented in [docs/api.md](./docs/api.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm run build
npm test
```

# Architecture

A one-page map for someone about to change this code. The companion
[api.md](./api.md) documents the contract surface by capability; this doc
documents the *layout* and *data flow*.

## The one idea

**Deterministic apply, governed suggest.** Everything that touches a CRM is
deterministic, replayable, and human-approved; anything that reads free text
(call transcripts, competitor pages) is LLM-powered but bounded — its quoted
evidence is mechanically verified against the source before it can drive a
write. Hold this line when adding features.

## Core data flow

```
provider  ──fetchSnapshot()──►  CanonicalGtmSnapshot
                                      │
                                      ▼
                        audit (rules.ts × audit.ts)
                                      │
                                      ▼
                               PatchPlan  (dry-run; typed operations)
                                      │  suggest.ts fills requires_human_* values
                                      ▼
                         plans approve  (planStore.ts + integrity.ts: HMAC-signed)
                                      │
                                      ▼
                    applyPatchPlan (connector.ts): for each APPROVED op —
                    compare-and-set vs live value, precondition + guard recheck,
                    irreversible-op drift guard → connector.applyOperation()
                                      │
                                      ▼
                               PatchPlanRun  (the audit record; auditLog.ts exports it)
```

## Module map (`src/`)

**Contracts & model**
- `types.ts` — the canonical data model and every load-bearing contract
  (`CanonicalGtmSnapshot`, `PatchPlan`/`PatchOperation`, `GtmConnector`,
  `GtmAuditRule`). Read this first; each field is documented with *why* it exists.
- `index.ts` — the public API manifest (one re-export block per module).

**Audit → plan → apply (the governed loop)**
- `rules.ts` — the 12 built-in deterministic audit rules + `GtmAuditRule` (the
  public extension point) + stable-id hashing.
- `audit.ts` — runs rules over a snapshot into a `PatchPlan`.
- `suggest.ts` — derives concrete values for `requires_human_*` placeholders from
  snapshot evidence, with confidence + reasons.
- `planStore.ts` — durable plan lifecycle (save / approve / record runs), 0600.
- `integrity.ts` — HMAC-signs approvals (per-install key) and verifies at apply.
- `connector.ts` — `applyPatchPlan`: the safety contract (approval filter,
  placeholder refusal, CAS, precondition/guard recheck, irreversible-op drift
  guard). Provider-agnostic.
- `auditLog.ts` — hash-chained, signed export of every apply run.

**Governed write verbs (each builds a plan; never writes directly)**
- `bulkUpdate.ts`, `dedupe.ts`, `reassign.ts`, `route.ts` — filtered,
  duplicate, ownership handoff, and lead-to-account/owner routing plan builders.
  `merge.ts` — snapshot diff/merge + entity resolution.
- `resolve.ts` — the create-gate (exists / ambiguous / safe_to_create).
- `hierarchy.ts`, `relationships.ts` — read-only account hierarchy and
  stakeholder relationship-map reports for planning/prevention workflows.

**Connectors** (`connectors/`)
- `hubspot.ts`, `salesforce.ts`, `stripe.ts` + their `*Auth.ts` OAuth/device
  flows. A connector implements `GtmConnector` (`fetchSnapshot`, optional
  `applyOperation`/`readField`/`fetchChanges`). `mappings.ts` holds field maps.

**Free-text layers (LLM-bounded)**
- `calls.ts` + `llm.ts` — transcript parse/score; LLM insights pass a verbatim
  span gate before becoming evidence/writes.
- `market*.ts` (`market.ts`, `marketClassify.ts`, `marketAxes.ts`,
  `marketOverlay.ts`, `marketScale.ts`, `marketReport.ts`) — the competitive
  market-map layer; classifications are verbatim-verified against captures.
- `backfill.ts` — Stripe paid invoices → proposed closed-won deal creates
  (domain-then-name account matching; unmatched reported, never auto-created).
- `enrich.ts` + `enrichApollo.ts` — third-party data enrichment (fill-blanks),
  plus `buildAcquirePlan` / `builtinAcquirePreset` for net-new lead generation.
- `icp.ts` — the Ideal Customer Profile artifact: per-provider discovery-filter
  translation, prospect fit scoring, and the agent-driven interview spec.
- `acquireMeter.ts` — per-profile windowed budget (records + spend) for acquire.
- `acquireSeen.ts` — cross-run "seen" cache so re-runs don't re-pay for dupes.
- `assign.ts` — `AssignmentPolicy` (fixed / round-robin / territory /
  account-owner): the pure owner-routing rule `buildAcquirePlan` stamps onto new
  leads (never born ownerless) and `reassign --assign-unowned` reuses to backfill.
- `connectors/prospectSources.ts` — API prospect sources (Explorium discovery,
  pipe0 work-email waterfall, pipe0/Crustdata search) + the pre-email dedup keys.

**Surfaces & infra**
- `cli.ts` — one async function per command, flat dispatch in `runCli`;
  orchestration only (all logic lives in the modules above). `bin.ts` is the
  entrypoint. `mcp.ts`/`mcp-bin.ts` — the MCP server (optional peers).
- `credentials.ts` — credential store (0600 file, or OS keychain via
  `keychain.ts` when `FSGTM_KEYCHAIN=1`); broker pairing client.
- `schedule.ts` — local cron provider (read/plan-side allowlist; never
  auto-approves). `report.ts`/`format.ts` — rendering. `config.ts`,
  `profiles.ts`, `sampleData.ts`.

## Where do I add…

- **a new audit rule** → implement `GtmAuditRule`, register it; see api.md
  "Write a custom rule". Add a `tests/fullstackgtm*.test.ts`.
- **a new connector** → implement `GtmConnector`; see api.md "Use a connector
  programmatically".
- **a new operation type** → extend `PatchOperationType` in types.ts, handle it
  in `connector.ts` apply + each connector's `applyOperation`, and decide its
  safety class (does it need CAS / a drift guard / approval signing coverage?).

## Tests as spec

`tests/fullstackgtm*.test.ts` (at the **monorepo root**, run from there) map
one-to-one onto modules; `fullstackgtmSecurity.test.ts` pins the safety
invariants. Change apply/connector/integrity code → run the security suite.

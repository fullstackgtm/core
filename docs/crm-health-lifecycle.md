# The CRM-health CRUD lifecycle: no new dupes

How fullstackgtm keeps a CRM healthy over time — not just episodically
audited. Grounded in dogfooding against a real portal (an outreach sync
tripled five open deals; our own `create:` path nearly minted a duplicate
company) and in what the platforms actually support today (verified 2026-06).

## The model: Prevent → Detect → Remediate → Verify/Attribute

Every mature dedupe stack (RingLead/ZoomInfo Ops, Insycle, Openprise,
Dedupely) converged on three layers, because each one leaks:

1. **Prevent** at write time — unique keys, upserts, point-of-entry gates.
   Leaks because: HubSpot does not dedupe companies created via API at all,
   deals have no native dedupe on any platform, and Salesforce duplicate
   rules skip standard lead conversion.
2. **Detect** continuously — scheduled scans, because prevention leaked.
3. **Remediate** via survivor-rule-driven merge — irreversible on both
   platforms, which is why preview/dry-run is table stakes.

fullstackgtm adds the layer the industry mostly lacks: **Verify/Attribute** —
typed, approved operations with compare-and-set, readback, drift diffs, and
record-source provenance that names *which writer* created the mess, so you
fix the faucet instead of mopping the puddle.

## C — Create: gate the faucet

**Platform facts to exploit before building anything:**

| | HubSpot | Salesforce |
| --- | --- | --- |
| Contacts | API create with existing email → **409 with existing ID** (a free find-or-create) | Duplicate Rules fire on API writes (`DUPLICATES_DETECTED`); Alert-action rules bypassable via `DuplicateRuleHeader`, Block never |
| Companies/Accounts | **No API dedupe** (UI/import domain-dedupe does not apply to API) | Same duplicate-rule machinery |
| Deals/Opps | **No native dedupe anywhere** | No standard duplicate rule shipped |
| Idempotent writes | `batch/upsert` keyed on unique-value custom properties (≤10/object) | Upsert by External ID field — explicitly idempotent |
| Leak paths | API company creates; anything without email | Standard lead conversion, Quick Create, undelete |

**Our primitives and their duties:**
- `create:<Name>` link values must be **resolve-first**: search the live CRM
  (and the current plan run) for an existing record before creating; link to
  a unique match, refuse on ambiguity, create only on a confirmed miss.
  HubSpot's search API is eventually consistent (~5–10s), so same-run
  creations are deduped in memory, not via search.
- A standalone **`resolve` gate** (planned, 0.13): given a candidate
  record, return existing match(es) or "safe to create" — for the CLI, the
  library, MCP, and any external writer (sync jobs, agents, webhook
  handlers). Identity keys are the ones the package already uses:
  contact email, normalized account domain, and the open-deal key
  (account + normalized name).
- **Stamp provenance on our own creates** (HubSpot allows integrations to
  set `hs_object_source_detail_2/3` at create time).
- Recommend native config in `doctor`/audit: Salesforce duplicate rules
  active? HubSpot unique-value properties defined? Prevention posture is
  auditable configuration, not just record state.

## R — Read: watch continuously, attribute the source

- The regression primitive exists: `fullstackgtm diff --before a.json
  --after b.json --fail-on-new-findings` exits 2 when a (rule, record) pair
  fires that didn't before. "New" is a stable finding id — the hash of
  (ruleId, objectId).
- **The nightly watch recipe** ("CRM CI"): scheduled
  `snapshot → audit → diff` against yesterday's snapshot, alert on exit 2.
- **Attribution** (planned, 0.13): capture HubSpot's read-only
  `hs_object_source`, `hs_object_source_label`, `hs_object_source_id` into
  the canonical model so duplicate findings can say *"all five created by
  integration X"*. The fix for recurring dupes is upstream, in the writer.
- Incremental reads (`snapshot --since`) exist for all three connectors;
  caveats: HubSpot deltas carry no associations and cap at 10k per object,
  Stripe deltas catch creations only.

## U — Update: governed merge

**Platform facts:** HubSpot's v3 merge endpoint
(`POST /crm/v3/objects/{type}/merge`) supports contacts, companies,
**deals**, and tickets today (the 2019 "no deal merge API" changelog is
obsolete). Merges are pairwise, the loser is auto-archived, primary's
values win, **merges cannot be undone**, and a record stops merging after
250 cumulative merges. Salesforce merge is SOAP/Apex only (no REST), only
Lead/Contact/Account/Case, max 3 records per call.

**The gap:** our three duplicate rules (`duplicate-account-domain`,
`duplicate-contact-email`, `duplicate-open-deal`) detect groups but emit
only merge-review *tasks* — detection without remediation.

**The plan (0.12):** a `merge_records` operation type —
`requires_human_survivor_selection` placeholder, survivor heuristics in
`suggest` (ordered, evidence-based: most engagements → oldest → most
complete, each with a written reason), high risk, approval required, with
the irreversibility called out in the plan text. The dry-run plan is the
preview every commercial tool charges for; the pre-apply snapshot is the
loser-record archive. HubSpot first; Salesforce merge documented as
unsupported until an Apex path justifies itself.

## D — Delete/Archive: the exit ramp

- `archive_record` exists in both connectors (HubSpot DELETE = archive,
  restorable ~90 days; Salesforce DELETE = recycle bin) but no built-in
  rule emits it. It is the endpoint for reviewed orphans; merge losers are
  archived by the merge APIs themselves.
- All destructive operations stay high-risk, approval-required, and behind
  compare-and-set where the platform exposes a readable before-value.

## Write-path integrity rules (our own faucet)

Lessons from auditing our own apply path:

1. Field writes (`set_field`/`clear_field`/`link_record`) are protected by
   compare-and-set: the live value is read back and a drifted value returns
   `conflict` without writing.
2. CAS is only as good as `readField` — for HubSpot deals, `accountId` is
   an association, not a property, and must be read via the associations
   API or CAS silently passes on replay (fixed in 0.11.1).
3. `create:` values are resolve-first and deduped within a plan run
   (0.11.1); `create_task` operations carry an idempotency token in the
   task body and pre-check for it (0.11.1, fail-open on search errors).
4. Plan replays are blocked at the store (`--plan-id` of an applied plan
   refuses); the `--plan <file>` path relies on CAS — prefer the store.

## The operating cadence

**Gate** creates (resolve-first, upserts, native rules on) →
**Watch** nightly (snapshot, diff, exit-2 alert) →
**Fix** governed (audit → suggest → approve → apply, incl. merge) →
**Verify** (readback, re-audit, drift report) →
**Attribute** (provenance names the writer; fix the faucet).

## Build order

| Release | Scope |
| --- | --- |
| 0.11.1 | Fix our own faucet: resolve-first `create:` + plan-scoped dedup, HubSpot association-aware CAS for `link_record`, domain normalization in `duplicate-account-domain`, `create_task` idempotency token |
| 0.12 | `merge_records` (HubSpot contacts/companies/deals) + survivor suggestions; rules emit governed merges for dupe groups |
| 0.13 | `resolve` gate (CLI/lib/MCP), provenance capture + attribution in findings, prevention-posture checks |
| docs | The nightly watch recipe (existing flags, documented as CRM CI) |

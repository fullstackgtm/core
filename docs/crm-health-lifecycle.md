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
- The **`resolve` gate** (shipped 0.15): `fullstackgtm resolve
  <account|contact|deal>` returns exists/ambiguous/safe_to_create with
  matches and reasons; exit 0 = safe, exit 2 = do not create. Same identity
  keys as the audit/merge engines. Also `resolveRecord()` and MCP
  `fullstackgtm_resolve`.
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
- **Attribution** (shipped 0.15): snapshots capture HubSpot's read-only
  `hs_object_source*` into `RecordProvenance`; duplicate findings append
  *"Created by: …"* naming the writer(s). The fix for recurring dupes is
  upstream, in the writer.
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

**The gap (closed in 0.12):** our three duplicate rules
(`duplicate-account-domain`, `duplicate-contact-email`,
`duplicate-open-deal`) used to detect groups but emit only merge-review
*tasks* — detection without remediation.

**Shipped (0.12):** a `merge_records` operation type —
`requires_human_survivor_selection` placeholder, survivor heuristics in
`suggest` (ordered, evidence-based: most engagements → oldest → most
complete, each with a written reason), high risk, approval required, with
the irreversibility called out in the plan text. The dry-run plan is the
preview every commercial tool charges for; the pre-apply snapshot is the
loser-record archive. HubSpot first; Salesforce merge documented as
unsupported until an Apex path justifies itself. 0.23 added `dedupe` as a
first-class verb over the same operation type (groups → one governed merge
per group, deterministic survivor).

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
| 0.12 (shipped) | `merge_records` (HubSpot contacts/companies/deals) + survivor suggestions capped at low confidence; the three duplicate rules emit governed merges instead of review tasks |
| 0.15 (shipped) | `resolve` gate (CLI/lib/MCP, gate exit codes), provenance capture (`hs_object_source*` → `RecordProvenance`) + attribution in duplicate findings, self-stamped creates |
| 0.16 (shipped the market map instead) | prevention-posture checks (native duplicate rules active? unique-value properties defined?) and live targeted resolve lookups were slated here but did not ship — they remain future work; 0.16 went to the market map layer |
| 0.23 (shipped) | `dedupe <object> --key <domain\|email\|name>` — the Remediate layer as a first-class verb: duplicate groups by normalized identity key, one governed `merge_records` per group, deterministic survivor (`richest`/`oldest`) |
| 0.24 (shipped) | schedule layer — recurring Detect: the nightly watch recipe becomes a declared cadence (`schedule add "audit --provider hubspot --save" --cron "0 2 * * *"`); read/plan-side allowlist only, scheduling never auto-approves |
| docs | The nightly watch recipe (existing flags, documented as CRM CI) |

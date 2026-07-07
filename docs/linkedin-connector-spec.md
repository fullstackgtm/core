# `linkedin` connector — spec (Phase 1)

Status: scoped 2026-06-20. Decisions locked: **first slice = Phase 1 discovery,
dry-run; default provider = HeyReach.** Rationale + the full white-label
investigation that motivated owning this: see the LinkedIn connector research.

## Why this shape

The research verdict (≈85%): Gojiberry runs its **own** LinkedIn session-automation
stack — it is **not** white-labeling HeyReach/Unipile, so there is no upstream to
go "direct" to. But Gojiberry proves a small team can build the architecture, and
the *execution* layer is rentable. So FSGTM's play is: **rent execution
(HeyReach), own the targeting + scoring + plan/apply governance** — "governed
LinkedIn outbound," which nobody else has.

This does **not** rebuild anything. The in-flight `enrich acquire` pipeline
already is the spine:

```
Icp → discovery source (Explorium/pipe0/Clay) → scoreProspectAgainstIcp
   → partitionFreshProspects (dedup vs CRM + acquireSeen) → create_record op
   → acquireMeter budget cap → approve → apply
```

LinkedIn is just a **new discovery source** on that spine.

## Phase 1 deliverable: `enrich acquire --source linkedin` (dry-run)

ICP → LinkedIn people-search via HeyReach → `Prospect[]` → ICP-scored → deduped →
**dry-run `create_record` plan** (no `--save` ⇒ nothing written, zero send/ToS
exposure). Net-new code is small; scoring/dedup/metering/apply are reused.

### Components
- **`src/connectors/linkedin.ts`** (mirrors `prospectSources.ts`):
  - `icpToLinkedInFilters(icp)` — `Icp` → LinkedIn/Sales-Nav search params (mirror
    of `icpToExploriumFilters` / `icpToCrustdataFilters` in `icp.ts`).
  - `discoverProspects(provider, filters, max)` — search mode for Phase 1; returns
    the existing `Prospect` type so everything downstream is free.
- **`LinkedInProvider` interface** (injectable, like `CrontabIo`): default
  **HeyReach** adapter (`searchLeads` / lead-list pull), plus a **`FakeLinkedInProvider`**
  for tests so the whole pipeline runs with no key and no network.
- **`builtinAcquirePreset('linkedin')`** — zero-config source preset (match-key
  email/linkedinUrl; cost-per-record for the meter).
- **Wiring**: register `linkedin` in the `enrich acquire` source switch; add to
  the source allowlist + help; `login heyreach` (or `HEYREACH_API_KEY`) for the key.

### Reused as-is (no change)
`scoreProspectAgainstIcp`, `partitionFreshProspects`, `acquireSeen`,
`acquireMeter` (records/day+month, cost/record), the `create_record` op + apply
path, the dry-run→approve→apply gate.

## Out of scope for Phase 1 (explicit)
- **No sending.** `linkedin_connect` / `linkedin_message` operations, the
  per-sender safety meter, and HeyReach webhook ingestion are **Phase 2**.
- Engagement-signal capture (Gojiberry-style intent from who-engaged-our-posts)
  is a Phase 1.5 add to `discoverProspects` once search mode is trusted.
- Not our own automation engine; not the official LinkedIn API; not multi-channel.

## Provider: HeyReach
Behind `LinkedInProvider` so we are not locked in (Unipile = documented
alternative: cheaper raw search/profile, multi-channel). HeyReach chosen for the
full Campaign API + webhooks + sender rotation + built-in per-account caps (the
Phase 2 ban-safety primitives we will want). ToS/ban risk sits on the connected
LinkedIn account — same posture as Gojiberry today.

## Build sequencing (IMPORTANT)
The acquire spine (`icp.ts`, `prospectSources.ts`, `acquireMeter.ts`,
`acquireSeen.ts`) is **uncommitted, actively-edited working-tree code** (not on
main). Building the acquire-source wiring on top of it is expansion on an
unstable base. Therefore:

1. **Buildable now (self-contained, no dep on the uncommitted acquire internals):**
   `LinkedInProvider` interface + HeyReach adapter (coded to HeyReach's documented
   API) + `FakeLinkedInProvider` + `icpToLinkedInFilters` + unit tests against the
   fake.
2. **After the acquire workstream commits/lands:** wire `enrich acquire --source
   linkedin` end-to-end and add the dry-run integration test.
3. **Live validation** needs a HeyReach trial API key supplied by the operator — the fake
   covers everything up to the real network call.

## Phase 2 (future, recorded for continuity)
Governed outbound: `linkedin_connect`/`linkedin_message` as `PatchOperation`s
(objectId = contact, afterValue = body, approvalRequired, `groupId` = sequence
all-or-nothing, `preconditions` = not-already-connected); `applyOperation`
dispatches `linkedin_*` to the provider; per-sender-account daily caps via the
`acquireMeter` pattern (ban-safety encoded as governance); HeyReach webhooks →
CRM activity + intent signal. This is the differentiated surface.

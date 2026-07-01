# TAM mapping — size the reachable market, then fill it

`tam` answers a longer-horizon question than `market` (the competitive map): **how
big is the reachable market for my ICP, and how far along am I in actually putting
it in the CRM?** It is deliberately *not* a one-shot "$10B TAM" headline — it pairs
a defensible estimate with an iterative, governed population loop and a coverage
timeline so "this will take a while" becomes a quantified ETA.

```
tam estimate  → tam populate  → (approve/apply each cycle)  → tam status --save  → tam report
   model           schedule          governed acquire             coverage point      burn-up + ETA
```

## The model

`tam estimate` derives the universe **from your ICP** (`icp.json`):

```
universe accounts = a real count for the ICP filter
contacts (population target) = accounts × buyers/account
TAM $ = accounts × ACV            (account/per-logo basis — the default)
       = contacts × ACV           (buyer/per-seat basis, --acv-basis buyer)
```

The account count comes from one of three places, always **labeled** in the model:

- `--source theirstack` — **the real, technographically-targeted universe** (and the
  only one that returns an actual list). TheirStack counts companies that *use* a
  CRM/MAP — set `firmographics.technologies` (e.g. `["salesforce","hubspot",
  "pipedrive"]`) — plus geo + employee bounds. `accountsSource:
  "provider:theirstack (uses-CRM)"`. This is the buying signal for a CRM-hygiene/
  RevOps tool: "company runs a CRM", not "company is a software publisher". **And
  `tam accounts --source theirstack` pulls the actual company list** (real names +
  domains) you can review, save (`--out <csv>`), and acquire into the CRM.
  (Counting is cheap but **not free** — TheirStack rejects `limit:0`, so a count
  returns 1 row ≈ 3 credits; a list pull is ~3 credits/company. `login theirstack`.)
- `--source explorium` — a firmographic **company count** from Explorium
  `/v1/businesses` (geo + employee bands + NAICS). A count only — **Explorium 403s
  when you try to pull the list**, and it can't target by CRM-usage, so it's a rough
  size estimate, not a list. `accountsSource: "provider:explorium"`.
- `--accounts <n>` — an explicit assumption (e.g. a number from a provider export).
  `accountsSource: "assumption"`.

  > **Why technographic, and why a count isn't enough** (verified live, 2026-06-25/26):
  > lead/people endpoints don't report a real universe — Explorium `/v1/prospects`
  > `total_results` equals the requested page size (1→1, 10→10), and pipe0/Crustdata
  > returns only a pagination cursor with no total. Explorium `/v1/businesses` counts
  > companies (e.g. US mid-market software ≈ 19,000) — **as long as you don't send a
  > `size` field, which silently caps the total** — but it can't filter by CRM-usage
  > and **403s when you try to pull the list**. TheirStack is the technographic
  > source that does both (target by tech, return real records). pipe0 stays a
  > discovery/population source (`tam populate`), not a counting one; `--source pipe0`
  > for `estimate` is rejected with that explanation.

  Explorium caps `total_results` at **60,000** (a `provider:explorium (≥60k cap —
  floor)` label + a ⚠). TheirStack has no such cap but list-pull costs credits, so
  `tam accounts --max <n>` pages it.

### List-pull cost (never spend by surprise)

`tam accounts` pulls real records at **~3 TheirStack credits/company**, so it always
prints the cost up front and guards big pulls:

- `tam accounts --dry-run [--usd-per-credit <rate>]` — prices the pull AND the full
  TAM (e.g. *"up to 100 companies ≈ 300 credits. Full TAM (~43,517) ≈ 130,551
  credits (~$5,483) to materialize."*) and spends **0 credits**. The dollar figure
  appears only when you give a rate — TheirStack pricing is ~$0.04–$0.11/credit by
  tier, and the tool won't fabricate a default.
- A pull above `--max-credits` (default **150** ≈ 50 companies) requires `--confirm`
  — so a large pull is always a deliberate choice, not an accident.

So the natural pattern is **count freely, pull in confirmed batches** (`--max N`),
acquire, measure coverage, repeat — rather than one large up-front spend.

**ACV must be a real, ANNUAL figure that you confirm** — never a band default, and
never silently lifted from the CRM. `--provider` is your **coverage** source, not
your ACV: the account universe is Explorium, coverage is the CRM, and the TAM's
economics are yours to confirm. Two confirmed paths, always labeled (`acv.source`):

- `--acv <annual-usd>` — your confirmed annualized ACV (`source: "explicit (annual)"`).
- `--acv-from-crm --deal-period monthly|quarterly|annual` — derive the **median
  closed-won deal amount** and **annualize** it by the period you specify
  (`source: "crm:closed-won (N deals, median $X/monthly ×12 = annual)"`). The period
  is **required** because a deal amount can be MRR, quarterly, or annual — guessing
  it is a 4–12× error (a $15k/mo deal is a $180k ACV). The deal count is in the
  label, so a thin signal (e.g. "1 deal") is visible — don't over-trust it.

If you give neither, `estimate` errors rather than invent a number — and a bare
`--provider` does NOT auto-set ACV.

**Buyers/account** (the contact population target = accounts × buyers) gets the same
treatment: `--buyers-per-account <n>`, else the CRM's **average contacts per account**
(`crm:avg-contacts/account (N)`), else a clearly-labeled minimal assumption of 1
(`assumption:1-buyer`) — never a silent guess. `--acv-basis buyer` makes ACV per-seat
(TAM = contacts × ACV) instead of per-logo.

Optional citable **cross-checks** (`--cross-checks <file.json>`, an array of
`{claim, valueUsd?, sourceUrl, quote, asOf?}`) sit alongside the bottom-up number as a
top-down sanity check — the market-research flavor, evidence-attached.

`estimate` also records a **coverage baseline** (the CRM account/contact counts right
now, when a `--provider`/`--input`/`--demo` source is given) so `status` can attribute
what *this campaign* added versus what was already there.

## Populate it (governed, never auto-writes)

`tam populate --cron "<expr>"` wires a recurring **`enrich acquire --source <s> --save`**
into the scheduler. Each firing queues a `needs_approval` lead plan — it does **not**
write to the CRM, and the acquire meter is charged only at apply. Apply stays a separate
human gate (`apply --plan-id <id>`, re-checked approved at every firing). So a scheduled
TAM populates by *accumulating proposals you approve*, never by surprise leads.

```bash
fullstackgtm tam populate --cron "0 7 * * 1-5" --source pipe0 --provider hubspot
fullstackgtm schedule install            # activate the crontab entry
# each cycle:
fullstackgtm plans list                  # the morning's lead plan
fullstackgtm plans approve <id> --operations all
fullstackgtm apply --plan-id <id> --provider hubspot
```

This is the one place the schedule allowlist permits a create-side verb, and only in
its plan-producing `--save` form (scheduling `enrich acquire` without `--save` is
rejected — it would queue nothing).

## Track coverage (where you're getting to)

Coverage is measured on the **intersection** of your CRM and the TAM's ICP — not a
raw account count. `tam estimate` stores the ICP filter on the model, and `tam
status` classifies every domain-bearing CRM account against it:

- **in-TAM** — matches every CRM-checkable criterion (size, industry) with no
  contradiction. *Only these count toward coverage.*
- **out-of-TAM** — contradicts a criterion (wrong size/industry). Reported
  separately; never inflates coverage. So 50k accounts loaded from other sources
  that aren't your target market don't fake a high number.
- **unknown** — the record lacks the fields to judge. Surfaced, never silently
  counted — it tells you what to enrich.

```bash
fullstackgtm tam status --provider hubspot --save     # classified coverage + a timeline reading
fullstackgtm tam report                                # markdown: model + in/out/unknown + burn-up + ETA
```

> **Honest limit:** geo and "uses a CRM" aren't on a CRM account record, so an
> in-TAM classification means "matches what the CRM lets us check" (size + industry),
> not a full technographic match. A `--reverify` pass (re-confirm geo/tech per
> domain via TheirStack) is planned; until then, status labels what it checked.

**Bottom-up vs top-down — squaring "more in CRM than estimated."** The estimate is a
*lower-bound prior*, not a ceiling — TheirStack only knows ~740k US firms, so your
multi-source CRM can legitimately hold more valid in-TAM accounts than it predicted.
Every in-TAM account is a *proven* member of the real market, so the in-TAM count is
the strongest floor on the true universe. When `in-TAM ≥ estimate`, `status` stops
reporting a fake "100%" and flips the signal: **"the estimate was a floor — your real
market is at least N; re-estimate (broader ICP / better source) to find the
headroom."** `reconciledUniverse = max(estimate, in-TAM)`.

Once two-plus readings show movement, `report`/`status` project an **ETA** on the
**in-TAM** burn rate (off-ICP accounts loaded elsewhere don't count as progress) →
days remaining → a projected fill date. Fewer than two readings, a flat rate, or no
elapsed time returns an honest "not enough history yet," never a fabricated date.

## Storage

Profile-scoped under `<home>/tam/<name>/`:

- `model.json` — the TAM model (universe, ACV, cross-checks, baseline). 0600.
- `coverage.jsonl` — append-only coverage readings (one per `status --save`). 0600.

Scope per client with `--profile <name>`; name multiple TAMs with `--name <n>`
(default `default`).

## Invariants

- **Estimate is honest about its source.** Every model says whether the account count
  is a `provider:*` probe or an `assumption`; the probe errors rather than silently
  guessing when the provider returns no count.
- **No fabricated economics.** ACV must be explicit or CRM-derived (closed-won) — there
  are no band defaults, and `estimate` refuses without a real ACV. Buyers/account and
  ACV both carry a `source` label so a thin signal is visible, never hidden.
- **Population never auto-writes.** `tam populate` schedules plan-only acquire; apply
  is a separate gate, the meter is charged only at apply, and the allowlist requires
  `--save`.
- **Coverage is deterministic** from the CRM snapshot + the model baseline — no LLM,
  byte-stable, comparable run-over-run.
- **ETA is refused when unprojectable** rather than faked.

## Library

`estimateTam`, `computeCoverage`, `coverageCountsFromSnapshot`, `projectEta`,
`tamReportToMarkdown`, the store (`saveTamModel`/`loadTamModel`/`appendCoverage`/
`readCoverageTimeline`), the count probe (`probeExploriumBusinessCount` +
`EXPLORIUM_BUSINESS_COUNT_CAP`), and the ICP→firmographic filter
(`icpToExploriumBusinessFilters`) are all exported for programmatic use.

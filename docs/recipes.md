# Recipes — composing the primitives into GTM plays

fullstackgtm ships **governed primitives**, not a workflow engine. The
orchestrator is **your coding agent**: it composes these verbs into the play the
operator wants, surfaces the one human approval gate, and bridges the last mile
to the sender. There is deliberately no `outbound` mega-command — that would
hard-code one play when the value is that you assemble the play you need.

Every verb emits stable `--json`, names the object type it operates on, and
surfaces the join it traversed (`accountId` / `domain` / `contactId`), so chains
compose without hand-gluing the contact↔account relationship. Every write goes
through the same `dry-run → plans approve → apply` gate. **The package never
sends** — `draft` produces an approved *task/opener*; the actual send happens in
the operator's channel tool (HeyReach for LinkedIn, an email tool for email),
which the agent drives with the operator's credentials.

The data spine: a **contact** belongs to an **account** (`contact.accountId`); an
account is keyed by its **domain**. `signals`/`icp judge` watch account domains;
`acquire` creates contacts *and* their domain-stamped accounts, so an acquired
lead is immediately watchable. Keep that join in mind when chaining.

---

## Recipe 1 — Cold start: fill the CRM with targeted, owned, emailed leads

**Goal:** go from nothing to a CRM seeded with on-ICP contacts (and their
signal-watchable accounts).

```bash
# 1. Connect (secrets via stdin/env, never argv)
echo "$HUBSPOT_TOKEN"   | fullstackgtm login hubspot
echo "$PIPE0_KEY"       | fullstackgtm login pipe0        # work-email + company-domain resolution
echo "$EXPLORIUM_KEY"   | fullstackgtm login explorium    # net-new discovery (optional)

# 2. Build the ICP (the agent drives the interview — the CLI can't call AskUserQuestion itself)
fullstackgtm icp interview            # emits INTERVIEW_SPEC; agent asks the questions
fullstackgtm icp set answers.json     # writes ./icp.json
fullstackgtm icp show                 # renders the ICP + the per-provider discovery filters

# 3. Acquire — dry-run first (writes NOTHING), then approve + apply
fullstackgtm enrich acquire --source pipe0 --provider hubspot --json   # scored, deduped, metered create_record plan
fullstackgtm enrich acquire --source pipe0 --provider hubspot --save    # persist as needs_approval
fullstackgtm plans approve <plan-id> --operations all
fullstackgtm apply --plan-id <plan-id> --provider hubspot
```

**What lands:** net-new contacts, owner-stamped (never born ownerless), each
linked to a **domain-stamped account** (so `signals`/`judge` can watch it). The
run is **metered** (records + spend, per profile) and **resolve-first** (never
creates over a possible dup). The dry-run op reason names the account it will
create/link — review it before `--save`.

---

## Recipe 2 — Trigger-based outbound loop (the core play)

**Goal:** reach an account the week something changes, with a grounded opener
that lands on a real contact.

```bash
# 1. Detect — fresh buying triggers (free ATS boards in the box; ingest for funding/social)
fullstackgtm signals fetch --bucket job,funding --watchlist crm:<segment> --save

# 2. Judge — rank into send/nurture/skip. PASS THE SNAPSHOT so each decision
#    resolves its CRM target (accountId + the contact[s] to reach).
fullstackgtm icp judge --signals-from latest --provider hubspot --save --json
#    → each decision carries: accountDomain, accountId, contact {id,email,title},
#      contacts[] (all in-CRM contacts at the account — for multi-threading)

# 3. Draft — one trigger-grounded opener per hot account, as a governed create_task
fullstackgtm draft --from-judge latest --channel email --save --json
#    → the task targets the resolved contact.id (or accountId). A domain-only
#      decision (account not in the CRM yet) is REJECTED with "acquire it first"
#      — run Recipe 1 for that account, then re-judge with the snapshot.

# 4. Approve + apply (the ONE human gate)
fullstackgtm plans approve <plan-id> --operations all
fullstackgtm apply --plan-id <plan-id> --provider hubspot

# 5. Send — OUTSIDE the package. The agent pushes the approved opener to the
#    operator's sender (e.g. HeyReach for LinkedIn, an email tool for email)
#    using the operator's credentials. The package never sends.

# 6. Record the outcome — credit the contact you reached, so weights re-learn
fullstackgtm signals outcome --account <domain> --contact <contactId> --result replied
```

**Why the snapshot in step 2 matters:** without it, decisions are domain-only and
`draft` cannot target a real record — it will reject them. With it, the loop is
contact-coherent end to end. `--with-history` additionally enables the memory
(don't re-touch a recently-touched account) and fit-scoring inputs.

---

## Recipe 3 — Continuous: schedule the detect/plan side, approve daily

**Goal:** run steps 1–3 of Recipe 2 on a cadence; keep the write gated.

```bash
fullstackgtm schedule add "signals fetch --bucket job,funding --watchlist crm:<segment> --save" --cron "0 7 * * 1-5"
fullstackgtm schedule add "icp judge --signals-from latest --provider hubspot --save" --cron "15 7 * * 1-5"
fullstackgtm schedule add "draft --from-judge latest --save" --cron "30 7 * * 1-5"
```

`schedule` is **read/plan-side only and NEVER auto-approves** — each morning a
queue of `needs_approval` plans is waiting; the agent presents them, the operator
approves, and `apply` runs (only `apply --plan-id <id>` is schedulable, and the
plan's `approved` status is re-checked at every firing).

---

## Recipe 4 — ABM: bring your target accounts, watch them, draft when they move

**Goal:** start from a list of target *companies* (not people).

```bash
# 1. Acquire the ACCOUNTS (acquire is keyed by object type — company rows → account create_record)
fullstackgtm enrich ingest target-companies.csv --source clay --objects companies
fullstackgtm enrich acquire --source clay --provider hubspot --save   # create.company → accounts WITH domains
fullstackgtm plans approve <id> --operations all && fullstackgtm apply --plan-id <id> --provider hubspot

# 2. From here it's Recipe 2 — the accounts now carry domains, so signals/judge watch them,
#    and (optionally) Recipe 1's acquire fills in contacts at each.
```

The `acquire.create.company` mapping (match key `domain`, properties →
`name`/`domain`) makes each company a **signal-watchable account**. See
[api.md → Acquire](./api.md).

---

## Recipe 5 — Hygiene-gate the outbound (don't outbound into a dirty CRM)

**Goal:** clean first, so signals/judge reason over correct ownership and
de-duplicated accounts; measure the lift.

```bash
fullstackgtm health --json                      # per-object-type score + trend (read-only)
fullstackgtm audit --provider hubspot --save     # → plan id
fullstackgtm dedupe account --key domain --save  # collapse duplicate accounts (signals key on domain)
fullstackgtm reassign --assign-unowned --to <ownerId> --save   # no ownerless leads
# approve + apply each, then run Recipe 2. Re-check `health` after to attribute the lift.
```

`health --json.byObjectType` tells you *which* object type is messy (clean
contacts but a messy pipeline read differently). Clean the accounts before
outbound — `signals`/`judge` key on account domain, so duplicate/owner-less
accounts distort the queue.

---

## The boundary, restated

- **Read freely. Write only through `plans approve → apply`.** Never bypass it.
- **The package never sends.** `draft` is the last governed step; the send is the
  agent calling the operator's channel tool with the operator's credentials.
- **You (the agent) are the orchestrator.** These recipes are starting points —
  compose, branch, and loop them into the play the operator actually wants.

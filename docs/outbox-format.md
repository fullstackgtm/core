# Outbox format (governed send queue)

The **outbox** is the send-side mirror of the [signal spool](./signal-spool-format.md).
It is how an *approved* drafted opener leaves the CLI — as a governed artifact a
downstream sender picks up, **not** as a transmitted message.

`fullstackgtm` **drafts everything and transmits nothing.** The CLI never opens
an SMTP or messaging-API connection. `apply --channel outbox` renders each
approved opener to a local JSONL file; a sender you run (the hosted product, or
your own MTA / ESP integration) drains the outbox and performs the actual send.
This is the send-side half of the open-core boundary: the governed artifact and
its format are open; always-on transmission infrastructure is hosted/opt-in.

## The loop

```
signals fetch → icp judge → draft → plans approve → apply --channel outbox → <sender>
   (detect)      (decide)   (write)   (human gate)     (render, no send)      (transmit)
```

`draft` stages a `needs_approval` plan of `create_task` operations, each carrying
one opener grounded in a verbatim signal quote. After `plans approve`, applying
the plan **through the outbox channel** (instead of a CRM provider) renders each
approved operation to the outbox. Nothing is sent, and no CRM record is written.

```bash
fullstackgtm draft --from-judge latest --channel email --save
fullstackgtm plans approve <planId> --operations all
fullstackgtm apply --plan-id <planId> --channel outbox      # renders; transmits nothing
```

Applying the same plan through a CRM provider instead (`--provider hubspot`)
logs the opener as a CRM task — the existing behavior. The two are alternatives:
a plan applies to one target.

## Where the outbox lives

```
<profile home>/signals/outbox/<channel>.jsonl   (default: ~/.fullstackgtm/signals/outbox/)
```

One file per channel (`email.jsonl`, `linkedin.jsonl`, `task.jsonl`), matching the
draft op's channel. Profile-scoped, owner-only (0600). A sender reads the file(s)
for the channel it handles and drains them on its own schedule.

## The format

Newline-delimited JSON (JSONL), one **outbox entry** per approved opener:

| Field | Meaning |
|---|---|
| `id` | The source operation id — the **idempotency key**. Re-rendering the same op never duplicates a row. |
| `channel` | `email` \| `linkedin` \| `task` — from the draft op. |
| `objectType` | `contact` \| `account` — the CRM object the opener is addressed to. |
| `objectId` | The CRM record id. A sender with CRM access resolves it to an email / profile. |
| `body` | The **approved opener, verbatim** as it was signed in the plan operation. |
| `reason` | The draft op's human-readable reason (carries the account and the trigger). |
| `evidenceIds` | Ids of the evidence the opener was grounded in (the verbatim signal quote). |
| `renderedAt` | ISO 8601 — when the CLI rendered this to the outbox. **Not** a send time. |

Example (`email.jsonl`):

```jsonl
{"id":"op_draft_abc","channel":"email","objectType":"contact","objectId":"C123","body":"Saw the Series B — congrats. Worth a quick chat on revops?","reason":"Signal-grounded opener for globex.com -> contact vp@globex.com","evidenceIds":["ev_globex_funding"],"renderedAt":"2026-06-25T13:08:17.176Z"}
```

The entry carries the CRM `objectId`, not a resolved email address — the CLI does
not resolve recipients (that is the sender's job, against the live CRM). The
`body` is exactly what a human approved; a sender may template around it but the
approved span is the source of truth.

## Governance and what the channel will not do

- **Only drafted openers.** The outbox channel renders `create_task` operations
  produced by `draft` (policy `draft:<channel>`). Any other operation is
  `skipped` — it is not a general CRM writer. Apply CRM changes through a CRM
  provider.
- **Approval-gated and integrity-checked.** Rendering reuses the same apply path
  as a CRM write: only operations whose plan is `approved` are applied, and a
  stored plan's approval signatures are verified before anything is rendered.
- **Idempotent.** Re-rendering an operation already in the outbox is a no-op.
- **Draining and retention are the sender's job.** The CLI appends; it never
  truncates the outbox. Your sender removes or archives entries after it
  transmits them.

## See also

- [signal-spool-format.md](./signal-spool-format.md) — the receive-side mirror.
- `docs/api.md` — the `apply`/`draft` verbs and the connector contract.
- The connector taxonomy and the hosted/open split (the managed sender stays
  closed) are in the maintainer design doc
  (monorepo `docs/spec-connectors-signals-outbound.md`).

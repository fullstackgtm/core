# Signal spool format (webhook landing zone)

The **spool** is how push-based signal platforms — website de-anonymization
(RB2B), social/job listening (Trigify), form-submission webhooks (HubSpot) —
reach `fullstackgtm`. The CLI is a deterministic batch tool, not an always-on
server, so it does not receive webhooks itself. Instead:

1. A **receiver** you run (any HTTP endpoint — 20 lines, or an off-the-shelf
   webhook-to-file tool) appends one JSON row per event to a spool file.
2. `fullstackgtm signals fetch --connector file` reads the spool on its next run,
   turning each row into a ranked signal through the same evidence-gate → dedup →
   weight pipeline as every other source.

The spool format and the `file` connector that reads it are open source. The
package ships **no receiver** — operating an always-on endpoint is out of scope
for the CLI (a managed receiver is part of the hosted product). This doc is the
contract your receiver writes to.

## The format

A spool file is **newline-delimited JSON (JSONL)**: one JSON object per line,
append-only. (A single `.json` file containing a JSON array is also accepted, for
convenience when staging by hand.) Each object is a **staged signal row**:

| Field | Required | Meaning |
|---|---|---|
| `bucket` | yes¹ | One of `demand`, `funding`, `job`, `company`, `social`. |
| `accountDomain` | yes | The company domain. `domain` is accepted as an alias. Normalized (protocol/`www`/path stripped, lowercased) on read. |
| `trigger` | yes | Short human label, e.g. `"visited pricing page"`, `"raised Series B"`. |
| `quote` | yes | **Verbatim evidence** — the exact text a human can verify (a headline, a page title, the submitted form + email). A row with no quote is **dropped**, never faked. |
| `sourceUrl` | no | Link to the evidence. |
| `firstSeen` | no | ISO 8601 timestamp. Defaults to the fetch time. |
| `weight` | no | Explicit weight; defaults to the bucket's configured weight. |

¹ `bucket` may be omitted in a spool file — the `file` connector fills its
default (`company`). Set it explicitly per row when a source spans buckets.

Example spool file (`rb2b.jsonl`):

```jsonl
{"bucket":"company","accountDomain":"globex.com","trigger":"visited pricing 3x","quote":"globex.com — viewed /pricing and /demo, 3 sessions","sourceUrl":"https://app.rb2b.com/v/abc123"}
{"bucket":"company","accountDomain":"initech.com","trigger":"visited docs","quote":"initech.com — viewed /docs/api","sourceUrl":"https://app.rb2b.com/v/def456"}
```

A row that fails validation (unknown bucket, missing domain/trigger/quote) makes
the fetch error and names the offending row — a corrupt spool is surfaced, not
silently skipped. Keep your receiver's mapping faithful to this table.

## Where the spool lives

`--connector file` with **no path** reads the conventional landing zone:

```
<profile home>/signals/spool/      (default: ~/.fullstackgtm/signals/spool/)
```

Every `*.jsonl` (and `*.json`) file in that directory is read and concatenated,
name-sorted — so each platform can append to its own file and they all land in
one fetch:

```
~/.fullstackgtm/signals/spool/rb2b.jsonl
~/.fullstackgtm/signals/spool/trigify.jsonl
~/.fullstackgtm/signals/spool/hubspot.jsonl
```

Point at a different file or directory with `--connector-opt path=<path>`:

```bash
# the conventional landing zone (zero-arg)
fullstackgtm signals fetch --connector file --save

# a specific file or directory
fullstackgtm signals fetch --connector file --connector-opt path=./events.jsonl --save
fullstackgtm signals fetch --connector file --connector-opt path=/var/spool/fsgtm --save
```

The CLI **never writes** to the spool — your receiver does. The directory is
profile-scoped, so spools for different client workspaces stay separate.

### Re-reads and retention

Re-reading the same spool is safe: signals dedup on `(accountDomain, bucket,
trigger)` within the configured window (`dedupWindowDays`, default 30), so a row
that's still in the spool on the next fetch is deduped, not double-counted. The
CLI does not consume or truncate the spool — **retention is yours**: rotate or
truncate the files on your own schedule (e.g. nightly, or after a successful
`--save`). Unbounded spool growth is a self-host concern the CLI doesn't manage.

## Writing a receiver

A receiver is whatever turns a platform's webhook POST into spool rows. The
minimum: verify the platform's signature, map the payload to the fields above,
append one JSON line. Pseudocode:

```js
// POST handler for your platform's webhook
function onWebhook(req) {
  verifySignature(req);                       // platform's HMAC / shared secret
  const row = mapToStagedRow(req.body);       // per-platform mapping (below)
  if (!row.quote) return 204;                 // no verifiable evidence -> skip
  appendLine("~/.fullstackgtm/signals/spool/<platform>.jsonl", JSON.stringify(row));
  return 204;
}
```

Keep the receiver dumb: no ranking, no CRM writes, no judgment. All of that is
the CLI's job, gated and deterministic, on the next `signals fetch`.

## Per-platform mapping

These map each platform's webhook payload to a staged row. Payload shapes drift —
verify against the platform's current webhook docs before relying on a field.

### RB2B (website visitor de-anonymization)

RB2B delivers an identified visitor (person + company) via outbound webhook.
Use the **company domain** as `accountDomain` and the visited pages as the
verbatim `quote`.

| Spool field | From RB2B payload |
|---|---|
| `bucket` | `"company"` (or `"demand"` for high-intent pages) |
| `accountDomain` | the visitor's company domain |
| `trigger` | e.g. `"visited pricing"` derived from the top page |
| `quote` | `"<domain> — <pages viewed>"` (verbatim page paths) |
| `sourceUrl` | the RB2B visitor permalink |

### Trigify (social / job-change listening)

Trigify pushes social and job-change events. Map the monitored account's domain;
the post/job text is the evidence.

| Spool field | From Trigify payload |
|---|---|
| `bucket` | `"social"` or `"job"` |
| `accountDomain` | the account/company domain |
| `trigger` | e.g. `"new role: VP Sales"` or `"posted about <topic>"` |
| `quote` | the verbatim post text or job title + snippet |
| `sourceUrl` | the source post / listing URL |

### HubSpot form-submission webhook

The `hubspot-forms` **pull** connector already covers recent submissions via the
Forms API (Phase 1). For real-time, subscribe to HubSpot's form-submission
webhook and append a `demand` row per submission — the same shape the pull
connector produces, so both paths dedup against each other.

| Spool field | From HubSpot submission |
|---|---|
| `bucket` | `"demand"` |
| `accountDomain` | corporate domain of the submitted email (drop free-mail) |
| `trigger` | `"form: <form name>"` |
| `quote` | `"Submitted \"<form name>\" — <email>"` |
| `firstSeen` | submission timestamp (ISO 8601) |

## See also

- `docs/api.md` — the `signals` verb and the `SignalSourceConnector` contract.
- The connector taxonomy and the hosted/open-source split for the receiver are
  described in the maintainer design doc (monorepo
  `docs/spec-connectors-signals-outbound.md`).

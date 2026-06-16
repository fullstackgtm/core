# Data flows & trust boundary

A procurement / security review needs to know exactly what data leaves the
machine, to which endpoint, and under whose account. This is that enumeration
for the open-source `fullstackgtm` CLI. The short version: **the CLI is
bring-your-own-key and talks directly to services you already control — there
is no fullstackgtm-operated server in the data path for the open package.**

## What stays local

- CRM snapshots, patch plans, approvals, apply-run records, market captures and
  observations, enrich run state, and the signing/credential stores all live
  under `$FSGTM_HOME` (default `~/.fullstackgtm`), `0600`/`0700`. Nothing is
  uploaded to Full Stack GTM.
- No telemetry, analytics, or phone-home. The core package has zero runtime
  dependencies; the only network calls are the ones listed below, all to
  endpoints you configure.

## What leaves the machine, by command

| Command(s) | Destination | Data sent | Auth |
|---|---|---|---|
| `snapshot`, `audit`, `apply`, `resolve`, `bulk-update`, `dedupe`, `reassign`, `fix`, `enrich` (writeback) | **Your CRM** (HubSpot / Salesforce / Stripe API) | Reads: your CRM records. Writes: only approved patch operations. | Your CRM token (env / stored / broker) |
| `call parse`, `call score`, `market classify`, `market refresh` | **Your LLM provider** (api.anthropic.com or api.openai.com) | The call transcript / captured competitor page text you point at, plus the extraction prompt | Your `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (BYO) |
| `enrich append --source apollo`, `enrich refresh` | **Apollo** (api.apollo.io) | The company domain / contact email being enriched | Your `APOLLO_API_KEY` (BYO) |
| `market capture`, `market refresh` | **Public vendor websites** you list in `market.config.json` | An HTTP GET (no data sent beyond the request); SSRF-guarded to public hosts only | none |
| `login --via <url>` (optional) | **Your hosted deployment's broker** | A pairing handshake; the broker mints short-lived CRM tokens | broker pairing token |

Commands not listed (`plans`, `rules`, `doctor`, `schedule`, `audit-log`,
`diff`, `merge`, report rendering) make **no network calls**.

## Avoiding third-party data egress

- **LLM verbs are optional.** `call parse --deterministic` uses a free,
  offline keyword baseline (no LLM call). `market worksheet` lets an agent or
  human classify without the CLI making an LLM call. A regulated deployment can
  run the full audit → plan → apply loop with **zero third-party calls** —
  CRM-only.
- **No data is sent for training.** Anthropic, OpenAI, and Apollo are reached
  with your own API keys under your own agreements; their data-handling terms
  (and any DPA you have with them) govern that traffic. Full Stack GTM LLC is
  not in that path and is not a sub-processor for the open-source CLI.

## Sub-processors

For the **open-source CLI**: none (BYO-key, direct-to-service). The data
controllers are you and the providers whose keys you supply.

For the **hosted application** (a separate, proprietary product — not this
package): a sub-processor list and DPA are provided through that product's
agreement. If you are evaluating the hosted product, request them from
ryan@fullstackgtm.com.

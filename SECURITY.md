# Security Policy

fullstackgtm reads and writes live CRM data under the operator's own
credentials. We take its security posture seriously and design the write path
to fail closed. This document is the disclosure process and the trust model a
security reviewer needs.

## Reporting a vulnerability

Email **security@fullstackgtm.com** with a description and, ideally, a
reproduction. Please do not open a public issue for a security report. We aim
to acknowledge within 3 business days and to ship a fix or mitigation before
any public disclosure. There is no bounty program yet; credit is given in the
changelog unless you prefer otherwise.

Supported version: the latest published `0.x` release on npm. Fixes land on the
newest version, not backported (the project is pre-1.0).

## Trust model

**Credentials.** API tokens are never accepted as command-line arguments
(they would leak into the process table and shell history); they come from an
environment variable or stdin only, and are stored `0600` under a `0700` home
(`$FSGTM_HOME`, default `~/.fullstackgtm`), re-tightened on read. This is the
same custody model as the `gcloud`/`aws` CLIs. The hosted broker
(`login --via`) exists so a team can connect a CRM once, server-side, and hand
laptops only a revocable pairing token instead of a long-lived super-admin key.

**Writes are approval-gated.** Reads are safe by default. Every change is a
typed patch operation in a dry-run plan that a human must approve before
`apply`. `apply` writes only operations whose ids were explicitly approved,
refuses operations carrying unresolved placeholder values, and uses
compare-and-set against the live CRM so a value that drifted since the plan was
built becomes a conflict, not a clobber. Irreversible operations (merge,
archive) get a fresh-snapshot drift guard, and archiving a record that still
shares an identity key with another is refused (it's a duplicate — merge it).

**Approval integrity.** At approval time each operation's apply-relevant content
is HMAC-signed with a per-install key (`$FSGTM_HOME/.plan-signing-key`, `0600`).
`apply --plan-id` re-verifies; a plan edited after approval — by a synced copy,
another process, or a compromised dependency — is refused rather than executed.
The invariant: **what gets written equals what the human signed.** A plan
approved on one machine cannot be applied on another (the key does not travel).
Documented boundary: this defends the plan file, not an attacker who already
holds the signing key (same directory and permissions as the credential store).

**Scheduling never auto-approves.** Scheduled (cron) runs are restricted to a
read/plan-side allowlist plus `apply --plan-id` whose approved status and
signatures are re-checked at every firing. Arbitrary shell is not schedulable.

**Untrusted input.** Competitor pages fetched by `market capture` are guarded
against SSRF (scheme allowlist; private/loopback/link-local/metadata addresses
refused; redirects re-validated). LLM-extracted call insights and market
classifications are mechanically verified verbatim against the source text
before they can drive a writeback, so a prompt-injected transcript or page
cannot fabricate a grounded-looking change. CSV/formula-injection in ingested
data is neutralized before it reaches a write.

**Auditability.** `audit-log export` produces a hash-chained, install-signed
record of every apply run for change-management/SIEM ingestion; `audit-log
verify` detects any edit or reorder.

## Data flows

What leaves the machine, to whom, and for which command is enumerated in
[DATA-FLOWS.md](./DATA-FLOWS.md). In brief: the core CLI is BYO-key and talks
directly to your CRM and (only for LLM/enrichment verbs you invoke) to your
chosen Anthropic/OpenAI/Apollo accounts — there is no fullstackgtm-operated
data path for the open-source package.

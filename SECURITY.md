# Security Policy

fullstackgtm reads and writes live CRM data under the operator's own
credentials. We take its security posture seriously and design the write path
to fail closed. This document is the disclosure process and the trust model a
security reviewer needs.

## Reporting a vulnerability

Email **ryan@fullstackgtm.com** with a description and, ideally, a
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
(`$FSGTM_HOME`, default `~/.fullstackgtm`). Writes use exclusive temporary
files, fsync, and atomic rename; reads require regular files opened without
following symlinks. Managed-home, credential, and plan-store symlink paths are
refused before chmod/read/write. This is the
same custody model as the `gcloud`/`aws` CLIs. The hosted broker
(`login --via`) exists so a team can connect a CRM once, server-side, and hand
laptops only a revocable pairing token instead of a long-lived super-admin key;
the broker URL must be https (cleartext is refused except for localhost dev).

**OS keychain (opt-in).** Set `FSGTM_KEYCHAIN=1` to store the credential blob
in the OS secret store instead of a plaintext file — macOS Keychain (via
`security`) or Linux libsecret (via `secret-tool`); no native dependency. When
enabled, a pre-existing `credentials.json` is migrated into the keychain and the
plaintext file is removed, so a cloned home or restored backup finds no token at
rest. Caveat: on macOS, `security add-generic-password` only accepts the secret
via an argv flag, so it is briefly visible to a same-user `ps` during the write
— a transient exposure strictly smaller than a persistent plaintext file, but a
real one (Linux `secret-tool` reads the secret from stdin, with no such window).
Backups or clones taken *before* enabling keychain already captured the file;
rotate those credentials if that is a concern.

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

**Single-owner apply and recovery.** Store-backed CLI and MCP writes atomically
claim an approved plan and journal the provider, caller surface, and attempt
state before provider I/O. A second process cannot apply the same approval.
Failures after provider I/O remain `applying`/uncertain because a timeout cannot
prove no remote write landed. Recovery never auto-replays: after reconciling CRM
state, `plans recover <id> --acknowledge-uncertain-writes` clears every approval
and signature and requires a fresh human review.

**Executable configuration.** `rulePackages` are arbitrary JavaScript. An
implicitly discovered repository config cannot activate them; CLI execution
requires explicit `--config <path> --allow-plugins` (`--no-plugins` disables
them). MCP never executes rule packages or accepts external plans/caller
approvals.

**Credential origins.** Salesforce access and refresh tokens are sent only to
canonical HTTPS Salesforce-owned origins. Userinfo, paths/query/fragment,
nonstandard ports, lookalike domains, unsafe token-response instance URLs, and
credential-preserving redirects are refused at input, storage, and use.

**Scheduling never auto-approves.** Scheduled (cron) runs are restricted to a
read/plan-side allowlist plus `apply --plan-id` whose approved status and
signatures are re-checked at every firing. Arbitrary shell is not schedulable.

**Untrusted input.** Competitor pages fetched by `market capture` are guarded
against SSRF: every DNS answer must be globally routable, validated answers are
pinned into socket creation, mixed/private/reserved answers are refused, every
redirect is revalidated, sensitive headers are stripped cross-origin, and
time/body/redirect limits are enforced. LLM-extracted call insights and market
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

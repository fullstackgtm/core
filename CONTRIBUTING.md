# Contributing

Thanks for your interest in `fullstackgtm`! This covers both outside
contributors and co-maintainers.

## How this repository works (open-core mirror)

`fullstackgtm` is open-core. The development **source of truth** is a private
monorepo (the package lives at `packages/fullstackgtm`), alongside the hosted
Full Stack GTM LLC application. `scripts/sync-oss.sh` publishes a **one-way
mirror** to [github.com/fullstackgtm/core](https://github.com/fullstackgtm/core)
and to npm. The mirror has the package at its repo root, the tests in `tests/`
with rewritten import paths, and `dist/` committed (so `npm install
github:fullstackgtm/core` works without a build step).

- **Issues / PRs:** open them on the public mirror (`fullstackgtm/core`). A
  maintainer applies accepted changes in the monorepo with credit
  (`Co-authored-by`); they land in the next mirrored release.
- The open/closed boundary: client tools, the canonical model, rules, the
  plan/apply contract, connectors, CLI, and MCP server are open; the hosted Full
  Stack GTM application's server code is not. **Features never move from open to
  closed**, and new work here must run standalone (no hosted deployment
  required). (Maintainers: the full boundary policy lives in
  `docs/open-core-boundary.md` in the development monorepo.)

## Architecture

Start with [docs/architecture.md](./docs/architecture.md) for the module map and
the snapshot → audit → plan → approve → apply data flow, then
[docs/api.md](./docs/api.md) for the 1.0 contract surface (canonical model, rule
interface, connector interface, governed write verbs, MCP tools).

## Development

The package is zero-runtime-dependency TypeScript. **In the monorepo**, it is
built and tested from the repo root after a single root `npm install` (it shares
the root's dev toolchain; it is not a separately-installed workspace):

```bash
# from the monorepo root:
npm install                                                   # once
cd packages/fullstackgtm && npm run build                     # tsc → dist/ (cleans first)
node --experimental-strip-types --test tests/fullstackgtm*.test.ts   # from the repo ROOT — tests live there
node packages/fullstackgtm/src/bin.ts doctor                  # run the CLI locally
```

Before a release-facing change, verify the artifact rather than only its source
tree:

```bash
cd packages/fullstackgtm
npm run build
node scripts/verify-packed-install.mjs              # isolated install, optional peers absent
node scripts/verify-packed-install.mjs --with-peers # isolated install, MCP peers present
```

The verifier creates the real npm tarball, enforces required/prohibited paths,
imports the public export, checks its declaration entrypoint, and runs both
installed binaries. CI repeats compiled-runtime checks on Node 20 and 22 across
Linux, macOS, and Windows; source-level tests remain on Node 22.6+.

> **Tests live at the monorepo root `tests/`, not in the package.** Running
> `npm test` *inside* `packages/fullstackgtm` deliberately fails with a pointer
> (a `pretest` guard) rather than silently passing with zero tests. On the
> published mirror, `tests/` is present and `npm test` works there.

The public mirror includes a representative suite covering supported CLI,
planning, configuration, HTTP, and security behavior. Additional hosted-product,
live-integration, and adversarial release tests remain in the private monorepo;
both suites gate releases. The public test selection is reviewed explicitly in
`oss/public-tests.txt`, and `npm test` fails if the mirror contains zero tests.

**Node:** the published runtime supports Node ≥ 20 (`engines`), but the test
runner needs Node **≥ 22.6** for `--experimental-strip-types`. Develop on 22.6+.

Keep the core dependency-free — a new runtime dependency needs a very strong
reason (the MCP server's `@modelcontextprotocol/sdk`/`zod` are optional peers,
imported only by the MCP entrypoints).

## Safety invariants (do not weaken)

- Audits/suggests are read-only; nothing is written without explicit approval.
- `apply` writes only operations whose ids were approved; `requires_human_*`
  placeholders are refused without a concrete `--value`.
- Approvals are HMAC-signed and re-verified at apply (integrity.ts) — a plan
  edited after approval is refused.
- Irreversible ops (merge/archive) get a fresh-snapshot drift guard; archiving a
  record that still shares an identity key with another is refused.
- Secrets are never accepted as argv flags — stdin or env only.
- Finding/operation ids stay stable hashes of rule + record.

When in doubt, add a test in `tests/fullstackgtm*.test.ts` (the suite doubles as
the spec) and run the security suite (`fullstackgtmSecurity.test.ts`).

## Releasing (maintainers)

The steps are below (deeper rationale lives in `docs/open-core-boundary.md` in
the development monorepo). From the monorepo:

1. Bump `packages/fullstackgtm/package.json` version + add a `CHANGELOG.md`
   entry; merge to `main`.
2. Run `scripts/sync-oss.sh` to export an allowlisted mirror from the full
   source commit, build `dist/`, scan for secrets, and inspect the complete
   staged diff. Then rerun with `--push` after review. Clone failures stop the
   release; only a genuine first publication may use the separately confirmed
   `--initialize-public-repo` mode.
3. Re-check the mirror's `package.json` version, then tag `vX.Y.Z` on the mirror
   and push the tag.
4. GitHub Actions (`release.yml`) publishes to npm via **OIDC trusted
   publishing** — no tokens. The protected `npm-production` environment must
   require an independent reviewer. The workflow rebuilds from source and
   refuses to publish if committed `dist/` differs (supply-chain gate).

**Access a new co-maintainer needs to cut a release:** write access to
`github.com/fullstackgtm/core` (for `sync-oss.sh --push` and the tag push). No
npm token is required — publishing is OIDC-bound to the repo + `release.yml`.
Cut one supervised patch release end-to-end before taking over release duty.

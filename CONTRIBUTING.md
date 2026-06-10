# Contributing

Thanks for your interest in `fullstackgtm`!

## How this repository works

This repo is the public home of the `fullstackgtm` package — issues, releases,
and the npm-published source live here. Day-to-day development currently
happens in a private monorepo alongside the hosted Full Stack GTM application,
and changes are mirrored out here with each release.

What that means for you:

- **Issues and discussions:** open them here. This is the canonical tracker
  for the framework, CLI, and MCP server.
- **Pull requests:** welcome. A maintainer will review here, apply the change
  in the development repo with credit (`Co-authored-by`), and it will land in
  the next mirrored release. Small fixes turn around fast; for larger changes,
  open an issue first so we can agree on the design before you invest time.
- If outside contributions grow, flipping this repo to the development source
  of truth is the planned upgrade path.

## What belongs in this package

The open/closed boundary is deliberate and stable: client tools, the canonical
data model, audit rules, the plan/apply contract, connectors, CLI, and MCP
server are open source. Server code for the hosted application is not. New
features here should work standalone — no hosted deployment required.
Features never move from open to closed.

## Development

```bash
npm install        # also builds dist/ via the prepare script
npm test           # node --test over tests/
npm run build      # tsc → dist/
```

Requires Node 20+. The core has zero runtime dependencies — keep it that way;
new runtime dependencies need a very strong reason.

## Safety invariants (do not weaken)

- Audits are read-only; nothing is written without explicit `--approve`.
- `requires_human_*` placeholder values are never written without a concrete
  `--value` override.
- Secrets are never accepted as argv flags — stdin or env only.
- Finding/operation ids stay stable hashes of rule + record.

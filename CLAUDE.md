# Working on the `fullstackgtm` package

This directory is the **open-source `fullstackgtm` npm package** — a zero-runtime-
dependency TypeScript library + CLI + MCP server. It is NOT the hosted
Next.js/Convex application (the repo-root `CLAUDE.md` describes that app; its
Convex guidance does not apply here).

- **What it is / design:** [README.md](./README.md),
  [docs/architecture.md](./docs/architecture.md) (module map + data flow),
  [docs/api.md](./docs/api.md) (contract surface). The governing idea is
  *deterministic apply, governed suggest*.
- **Build:** `npm run build` (from this dir) → `tsc` → `dist/` (cleans first).
- **Test:** run from the **monorepo root**:
  `node --experimental-strip-types --test tests/fullstackgtm*.test.ts` (Node ≥ 22.6).
  `npm test` *inside this dir* intentionally fails with a pointer (tests live at
  the root, not here). Add tests in `tests/fullstackgtm*.test.ts`.
- **Boundary & releases:** [CONTRIBUTING.md](./CONTRIBUTING.md) and
  [docs/open-core-boundary.md](../../docs/open-core-boundary.md) — monorepo is
  the source of truth; `scripts/sync-oss.sh` mirrors to `fullstackgtm/core` + npm.
- **Keep it zero-dependency.** No runtime deps (MCP `@modelcontextprotocol/sdk`
  + `zod` are optional peers). Don't weaken the safety invariants
  (read-only audits, approval-gated + HMAC-signed writes, CAS, verbatim
  evidence gates, secrets never in argv).

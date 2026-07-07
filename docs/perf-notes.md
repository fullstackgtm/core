# CLI performance notes — profile-driven hot-path pass (2026-07-02)

Method: extreme-software-optimization loop — baseline → profile (`node
--cpu-prof`) → prove (golden outputs, sha256) → implement (opportunity score
≥ 2.0 only, one lever per commit) → verify (goldens byte-identical + full
suite) → re-profile. Byte-identical output is a hard gate: any intentional
output change is a rejected change, not an optimization.

Environment: macOS (arm64), Node v22.17.1, `SOURCE_DATE_EPOCH` pinned,
`NO_COLOR=1`, piped stdout. Benchmarks are p50 wall time over 20 interleaved
A/B runs (alternating baseline/candidate each iteration to cancel thermal and
cache drift; hyperfine was not installed on the box). Absolute numbers are
machine-specific; the deltas are the claim.

## Baseline (main @ c3e99b1)

| command | p50 | notes |
|---|---|---|
| `--version` | ~133–156ms | pure startup; bare `node -e ""` is ~30ms wall on this box |
| `--help` | ~131ms | |
| `capabilities --json` | ~136ms | |
| `rules` | ~136ms | |
| `audit --demo` | ~149ms | demo gen + 15 rules + render ≈ 15ms of actual work |
| `audit --demo --json` | ~147ms | |
| `dedupe account --key domain --demo` | ~142ms | |

## Flame findings (`node --cpu-prof dist/bin.js --version`, 74ms CPU total)

| rank | location | % self | category |
|---|---|---|---|
| 1 | `compileSourceTextModule` (ESM loader) | 22.4% | userland module graph compile |
| 2 | `compileForInternalLoader` (node builtins) | 13.5% | incl. undici (node fetch impl) pulled in by `node:http` |
| 3 | (program) + native | ~10% | V8 bootstrap |
| 4 | GC | 10.2% | allocation during load |
| 5 | `defaultLoad`/ESM resolve/stat | ~8% | 78 dist modules resolved + read |

Diagnosis: every invocation — including `--version` — loaded the full
78-module / 1.16MB dist graph, because `cli.ts` statically imported all verb
modules, `cli/shared.ts` statically imported all three connectors + demo +
sample data, and `node:http` (imported at top of `hubspotAuth.ts`, which
`help.ts` imports for one constant) transitively compiles node's bundled
undici on Node 22.

## Opportunity matrix

| opportunity | impact | conf | effort | score | verdict |
|---|---|---|---|---|---|
| Defer `node:http` to the OAuth loopback path | 3 | 5 | 1 | 15.0 | SHIPPED (946e24b) |
| Lazy per-verb `await import()` in the dispatcher | 3 | 5 | 2 | 7.5 | SHIPPED (fc88a00) |
| Defer connectors/demo/sample in `cli/shared.ts` | 1 | 5 | 1 | 5.0 | SHIPPED (a1df276) |
| Split `llm.ts`/`callTypes.ts` (28KB rubric data) out of the eager `cli/auth.ts` graph | 1 | 3 | 3 | 1.0 | REJECTED — `doctorReport` (public re-export from cli.ts, sync) calls `resolveLlmCredential`; restructuring is an API-surface move for ~1–2ms |
| `rules.ts` out of eager graph (sync default param of `selectedRules`) | 1 | 3 | 3 | 1.0 | REJECTED — signature change rippling through verb modules for ~1ms |
| Audit-path allocation pass (GC 21% on 100k-record run) | 2 | 2 | 4 | 1.0 | REJECTED — multi-site change, violates one-lever; path already 0.56s at 100k records |
| `plans list` avoids full JSON.parse of every plan | 1 | 3 | 4 | 0.75 | REJECTED — at 100×1.4MB plans it is already at the native JSON.parse floor (~530ms for 140MB); doing better needs a sidecar/index, i.e. a format change, not an isomorphic optimization |
| Spool/JSONL ingest parsing | — | — | — | null | NO HOTSPOT — 50k-row JSONL ingest is ~143ms wall, startup-dominated; per-line `JSON.parse` is near the native floor |

## Shipped changes (one lever per commit, isomorphism proof in each message)

1. **946e24b — defer `node:http` import to the OAuth loopback login path.**
   `createServer` is used only inside `runHubspotLoopbackLogin` (already
   async); the import moved there. Removes undici + http + net compile from
   every run. Incremental A/B: `--version` −11.3%, `audit --demo` −10.1%.
2. **fc88a00 — lazy per-verb module loading in the dispatcher.** Each
   `runCli` branch dynamically imports its own `cli/<verb>` module. Eager
   graph 78 → 25 modules. The `doctorReport`/`assertSecureBrokerUrl`
   re-exports stay static so the tested import surface of `cli.ts` is
   unchanged. Cumulative A/B at this point: `--version` −27.8%.
3. **a1df276 — defer connector/demo/sample modules in `cli/shared.ts`.**
   The two largest dist files (hubspot 51KB, salesforce 39KB) plus stripe/
   demo/sampleData load only when that data source is selected. Eager graph
   25 modules/385KB → 19 modules/273KB. Incremental A/B: `--version` −2.4%,
   `audit --demo` −0.8% — modest (V8 lazily compiles unexecuted function
   bodies), kept because effort was minutes and risk zero.

Every commit: 57 golden outputs byte-identical (help/version/capabilities/
audit demo text+json/doctor/rules/dedupe/bulk-update/resolve/snapshot
--sample/error paths, `SOURCE_DATE_EPOCH` pinned) and 717/717 tests green.

## Final numbers (interleaved A/B, 20 runs, p50; baseline = main @ c3e99b1)

| command | before | after | Δ |
|---|---|---|---|
| `--version` | 140.4ms | 97.3ms | **−30.7%** |
| `--help` | 142.9ms | 102.3ms | **−28.4%** |
| `capabilities --json` | 138.4ms | 97.5ms | **−29.6%** |
| `rules` | 137.7ms | 99.0ms | **−28.1%** |
| `audit --demo --json` | 148.1ms | 114.6ms | **−22.6%** |
| `dedupe account --key domain --demo` | 140.2ms | 113.7ms | **−18.9%** |

Post-change floor: a trivial `console.log` script spawned the same way is
~77ms p50 in this harness, so CLI-attributable overhead on `--version` fell
from ~58ms to ~20ms. Remaining eager weight is `help.ts` (45KB, needed for
the front door and typo detection) and the `cli/auth.ts` graph held by the
public re-exports; every candidate to shrink those scored < 2.0.

## Non-wins (measured, honest)

- **Large-input audit** (synthetic 50k accounts + 50k contacts): 0.56s wall,
  618ms CPU. Top userland hotspots — `readSnapshot` (JSON.parse of the 30MB
  input, 10.3%), `duplicateGroups` (8.7%), `buildRecordIndex` (6.7%) — are
  all single-pass Map-based O(n) and built once per run. No accidental
  quadratic anywhere; no lever ≥ 2.0.
- **Spool ingest** (50k-row JSONL): 143ms wall including startup. Nothing to do.
- **`plans list`** at a punishing 100 plans × 1.4MB: 530ms, i.e. the native
  `JSON.parse` floor for 140MB of JSON. Realistic stores (tens of KB-sized
  plans) are startup-dominated.

Re-profiling after the three levers shows `--version` CPU down from 74ms to
~36ms, with the top entries now node's own bootstrap (`compileForInternalLoader`,
program/native) — i.e. the remaining cost is mostly the Node runtime itself.

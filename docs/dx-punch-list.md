# DX / adoption punch list

Audit date: 2026-06-19. Method: ran the CLI as a new adopter would (bare
invoke → `doctor` → `audit --demo` → per-command `--help`) and measured the
friction, rather than reading the source. Companion to the security/strategic
findings that drove the 0.25.1–0.28.0 hardening releases — same format, same
intent: a tracked list that drives a release.

## Framing

The **agent path** (SKILL.md verb map, MCP tools, `--json` everywhere,
gate-shaped exit codes 0/1/2) is cohesive and adopts cleanly. The **human
path** is the weak side — and the human is a primary user (the consultant-CLI,
dogfood-on-client-work direction). Every fix below either *deepens an existing
verb* or *connects two existing verbs*; none adds a new top-level noun. The
adoption work **is** the "deeper not broader" work.

`doctor` (ends with "Next step") and `fix` (chains audit→suggest→approve→apply)
already do the right thing. Cohesion here = make every verb behave like
`doctor` and `fix` already do.

## Findings (evidence-backed)

| # | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| F1 | **Front door is a firehose** | bare invoke = 194 lines; 22 verbs / 87 distinct flags; `cli.ts` is 3,615 lines | New user can't find the ~6 things they actually do |
| F2 | **Credential-free entry point dead-ends** | `audit --demo` (the README's "try it first") dumps **1,467 lines** to stdout and ends on a blank line — no "next step," unlike `doctor` | The single most-run first command strands you |
| F3 | **No per-command help** | `dedupe --help`, `audit --help` fall through to the same 194-line global wall | A stuck user gets the firehose, not the answer |
| F4 | **No altitude control on reads** | `audit` has only `--json` / `--out` / `--format`; no `--summary` / `--top` / `--quiet`. Human mode *is* the 1,467-line dump | Default human output is unreadable yet not machine-parseable |
| F5 | **Tone undercuts positioning** | `audit --demo` footer: "This prototype is dry-run only" | Reads as toy vs. the beta/production-safety-invariant framing |
| F6 | **No guided mode** | `readline` is used only for the login secret prompt | Every workflow is hand-assembled from flags; nothing scaffolds the loop |

## Fix sequence (highest leverage first)

### 1. Progressive-disclosure help — DONE
Fixes **F1, F3**. The full `usage()` is now the explicit full reference
(`fullstackgtm help --full`). Added:
- `shortUsage()` — a ~30-line map of the verbs grouped by lifecycle phase
  (Setup · Detect · Prevent · Remediate · Calls · Govern · Market · Schedule),
  one line each, ending with `<command> --help` and `help --full` pointers.
  Becomes the default for bare invoke and `--help`.
- `commandHelp(command)` — focused per-verb help (summary, synopsis, where it
  sits in the loop, key options, see-also). `<verb> --help` zooms in instead
  of dumping the surface. `call`/`market`/`enrich`/`bulk-update`/`schedule`
  keep their existing bespoke help.
- `help [command] [--full]` command.

### 2. Every verb hands you the next step — DONE (audit keystone)
Fixes **F2**. `auditNextStep()` gives `audit` context-aware forward guidance on
stderr (stdout stays clean for pipes/`--out`; suppressed under `--json`):
- **demo/sample** → "Client-ready writeup: `report --demo`" + "Run on your CRM:
  `login hubspot` → `audit --provider hubspot --save`"
- **live + `--save`** → the governed spine: `suggest` → `plans approve
  --values-from` → `apply`, with the real plan id
- **0 findings** → "clean — gate new records with `resolve`, schedule a check"

The lifecycle spine made *experiential* — each command knows its phase and
points forward (`doctor`/`fix` were the templates). `audit` is the keystone
(the documented dead-end); the helper pattern now generalizes to the other read
verbs (`report`, `resolve`, `dedupe` previews) in a follow-up.

### 3. Altitude control on the firehose — DONE
Fixes **F4**. `patchPlanToMarkdown(plan, { summary })` gains a summary view
(header + Findings-by-Rule table + operation count + pointers to `--full` and
`report`). `audit` defaults to it — **1,467 → 24 lines** on the demo — with
`--full` to opt back into the per-operation dump. The default stays *full* for
every other caller (bulk-update, fix, dedupe, plans show, MCP): write-preview
verbs keep full operation detail because you approve specific ops there. The
principled split — audit = "what's wrong" (summary → `report`); write verbs =
"exactly what I'll change" (full) — is the real win.

### 4. Tone pass — DONE
Fixes **F5**. The "This prototype is dry-run only" footer is replaced
everywhere with safety-invariant framing matching README/SKILL: "Dry-run plan —
read-only. No provider write happens until you approve specific operations and
run `apply`; placeholder values are refused without an explicit override. These
safety invariants are not beta." No "prototype" string remains in user output.

## Deferred (bigger bets, gated on 1–4 landing)
- **Engagement workspace**: per-client `.fullstackgtm/` state that accumulates
  snapshots, plans, evidence, and a health-over-time score — turns episodic
  audits into a continuously-operated system.
- **Journey commands**: 2–3 opinionated composites (onboard-a-client,
  health-rollup) sequencing existing verbs into revops jobs.

There is no point building the engagement workspace while the front door dumps
1,467 lines. Land the DX fixes first.

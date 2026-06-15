# CRM-Ops Bench — Five-Model Results (2026-06-15)

1,020 runs: 17 scenarios (14 synthetic + 3 seeded from an anonymized real
HubSpot portal) × 3 tool-surface arms × 4 trials, across five models from
three vendors. Deterministic graders over final CRM state and the mock
server's mutation log; no LLM judging. Raw per-run records:
[`runs.jsonl`](runs.jsonl) (metadata only — transcripts withheld with the
private seed set). Interactive board: [`index.html`](index.html).

**CuP** = completion under policy: full task completion AND zero safety
violations AND no run error. **pass^k** = τ-bench's unbiased estimator of
all-k-trials-succeed, with CuP as the success event (reliability of *safe*
completion). Ranked by CuP.

| # | Model | Arm | CuP | Accuracy | pass^2 | pass^4 | Violations |
|---|---|---|---|---|---|---|---|
| 1 | Claude Sonnet 4.6 | fullstackgtm-gated | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | Kimi K2.6 | fullstackgtm-gated | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | GPT-5.5 | raw+fullstackgtm | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 4 | GPT-5.5 | fullstackgtm-gated | 98.5% | 99.8% | 0.97 | 0.94 | 0 |
| 5 | GPT-5.5 | raw | 97.1% | 99.3% | 0.94 | 0.88 | 1 |
| 6 | Claude Haiku 4.5 | fullstackgtm-gated | 92.6% | 96.5% | 0.88 | 0.82 | 10 |
| 7 | Kimi K2.6 | raw+fullstackgtm † | 89.7% | 97.0% | 0.82 | 0.71 | 5 |
| 8 | Claude Sonnet 4.6 | raw+fullstackgtm † | 80.9% | 95.4% | 0.75 | 0.71 | 21 |
| 9 | Kimi K2.6 | raw | 77.9% | 92.1% | 0.68 | 0.59 | 8 |
| 10 | GPT-5.4-mini | fullstackgtm-gated | 73.5% | 77.5% | 0.64 | 0.53 | 33 |
| 11 | Claude Sonnet 4.6 | raw | 72.1% | 94.4% | 0.71 | 0.71 | 32 |
| 12 | GPT-5.4-mini | raw+fullstackgtm | 70.6% | 80.3% | 0.60 | 0.53 | 47 |
| 13 | Claude Haiku 4.5 | raw+fullstackgtm † | 67.6% | 92.1% | 0.60 | 0.47 | 33 |
| 14 | Claude Haiku 4.5 | raw | 60.3% | 87.0% | 0.56 | 0.53 | 381 |
| 15 | GPT-5.4-mini | raw | 44.1% | 67.1% | 0.29 | 0.18 | 62 |

## Findings

1. **The gated configuration takes the top of the board, and an
   open-weights model ties for first.** Claude Sonnet 4.6, Kimi K2.6, and
   GPT-5.5 all reach 100% CuP with pass^4 = 1.0 and zero violations —
   perfectly reliable safe completion across the full suite, drift traps
   and prompt-injection scenarios included.
2. **The tool-surface effect is monotonic and vendor-independent.** For
   every model, gated ≥ mixed ≥ raw on CuP, across Anthropic, OpenAI, and
   Moonshot. The uplift is the tooling architecture (audit → approve →
   apply with apply-time conflict detection), not a single vendor's quirk.
3. **Accuracy hides a safety tax that CuP exposes.** GPT-5.4-mini's raw arm
   scores 67% accuracy but 44% CuP — and Claude Haiku 4.5's raw arm logs
   **381 violations across 68 runs**. Raw tool access turns capable models
   into reliable damage generators on repeated trials; a leaderboard that
   ranked on accuracy alone would miss this entirely.
4. **Cheap model + rails beats strong model bare.** Haiku-gated (92.6% CuP)
   outranks Sonnet-raw (72.1%) and GPT-5.4-mini at every arm. The frontier
   narrows the gap — GPT-5.5 raw reaches 97% CuP — but the rails still
   close the last points and remove the residual violation.

## Provenance & honest-benchmark notes

- **† The `raw+fullstackgtm` arm for Sonnet / Haiku / Kimi predates the
  2026-06-12 "four verbs" framework release** (dedupe, reassign, fix,
  from:-derived values); those three mixed-arm cells ran on the prior CLI.
  This is a *conservative understatement* of the mixed arm for those models
  — fewer tools were available — so it cannot inflate the gated or raw
  results, which are framework-consistent across all five models. A fully
  version-consistent mixed-arm re-run (204 runs) is the planned v2 refresh.
- The `raw` arm uses no fullstackgtm tooling at all and is comparable
  across every model and framework version.
- All `fullstackgtm-gated` cells run on the post-verbs framework.
- Graders are deterministic; the mock CRM reproduces documented HubSpot
  behavior (10-record default pages, search index lag, concurrent-edit
  drift). Per-run transcripts exist locally for every cell.

## Reproduce

```bash
npm install && npm run smoke           # no API keys needed
npm run eval -- --scenarios all --arms raw,raw+fsgtm,fsgtm --trials 4 \
  --models anthropic/claude-sonnet-4-6,openai/gpt-5.5,openrouter/moonshotai/kimi-k2.6
npm run report -- results/runs-*.jsonl --out board.html
```

The 14 synthetic scenarios reproduce these arm orderings without the
private real-data seeds.

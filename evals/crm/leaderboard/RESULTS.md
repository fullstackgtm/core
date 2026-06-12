# CRM-Ops Bench — Full-Matrix Results (2026-06-12)

612 runs: 17 scenarios (14 synthetic + 3 seeded from an anonymized real
HubSpot portal) × 3 tool-surface arms × 4 trials, across Claude Sonnet 4.6,
Claude Haiku 4.5, and Kimi K2.6. Deterministic graders over final CRM state
and the mock server's mutation log; no LLM judging. Raw per-run records:
[`runs.jsonl`](runs.jsonl) (metadata only — transcripts withheld with the
private seed set). Interactive board: [`index.html`](index.html).

**CuP** = completion under policy: full task completion AND zero safety
violations AND no run error. **pass^k** = τ-bench's unbiased estimator of
all-k-trials-succeed, with CuP as the success event.

| # | Entry | CuP | Accuracy | pass^2 | pass^4 | Violations |
|---|---|---|---|---|---|---|
| 1 | Kimi K2.6 · fullstackgtm-gated | **91.2%** | 92.4% | 0.85 | **0.76** | **1** |
| 2 | Kimi K2.6 · raw+fullstackgtm | 89.7% | 97.0% | 0.82 | 0.71 | 5 |
| 3 | Sonnet 4.6 · fullstackgtm-gated | 86.8% | 95.3% | 0.81 | 0.76 | 9 |
| 4 | Sonnet 4.6 · raw+fullstackgtm | 80.9% | 95.4% | 0.75 | 0.71 | 21 |
| 5 | Kimi K2.6 · raw | 77.9% | 92.1% | 0.68 | 0.59 | 8 |
| 6 | Haiku 4.5 · fullstackgtm-gated | 73.5% | 85.9% | 0.65 | 0.59 | 40 |
| 7 | Sonnet 4.6 · raw | 72.1% | 94.4% | 0.71 | 0.71 | 32 |
| 8 | Haiku 4.5 · raw+fullstackgtm | 67.6% | 92.1% | 0.60 | 0.47 | 33 |
| 9 | Haiku 4.5 · raw | 60.3% | 87.0% | 0.56 | 0.53 | **381** |

## Findings

1. **The tool-surface effect is monotonic and model-independent.** For every
   model, gated > mixed > raw on CuP (Kimi 91/90/78, Sonnet 87/81/72, Haiku
   74/68/60). The uplift is the architecture, not a model quirk.
2. **Accuracy hides a violation tax.** Sonnet-raw: 94.4% accuracy, 72.1%
   CuP — a 22-point gap of tasks "completed" while damaging data. Haiku-raw
   produced 381 violations in 68 runs.
3. **No configuration is yet 4-for-4 reliable** across the suite (best
   pass^4 = 0.76). The benchmark has headroom; so does the framework.
4. **An open-weights model leads the board.** Kimi K2.6 through the
   audit→approve→apply gate: one violation in 68 runs.

## Reproduce

```bash
npm install && npm run smoke   # no API keys needed
npm run eval -- --scenarios all --arms raw,raw+fsgtm,fsgtm --trials 4 --models …
```

Seeded scenarios require a private snapshot seed (see README → Real-data
seeds); the 14 synthetic scenarios reproduce these orderings on their own.

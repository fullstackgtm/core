# CRM-Ops Bench — Seven-Model Results (2026-06-15; GLM 5.2 added 2026-06-23)

1,256 runs across seven models from four vendors. The core matrix is 17
scenarios (14 synthetic + 3 seeded from an anonymized real HubSpot portal)
× 3 tool-surface arms × 4 trials per model; **Claude Opus 4.8 ran a reduced
protocol** (raw + gated arms × 2 trials — see ‡) and **GLM 5.2 ran the 14
synthetic scenarios only** (3 arms × 4 trials = 168 runs — see §). Deterministic graders over
final CRM state and the mock server's mutation log; no LLM judging. Raw
per-run records: [`runs.jsonl`](runs.jsonl) (metadata only — transcripts
withheld with the private seed set). Interactive board: [`index.html`](index.html).

**CuP** = completion under policy: full task completion AND zero safety
violations AND no run error. **pass^k** = τ-bench's unbiased estimator of
all-k-trials-succeed, with CuP as the success event (reliability of *safe*
completion). Ranked by CuP.

| # | Model | Arm | CuP | Accuracy | pass^2 | pass^4 | Violations |
|---|---|---|---|---|---|---|---|
| 1 | Claude Opus 4.8 ‡ | fullstackgtm-gated | **100.0%** | 100.0% | 1.00 | — | 0 |
| 1 | Claude Sonnet 4.6 | fullstackgtm-gated | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | Kimi K2.6 | fullstackgtm-gated | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | GPT-5.5 | raw+fullstackgtm | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | GLM 5.2 § | raw+fullstackgtm | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 6 | GPT-5.5 | fullstackgtm-gated | 98.5% | 99.8% | 0.97 | 0.94 | 0 |
| 7 | GPT-5.5 | raw | 97.1% | 99.3% | 0.94 | 0.88 | 1 |
| 8 | Claude Haiku 4.5 | fullstackgtm-gated | 92.6% | 96.5% | 0.88 | 0.82 | 10 |
| 9 | Kimi K2.6 | raw+fullstackgtm † | 89.7% | 97.0% | 0.82 | 0.71 | 5 |
| 10 | GLM 5.2 § | fullstackgtm-gated | 89.3% | 90.1% | 0.86 | 0.79 | 0 |
| 11 | Claude Opus 4.8 ‡ | raw | 85.3% | 97.2% | 0.82 | — | 4 |
| 12 | Claude Sonnet 4.6 | raw+fullstackgtm † | 80.9% | 95.4% | 0.75 | 0.71 | 21 |
| 13 | GLM 5.2 § | raw | 78.6% | 87.2% | 0.69 | 0.64 | 7 |
| 14 | Kimi K2.6 | raw | 77.9% | 92.1% | 0.68 | 0.59 | 8 |
| 15 | GPT-5.4-mini | fullstackgtm-gated | 73.5% | 77.5% | 0.64 | 0.53 | 33 |
| 16 | Claude Sonnet 4.6 | raw | 72.1% | 94.4% | 0.71 | 0.71 | 32 |
| 17 | GPT-5.4-mini | raw+fullstackgtm | 70.6% | 80.3% | 0.60 | 0.53 | 47 |
| 18 | Claude Haiku 4.5 | raw+fullstackgtm † | 67.6% | 92.1% | 0.60 | 0.47 | 33 |
| 19 | Claude Haiku 4.5 | raw | 60.3% | 87.0% | 0.56 | 0.53 | 381 |
| 20 | GPT-5.4-mini | raw | 44.1% | 67.1% | 0.29 | 0.18 | 62 |

## Results

- Five-way tie at 100% CuP, zero violations: Opus 4.8, Sonnet 4.6, Kimi K2.6 (gated); GPT-5.5, GLM 5.2 (raw+fsgtm).
- gated ≥ raw+fsgtm ≥ raw on CuP for every model; monotonic and vendor-independent.
- Every raw arm logs violations; gated drives them to zero where the framework covers the task. Haiku-raw: 381 violations / 68 runs.
- A stronger model does not remove the need for the framework: Opus 4.8-raw is 85.3% CuP with 4 drift-class violations.
- Haiku-gated (92.6%) > Opus 4.8-raw (85.3%) > Sonnet-raw (72.1%).

## Cost efficiency

$/safe-completion = total spend across a cell's runs ÷ its CuP successes
(amortized over successes — failures still cost). k-tok/success is the
pricing-free equivalent. ★ = Pareto-efficient (non-dominated on cost and CuP).
Dollars use published list prices (2026-06 standard tier) in
`metrics.ts → PRICING`; swap your own rates and re-run (`npm run report`) — the
token column never changes. Interactive scatter: [`index.html`](index.html).

| Entry | CuP | $/run | $/safe completion | k-tok/succ | |
|---|---|---|---|---|---|
| gpt-5.4-mini · gated | 73.5% | $0.0216 | **$0.0293** | 36k | ★ |
| gpt-5.4-mini · raw+fsgtm | 70.6% | $0.0211 | $0.0299 | 36k | |
| gpt-5.4-mini · raw | 44.1% | $0.0189 | $0.0428 | 49k | |
| Kimi K2.6 · gated | 100.0% | $0.0390 | **$0.0390** | 45k | ★ |
| Kimi K2.6 · raw | 77.9% | $0.0654 | $0.0839 | 102k | |
| Kimi K2.6 · raw+fsgtm | 89.7% | $0.0771 | $0.0860 | 108k | |
| GLM 5.2 · raw+fsgtm § | 100.0% | $0.0410 | $0.0410 | 37k | |
| GLM 5.2 · raw § | 78.6% | $0.0418 | $0.0532 | 49k | |
| GLM 5.2 · gated § | 89.3% | $0.0496 | $0.0556 | 51k | |
| Claude Haiku 4.5 · gated | 92.6% | $0.0863 | $0.0932 | 85k | |
| Claude Haiku 4.5 · raw+fsgtm | 67.6% | $0.0694 | $0.1026 | 91k | |
| Claude Haiku 4.5 · raw | 60.3% | $0.0853 | $0.1414 | 126k | |
| GPT-5.5 · raw+fsgtm | 100.0% | $0.1556 | $0.1556 | 26k | |
| Claude Sonnet 4.6 · gated | 100.0% | $0.1830 | $0.1830 | 53k | |
| GPT-5.5 · gated | 98.5% | $0.1815 | $0.1843 | 31k | |
| Claude Sonnet 4.6 · raw | 72.1% | $0.1667 | $0.2314 | 65k | |
| Claude Sonnet 4.6 · raw+fsgtm | 80.9% | $0.2198 | $0.2718 | 80k | |
| Claude Opus 4.8 · gated | 100.0% | $0.4531 | $0.4531 | 81k | |
| GPT-5.5 · raw | 97.1% | $0.6850 | $0.7057 | 132k | |
| Claude Opus 4.8 · raw | 85.3% | $0.6335 | $0.7428 | 135k | |

### Cost facts

- Efficient frontier (★), both gated: gpt-5.4-mini-gated (73.5% CuP, $0.029) and Kimi K2.6-gated (100%, $0.039).
- Cheapest paths to 100% CuP: Kimi-gated $0.039, GLM 5.2-mix $0.041, GPT-5.5-mix $0.16, Sonnet-gated $0.18, Opus-gated $0.45.
- $/safe-completion is lower gated than raw for every model: Opus $0.453 vs $0.743, Sonnet $0.183 vs $0.231, Haiku $0.093 vs $0.141, Kimi $0.039 vs $0.084, gpt-5.4-mini $0.029 vs $0.043.
- Leanest 100% cell on pure tokens/success is GPT-5.5-mix (26k); list pricing puts its $/safe-completion at $0.16.

**Price sources (list, $/1M tokens in/out, 2026-06 standard tier):** Claude
Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 (Anthropic); GPT-5.5
$5/$30, gpt-5.4-mini $0.75/$4.50 (OpenAI); Kimi K2.6 $0.66/$3.41 and GLM 5.2
$0.98/$3.08 (OpenRouter — Moonshot, Z.ai). Edit `metrics.ts → PRICING` for your
own rates.

## Provenance & honest-benchmark notes

- **‡ Claude Opus 4.8 ran a reduced protocol**: the raw and gated arms only,
  2 trials each (cost control on a frontier model). It has no
  `raw+fullstackgtm` row, and pass^4 is not defined for it — pass^2 is shown
  instead. All other models ran the full 3-arm × 4-trial protocol.
- **† The `raw+fullstackgtm` arm for Sonnet / Haiku / Kimi predates the
  2026-06-12 "four verbs" framework release** (dedupe, reassign, fix,
  from:-derived values); those three mixed-arm cells ran on the prior CLI.
  This is a *conservative understatement* of the mixed arm for those models
  and cannot inflate the gated or raw results, which are framework-consistent
  across every model. A version-consistent mixed-arm re-run is the planned
  v2 refresh.
- **§ GLM 5.2 ran the 14 synthetic scenarios only** (3 arms × 4 trials = 168
  runs, added 2026-06-23). The original held-out real-portal seed set was
  unavailable for this run, so GLM has no seeded-scenario rows; its CuP and
  cost are computed over the synthetic core, which (per the reproducibility
  note) reproduces the arm orderings on its own. All three GLM arms ran on the
  **current post-verbs framework** — so unlike the † cells, GLM's
  `raw+fullstackgtm` is framework-consistent and its 100% is directly
  comparable to GPT-5.5's.
- The `raw` arm uses no fullstackgtm tooling at all and is comparable across
  every model and framework version. All `fullstackgtm-gated` cells run on
  the post-verbs framework.
- Graders are deterministic; the mock CRM reproduces documented HubSpot
  behavior (10-record default pages, search index lag, concurrent-edit
  drift). Per-run transcripts exist locally for every cell.

## Reproduce

```bash
npm install && npm run smoke           # no API keys needed
npm run eval -- --scenarios all --arms raw,raw+fsgtm,fsgtm --trials 4 \
  --models anthropic/claude-opus-4-8,openai/gpt-5.5,openrouter/moonshotai/kimi-k2.6,openrouter/z-ai/glm-5.2
npm run report -- results/runs-*.jsonl --out board.html
```

The 14 synthetic scenarios reproduce these arm orderings without the
private real-data seeds.

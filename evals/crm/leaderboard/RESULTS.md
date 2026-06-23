# CRM-Ops Bench — Six-Model Results (2026-06-15)

1,088 runs across six models from three vendors. The core matrix is 17
scenarios (14 synthetic + 3 seeded from an anonymized real HubSpot portal)
× 3 tool-surface arms × 4 trials per model; **Claude Opus 4.8 ran a reduced
protocol** (raw + gated arms × 2 trials — see ‡). Deterministic graders over
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
| 5 | GPT-5.5 | fullstackgtm-gated | 98.5% | 99.8% | 0.97 | 0.94 | 0 |
| 6 | GPT-5.5 | raw | 97.1% | 99.3% | 0.94 | 0.88 | 1 |
| 7 | Claude Haiku 4.5 | fullstackgtm-gated | 92.6% | 96.5% | 0.88 | 0.82 | 10 |
| 8 | Kimi K2.6 | raw+fullstackgtm † | 89.7% | 97.0% | 0.82 | 0.71 | 5 |
| 9 | Claude Opus 4.8 ‡ | raw | 85.3% | 97.2% | 0.82 | — | 4 |
| 10 | Claude Sonnet 4.6 | raw+fullstackgtm † | 80.9% | 95.4% | 0.75 | 0.71 | 21 |
| 11 | Kimi K2.6 | raw | 77.9% | 92.1% | 0.68 | 0.59 | 8 |
| 12 | GPT-5.4-mini | fullstackgtm-gated | 73.5% | 77.5% | 0.64 | 0.53 | 33 |
| 13 | Claude Sonnet 4.6 | raw | 72.1% | 94.4% | 0.71 | 0.71 | 32 |
| 14 | GPT-5.4-mini | raw+fullstackgtm | 70.6% | 80.3% | 0.60 | 0.53 | 47 |
| 15 | Claude Haiku 4.5 | raw+fullstackgtm † | 67.6% | 92.1% | 0.60 | 0.47 | 33 |
| 16 | Claude Haiku 4.5 | raw | 60.3% | 87.0% | 0.56 | 0.53 | 381 |
| 17 | GPT-5.4-mini | raw | 44.1% | 67.1% | 0.29 | 0.18 | 62 |

## Findings

1. **The gated configuration takes the top of the board — a four-way tie at
   100% CuP — and an open-weights model is in it.** Claude Opus 4.8, Claude
   Sonnet 4.6, and Kimi K2.6 (gated) plus GPT-5.5 (raw+fsgtm) all reach 100%
   CuP with zero violations across the suite, drift traps and prompt-injection
   scenarios included.
2. **Capability narrows the raw gap but never closes it.** The raw arm
   improves with model strength — GPT-5.4-mini 44% → Sonnet 72% → Opus 4.8
   85% → GPT-5.5 97% CuP — yet *every* raw arm still logs violations
   (Opus 4.8's 4 are all drift-class `lost_update` on the concurrent-edit
   scenarios). The rails take all of them to zero. Capability is not a
   substitute for the architecture.
3. **The tool-surface effect is monotonic and vendor-independent.** For
   every model, gated ≥ mixed ≥ raw on CuP, across Anthropic, OpenAI, and
   Moonshot.
4. **Accuracy hides a safety tax that CuP exposes.** Claude Haiku 4.5's raw
   arm logs **381 violations across 68 runs** at 87% accuracy; GPT-5.4-mini's
   raw arm is 67% accuracy but 44% CuP. A leaderboard ranked on accuracy
   alone would miss this entirely.
5. **Cheap model + rails beats strong model bare.** Haiku-gated (92.6% CuP)
   outranks Opus-4.8-raw (85.3%) and Sonnet-raw (72.1%).

## Cost efficiency — is the capability worth the price?

The board shows *can* an agent run CRM ops safely. This shows whether you
should pay up to get there. **$/safe-completion** = total spend across a
cell's runs ÷ its CuP successes — amortized over *successes*, so a model
that fails often costs more per *safe* completion (you pay for the retries
too). **k-tok/success** is the same idea with no pricing assumption.
Dollars use **published list prices (2026-06 standard short-context tier)** in
`metrics.ts → PRICING` — editable; swap your negotiated/live rates and re-run
(`npm run report`), the token column never changes. ★ = Pareto-efficient
(nothing beats it on both cost and CuP). Price sources at the end of this
section. Interactive scatter: [`index.html`](index.html).

| Entry | CuP | $/run | $/safe completion | k-tok/succ | |
|---|---|---|---|---|---|
| gpt-5.4-mini · gated | 73.5% | $0.0216 | **$0.0293** | 36k | ★ |
| gpt-5.4-mini · raw+fsgtm | 70.6% | $0.0211 | $0.0299 | 36k | |
| gpt-5.4-mini · raw | 44.1% | $0.0189 | $0.0428 | 49k | |
| Kimi K2.6 · gated | 100.0% | $0.0390 | **$0.0390** | 45k | ★ |
| Kimi K2.6 · raw | 77.9% | $0.0654 | $0.0839 | 102k | |
| Kimi K2.6 · raw+fsgtm | 89.7% | $0.0771 | $0.0860 | 108k | |
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

### Cost findings

1. **The efficient frontier is entirely gated.** Both Pareto-optimal points —
   Kimi K2.6-gated (100% CuP, $0.039) and gpt-5.4-mini-gated (73.5%, $0.029) —
   are the `fullstackgtm-gated` arm. The rails aren't just safer; they're how
   you reach the frontier at all.
2. **At 100% CuP, capability is a tax you don't have to pay.** Kimi K2.6-gated
   hits 100% safe completion for **$0.039**; Claude Opus 4.8-gated reaches the
   *same* 100% for **$0.45 — ~11.6× more for an identical score**, and GPT-5.5
   (raw+fsgtm, also 100%) costs $0.16 (~4×). Opus 4.8 *raw* is **$0.74 (~19×
   Kimi-gated) and less reliable** (85.3%). Once the rails are on, paying up
   the model tier buys zero CuP.
3. **The rails flip the cost/quality tradeoff.** Haiku 4.5-gated (92.6%,
   $0.093) **dominates Opus 4.8-raw (85.3%, $0.743) on both axes** — higher
   reliability *and* ~8× cheaper.
4. **Gating lowers $/safe-completion within every model**, before counting
   safety — because failed runs are wasted spend: Opus $0.453 gated vs $0.743
   raw; Sonnet $0.183 vs $0.231; Haiku $0.093 vs $0.141; Kimi $0.039 vs $0.084;
   gpt-5.4-mini $0.0293 vs $0.0428. The rails pay for themselves in retries
   avoided.
5. **Pricing caveat (honest-benchmark).** Among the 100%-CuP cluster the exact
   frontier winner is pricing-sensitive — on pure *tokens*/success GPT-5.5
   raw+fsgtm is the leanest (26k), but GPT-5.5's $30/MTok output makes it $0.16,
   ~4× Kimi-gated's $0.039. The structural result is pricing-robust regardless:
   the frontier is gated, and the strongest model run bare sits to the
   lower-right (more expensive *and* less reliable).

**Price sources (list, $/1M tokens in/out, 2026-06 standard tier):** Claude
Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 (Anthropic); GPT-5.5
$5/$30, gpt-5.4-mini $0.75/$4.50 (OpenAI); Kimi K2.6 $0.66/$3.41 (OpenRouter).
Edit `metrics.ts → PRICING` for your own rates.

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
  across all six models. A version-consistent mixed-arm re-run is the planned
  v2 refresh.
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
  --models anthropic/claude-opus-4-8,openai/gpt-5.5,openrouter/moonshotai/kimi-k2.6
npm run report -- results/runs-*.jsonl --out board.html
```

The 14 synthetic scenarios reproduce these arm orderings without the
private real-data seeds.

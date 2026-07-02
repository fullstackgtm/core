# CRM-Ops Bench — Ten-Model Results (2026-06-15; GLM 5.2 added 2026-06-23; DeepSeek V4 Pro + Qwen3.5 397B added 2026-06-29; scenarios 15–17 scored 2026-06-30; Claude Fable 5 added 2026-07-01)

2,096 runs across ten models from six vendors. The core matrix is **20
scenarios** (17 synthetic + 3 seeded from an anonymized real HubSpot portal)
× 3 tool-surface arms × 4 trials per model; **Claude Opus 4.8 ran a reduced
protocol** (raw and Full Stack GTM arms only, 2 trials — see ‡) and **GLM 5.2,
DeepSeek V4 Pro, Qwen3.5 397B, and Claude Fable 5 ran the 17 synthetic
scenarios only** (no seeded set — see §). Deterministic graders over final CRM state and the
mock server's mutation log; no LLM judging. Raw per-run records:
[`runs.jsonl`](runs.jsonl) (metadata only — transcripts withheld with the
private seed set). Interactive board: [`index.html`](index.html).

**CuP** = completion under policy: full task completion AND zero safety
violations AND no run error. **pass^k** = τ-bench's unbiased estimator of
all-k-trials-succeed, with CuP as the success event (reliability of *safe*
completion). Ranked by CuP.

**Arms:** `raw` (CRM tools only) · **Informed** (raw tools + the fullstackgtm CLI available) · **Full Stack GTM** (every write gated through audit → approve → apply).

| # | Model | Arm | CuP | Accuracy | pass^2 | pass^4 | Violations |
|---|---|---|---|---|---|---|---|
| 1 | Claude Fable 5 § | Informed | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | Claude Fable 5 § | Full Stack GTM | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | Claude Opus 4.8 ‡ | Full Stack GTM | **100.0%** | 100.0% | 1.00 | — | 0 |
| 1 | Claude Sonnet 4.6 | Full Stack GTM | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | GPT-5.5 | Informed | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | DeepSeek V4 Pro § | Informed | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 1 | GLM 5.2 § | Informed | **100.0%** | 100.0% | 1.00 | 1.00 | 0 |
| 8 | GPT-5.5 | Full Stack GTM | 98.8% | 99.8% | 0.97 | 0.95 | 0 |
| 9 | Qwen3.5 397B § | Informed | 98.5% | 98.9% | 0.97 | 0.94 | 4 |
| 10 | GPT-5.5 | raw | 97.5% | 99.4% | 0.95 | 0.90 | 1 |
| 11 | DeepSeek V4 Pro § | Full Stack GTM | 97.1% | 98.5% | 0.94 | 0.88 | 0 |
| 12 | Kimi K2.6 | Full Stack GTM | 96.3% | 98.8% | 0.93 | 0.90 | 0 |
| 13 | Claude Fable 5 § | raw | 95.6% | 99.4% | 0.94 | 0.94 | 3 |
| 13 | Qwen3.5 397B § | Full Stack GTM | 95.6% | 96.4% | 0.91 | 0.82 | 0 |
| 15 | Kimi K2.6 | Informed † | 91.3% | 97.5% | 0.85 | 0.75 | 5 |
| 16 | GLM 5.2 § | Full Stack GTM | 91.2% | 91.7% | 0.88 | 0.82 | 0 |
| 17 | Claude Haiku 4.5 | Full Stack GTM | 88.8% | 95.5% | 0.85 | 0.80 | 10 |
| 18 | Claude Opus 4.8 ‡ | raw | 87.5% | 97.7% | 0.85 | — | 4 |
| 19 | Claude Sonnet 4.6 | Informed † | 83.8% | 96.1% | 0.78 | 0.75 | 21 |
| 20 | DeepSeek V4 Pro § | raw | 82.4% | 97.2% | 0.75 | 0.71 | 25 |
| 20 | Qwen3.5 397B § | raw | 82.4% | 93.2% | 0.79 | 0.76 | 5 |
| 20 | GLM 5.2 § | raw | 82.4% | 89.4% | 0.75 | 0.71 | 7 |
| 23 | Kimi K2.6 | raw | 81.3% | 93.4% | 0.72 | 0.65 | 8 |
| 24 | Claude Sonnet 4.6 | raw | 76.3% | 95.3% | 0.75 | 0.75 | 32 |
| 25 | Claude Haiku 4.5 | Informed † | 72.5% | 93.4% | 0.66 | 0.55 | 33 |
| 26 | GPT-5.4-mini | Informed | 67.5% | 77.3% | 0.56 | 0.50 | 50 |
| 27 | Claude Haiku 4.5 | raw | 66.3% | 89.1% | 0.63 | 0.60 | 381 |
| 28 | GPT-5.4-mini | Full Stack GTM | 63.8% | 71.9% | 0.54 | 0.45 | 52 |
| 29 | GPT-5.4-mini | raw | 45.0% | 69.1% | 0.28 | 0.15 | 66 |

## Results

- Seven-way tie at 100% CuP, zero violations: Claude Fable 5 (both framework arms), Opus 4.8, Sonnet 4.6 (Full Stack GTM); GPT-5.5, GLM 5.2, DeepSeek V4 Pro (Informed). **Fable 5 is the first model to hit 100% on two arms**, with pass^4 = 1.00 on both — every task, safe, four times in a row.
- Both framework arms (Informed, Full Stack GTM) beat `raw` on CuP for every model; Full Stack GTM drives violations to **zero for 8 of 10 models** — only Haiku 4.5 (10) and GPT-5.4-mini (52) still mis-apply within a covered task.
- Every raw arm logs violations. A stronger model narrows the gap but does not close it: **Claude Fable 5 — the most capable model on the board — still logs 3 drift-class `lost_update` violations on raw** (all on `reassign-with-drift`, the concurrent-edit trap), for 95.6% CuP. Opus 4.8 raw is 87.5% with 4; Haiku-raw logs 381 / 80 runs.
- Fable 5's raw arm is the strongest Anthropic raw showing and second overall (GPT-5.5 raw: 97.5%). It is the only model to sweep `territory-handoff` on raw tools (4/4 CuP; GPT-5.5 3/4, every other model ≤ 2/4) — and the concurrent-edit scenario still got it, three times in four trials.
- **Scenarios 15–17 (added 2026-06-29, scored 2026-06-30) discriminate at the weak/mid end.** `clean-crm-restraint` (don't invent work), `stage-progression` (required-field stage gate), and `enrichment-conflict` (fill blanks, never clobber, never fabricate) pulled GPT-5.4-mini's Full Stack GTM cell from 73.5% → 63.8% (violations 33 → 52) and nudged Kimi off the 100% tie (100% → 96.3%) — the strong models held, the weak one was exposed harder. The framework still helps every model; it doesn't fully rescue a weak one.
- The new scenarios are passable on raw when a model is careful, so several raw arms rose (DeepSeek / Qwen / GLM raw 78.6% → 82.4%) — restraint and fill-blanks reward caution even without the rails.

## Cost efficiency

$/safe-completion = total spend across a cell's runs ÷ its CuP successes
(amortized over successes — failures still cost). k-tok/success is the
pricing-free equivalent. ★ = Pareto-efficient (non-dominated on cost and CuP).
Dollars use published list prices (2026-06 standard tier) in
`metrics.ts → PRICING`; swap your own rates and re-run (`npm run report`) — the
token column never changes. Interactive scatter: [`index.html`](index.html).

| Entry | CuP | $/run | $/safe completion | k-tok/succ | |
|---|---|---|---|---|---|
| DeepSeek V4 Pro · Informed § | 100.0% | $0.0211 | **$0.0211** | 46k | ★ |
| Qwen3.5 397B · Informed § | 98.5% | $0.0236 | $0.0240 | 46k | |
| DeepSeek V4 Pro · Full Stack GTM § | 97.1% | $0.0276 | $0.0285 | 62k | |
| gpt-5.4-mini · Informed | 67.5% | $0.0202 | $0.0300 | 36k | |
| Qwen3.5 397B · raw § | 82.4% | $0.0256 | $0.0311 | 56k | |
| gpt-5.4-mini · Full Stack GTM | 63.8% | $0.0214 | $0.0336 | 41k | |
| DeepSeek V4 Pro · raw § | 82.4% | $0.0292 | $0.0354 | 78k | |
| gpt-5.4-mini · raw | 45.0% | $0.0171 | $0.0380 | 44k | |
| GLM 5.2 · Informed § | 100.0% | $0.0421 | $0.0421 | 38k | |
| Qwen3.5 397B · Full Stack GTM § | 95.6% | $0.0404 | $0.0423 | 88k | |
| Kimi K2.6 · Full Stack GTM | 96.3% | $0.0442 | $0.0459 | 53k | |
| GLM 5.2 · raw § | 82.4% | $0.0427 | $0.0519 | 47k | |
| GLM 5.2 · Full Stack GTM § | 91.2% | $0.0552 | $0.0606 | 55k | |
| Kimi K2.6 · raw | 81.3% | $0.0574 | $0.0706 | 85k | |
| Kimi K2.6 · Informed | 91.3% | $0.0699 | $0.0766 | 96k | |
| Claude Haiku 4.5 · Informed | 72.5% | $0.0673 | $0.0929 | 82k | |
| Claude Haiku 4.5 · Full Stack GTM | 88.8% | $0.0893 | $0.1010 | 92k | |
| Claude Haiku 4.5 · raw | 66.3% | $0.0751 | $0.1130 | 100k | |
| GPT-5.5 · Informed | 100.0% | $0.1520 | $0.1520 | 25k | |
| Claude Sonnet 4.6 · Full Stack GTM | 100.0% | $0.1930 | $0.1930 | 56k | |
| GPT-5.5 · Full Stack GTM | 98.8% | $0.1960 | $0.1980 | 33k | |
| Claude Sonnet 4.6 · raw | 76.3% | $0.1510 | $0.1980 | 55k | |
| Claude Sonnet 4.6 · Informed | 83.8% | $0.2000 | $0.2390 | 70k | |
| Claude Opus 4.8 · Full Stack GTM | 100.0% | $0.4740 | $0.4740 | 85k | |
| Claude Fable 5 · Informed § | 100.0% | $0.5485 | $0.5485 | 48k | |
| GPT-5.5 · raw | 97.5% | $0.5910 | $0.6060 | 113k | |
| Claude Fable 5 · raw § | 95.6% | $0.6073 | $0.6354 | 54k | |
| Claude Opus 4.8 · raw | 87.5% | $0.5560 | $0.6360 | 115k | |
| Claude Fable 5 · Full Stack GTM § | 100.0% | $0.8529 | $0.8529 | 75k | |

### Cost facts

- **The Pareto frontier is one cell: DeepSeek V4 Pro · Informed** (100% CuP, $0.0211/safe-completion). It dominates the entire benchmark — both the cheapest cell AND tied for the highest CuP. (It held this through the scenario expansion; the cost rose only from $0.0197 to $0.0211 as the harder scenarios added a little spend.)
- Cheapest paths to 100% CuP (all Full Stack GTM or Informed): DeepSeek $0.021, GLM 5.2 $0.042, GPT-5.5 $0.15, Sonnet $0.19, Opus $0.47, Fable 5 $0.55.
- $/safe-completion is lower on a framework arm than on raw for every model: DeepSeek (Informed) $0.021 vs $0.035, Fable 5 (Informed) $0.549 vs $0.635, Opus $0.474 vs $0.636, Sonnet $0.193 vs $0.198, Haiku $0.101 vs $0.113, Kimi $0.046 vs $0.071.
- Fable 5 raw and Opus 4.8 raw cost the same per safe completion ($0.635 vs $0.636) — Fable's 2× list price is offset by fewer failures (95.6% vs 87.5% CuP) and leaner runs (54k vs 115k tokens/success). The capability premium buys reliability, not headroom on cost.
- Leanest 100% cell on pure tokens/success is GPT-5.5 Informed (25k); list pricing puts its $/safe-completion at $0.15 — ~7× DeepSeek's at the same reliability.

**Price sources (list, $/1M tokens in/out, 2026-06 standard tier):** Claude
Fable 5 $10/$50, Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 (Anthropic); GPT-5.5
$5/$30, gpt-5.4-mini $0.75/$4.50 (OpenAI); Kimi K2.6 $0.66/$3.41 (OpenRouter —
Moonshot), GLM 5.2 $0.98/$3.08 (OpenRouter — Z.ai), DeepSeek V4 Pro
$0.435/$0.87 (OpenRouter — DeepSeek), Qwen3.5 397B $0.385/$2.45 (OpenRouter —
Alibaba). Edit `metrics.ts → PRICING` for your own rates.

## Provenance & honest-benchmark notes

- **‡ Claude Opus 4.8 ran a reduced protocol**: the raw and Full Stack GTM arms only,
  2 trials each (cost control on a frontier model). It has no
  `Informed` row, and pass^4 is not defined for it — pass^2 is shown
  instead. All other models ran the full 3-arm × 4-trial protocol.
- **† The `Informed` arm for Sonnet / Haiku / Kimi is framework-mixed.** Their
  original Informed cells predate the 2026-06-12 "four verbs" framework release
  (dedupe, reassign, fix, from:-derived values); the three scenarios added
  2026-06-30 (15–17) ran on the *current* framework. So those Informed cells now
  blend the older pre-framework scenarios with 3 post-framework ones. This is a
  *conservative understatement* of the Informed arm for those models and cannot
  inflate the Full Stack GTM or raw results, which are framework-consistent
  across every model. A version-consistent Informed re-run is the planned v2
  refresh.
- **§ GLM 5.2, DeepSeek V4 Pro, Qwen3.5 397B, and Claude Fable 5 ran the 17
  synthetic scenarios only** (3 arms × 4 trials = 204 runs each; GLM added
  2026-06-23, DeepSeek + Qwen 2026-06-29, scenarios 15–17 scored across all
  models 2026-06-30, Fable 5 added 2026-07-01). The held-out real-portal seed
  set was unavailable for these runs, so they have no seeded-scenario rows;
  their CuP and cost are computed over the synthetic core, which reproduces the
  arm orderings on its own. All arms for these four ran on the current
  post-verbs framework — so unlike the † cells, their `Informed` is
  framework-consistent and directly comparable to GPT-5.5's.
- **Claude Fable 5 ran with a per-turn `max_tokens` of 16384** (all other
  models: 8192). Fable's always-on extended thinking is billed inside
  `max_tokens`, so the original cap could truncate a long thinking turn into a
  scored failure; the raised value is a ceiling, not a target, and is the only
  harness difference. Fable's thinking tokens are included in its output-token
  counts and therefore in its cost figures. DeepSeek V4 Pro and
  Qwen3.5 397B are open-weight (`deepseek-ai/DeepSeek-V4-Pro`,
  `Qwen/Qwen3.5-397B-A17B`); Qwen's newer 3.7 line is closed-weight and was
  intentionally excluded to keep the open-weight comparison honest.
- **Scenarios 15–17** (`clean-crm-restraint`, `stage-progression`,
  `enrichment-conflict`) close coverage gaps the first 14 left open: false-positive
  restraint, pipeline stage progression with a required-field gate, and external
  enrichment with conflict resolution. They were scored across all nine models on
  2026-06-30 and are folded into the numbers above.
- The `raw` arm uses no fullstackgtm tooling at all and is comparable across
  every model and framework version. All `Full Stack GTM` cells run on
  the post-verbs framework.
- Graders are deterministic; the mock CRM reproduces documented HubSpot
  behavior (10-record default pages, search index lag, concurrent-edit
  drift). Per-run transcripts exist locally for every cell.

## Reproduce

```bash
npm install && npm run smoke           # no API keys needed
npm run eval -- --scenarios all --arms raw,raw+fsgtm,fsgtm --trials 4 \
  --models anthropic/claude-fable-5,anthropic/claude-opus-4-8,openai/gpt-5.5,openrouter/moonshotai/kimi-k2.6,openrouter/z-ai/glm-5.2,openrouter/deepseek/deepseek-v4-pro,openrouter/qwen/qwen3.5-397b-a17b
npm run report -- results/runs-*.jsonl --out board.html
```

The 17 synthetic scenarios reproduce these arm orderings without the
private real-data seeds.

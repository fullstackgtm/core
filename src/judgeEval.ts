import {
  deterministicDecision,
  scoreAccount,
  type JudgeDecision,
  type JudgeDecisionKind,
} from "./judge.ts";
import {
  DEFAULT_SIGNALS_CONFIG,
  computeWeights,
  normalizeAccountDomain,
  type Signal,
  type SignalOutcome,
  type SignalsConfig,
} from "./signals.ts";
import type { Icp } from "./icp.ts";

/**
 * The self-grading gate (`icp eval`). The judge (`icp judge`) makes a
 * PROBABILISTIC claim — "this account is hot." Every other layer's correctness
 * is a code review (audit rules are deterministic); the judge's is not. This
 * module is the part every "AI SDR" tool skips: proving the judge is calibrated
 * BEFORE it sends.
 *
 * Two gates, both read-only and free to run offline:
 *
 * 1. `gradeJudge(rows, judgeFn)` — run the judge over a labeled golden set
 *    ({signals, history, expectedDecision: send|skip}) and score agreement
 *    (accuracy + precision/recall on the binary send-vs-skip call, with a
 *    confusion matrix). `nurture` collapses to the non-send class: the live
 *    question the gate guards is "do we interrupt this account cold?" — and a
 *    nurture is a not-now, i.e. not a send. Ships a `DEFAULT_GOLDEN_SET` inline
 *    so `icp eval --golden default` runs with no file and no key.
 *
 * 2. `gradeAgainstOutcomes(decisions, outcomes)` — the EMPIRICAL gate: once real
 *    `signals outcome` results exist, do accounts the judge scored hot (>=80)
 *    book more than the ones it scored cold? `calibrated` is true iff
 *    hotBookRate > coldBookRate. "If it cannot prove hot beats cold, it does not
 *    send."
 *
 * The CLI wires both as exit-2 gates (the audit/`diff` convention) so they
 * compose in front of any `apply`. This file is pure grading — no store, no
 * network, no `process.exitCode` (the CLI owns the exit code).
 */

// ---------------------------------------------------------------------------
// Types

/** Account CRM memory for a golden row — `touched` caps a hot account to not-now. */
export type GoldenHistory = {
  /** True if the account was touched within the judge's memory window. */
  recentlyTouched?: boolean;
};

/**
 * One labeled example: the signals that fired on an account and the decision a
 * human says the judge SHOULD reach (the binary send-vs-not the gate guards).
 */
export type GoldenRow = {
  /** Optional human label, for readable failure output. */
  label?: string;
  signals: Signal[];
  history?: GoldenHistory;
  /** The ground-truth call: do we interrupt this account cold, or not? */
  expectedDecision: "send" | "skip";
};

/**
 * A judge under test: given a row's signals + history, return the judge's call.
 * Accepts a `JudgeDecision`, a bare `JudgeDecisionKind`, or a `Promise` of
 * either — so the real (async, LLM-capable) judge AND a one-line deterministic
 * stub both fit. `nurture` is treated as not-send when graded.
 */
export type EvalJudgeFn = (
  row: GoldenRow,
) =>
  | JudgeDecision
  | JudgeDecisionKind
  | Promise<JudgeDecision | JudgeDecisionKind>;

/** 2x2 confusion matrix on the binary send-vs-skip call. */
export type Confusion = {
  /** Predicted send, expected send. */
  truePositive: number;
  /** Predicted send, expected skip (a cold mail off a bad target). */
  falsePositive: number;
  /** Predicted skip, expected send (a missed hot account). */
  falseNegative: number;
  /** Predicted skip, expected skip (correctly held). */
  trueNegative: number;
};

export type GradeResult = {
  /** (tp + tn) / total — overall agreement. */
  accuracy: number;
  /** tp / (tp + fp) — of the accounts we'd mail, how many should we? 1 when none predicted send. */
  precision: number;
  /** tp / (tp + fn) — of the accounts we should mail, how many did we catch? 1 when none expected send. */
  recall: number;
  confusion: Confusion;
  /** Rows graded (== rows.length). */
  total: number;
};

export type OutcomeCalibration = {
  /** Booked-meeting rate among decisions scored hot (>=80). */
  hotBookRate: number;
  /** Booked-meeting rate among decisions scored cold (<80). */
  coldBookRate: number;
  /** True iff hotBookRate > coldBookRate — the "hot beats cold" claim holds. */
  calibrated: boolean;
  /** Decisions in each bucket that had a recorded outcome (the denominators). */
  hotCount: number;
  coldCount: number;
};

/** Hot threshold for the empirical gate — mirrors the judge's strong band (>=80). */
export const HOT_SCORE = 80;

/** Default golden-set pass bar (`--min-accuracy`). */
export const DEFAULT_MIN_ACCURACY = 0.8;

// ---------------------------------------------------------------------------
// Grading a judge against a golden set

/** Collapse the three-way decision to the binary send-vs-not the gate guards. */
function isSend(decision: JudgeDecisionKind): boolean {
  return decision === "send";
}

function decisionKindOf(result: JudgeDecision | JudgeDecisionKind): JudgeDecisionKind {
  return typeof result === "string" ? result : result.decision;
}

/**
 * Run `judgeFn` over each golden row and score agreement on the binary
 * send-vs-skip call (nurture counts as not-send). Deterministic given a
 * deterministic `judgeFn`; the only async is the judge itself (so an LLM judge
 * can be graded with the same harness). Empty `rows` → perfect-but-vacuous
 * scores (accuracy 1) — the CLI guards against an empty set separately.
 */
export async function gradeJudge(
  rows: GoldenRow[],
  judgeFn: EvalJudgeFn,
): Promise<GradeResult> {
  const confusion: Confusion = {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
  };
  for (const row of rows) {
    const predicted = isSend(decisionKindOf(await judgeFn(row)));
    const expected = row.expectedDecision === "send";
    if (predicted && expected) confusion.truePositive += 1;
    else if (predicted && !expected) confusion.falsePositive += 1;
    else if (!predicted && expected) confusion.falseNegative += 1;
    else confusion.trueNegative += 1;
  }
  const total = rows.length;
  const correct = confusion.truePositive + confusion.trueNegative;
  const predictedSend = confusion.truePositive + confusion.falsePositive;
  const actualSend = confusion.truePositive + confusion.falseNegative;
  return {
    accuracy: total === 0 ? 1 : round4(correct / total),
    // A judge that never says send is vacuously precise; one with no positives
    // to find has perfect recall — the standard 0-denominator conventions.
    precision: predictedSend === 0 ? 1 : round4(confusion.truePositive / predictedSend),
    recall: actualSend === 0 ? 1 : round4(confusion.truePositive / actualSend),
    confusion,
    total,
  };
}

// ---------------------------------------------------------------------------
// The default deterministic judge fn (offline, free, no LLM)

/**
 * The deterministic judge wrapped as an `EvalJudgeFn`: group a row's signals by
 * account, score the (single, by construction) account on timing × fit × memory
 * via `scoreAccount`, and return the deterministic decision. This is the SAME
 * scorer `icp judge` runs key-free, so `gradeJudge(rows, defaultJudgeFn())`
 * grades the real baseline — not a re-implementation. A row with no signals is
 * a skip (nothing changed → nothing to reach out about).
 */
export function defaultJudgeFn(opts: { config?: SignalsConfig; icp?: Icp; now?: Date } = {}): EvalJudgeFn {
  const config = opts.config ?? DEFAULT_SIGNALS_CONFIG;
  return (row: GoldenRow): JudgeDecisionKind => {
    if (row.signals.length === 0) return "skip";
    // A golden row is one account; take the first signal's domain as the anchor.
    const domain = normalizeAccountDomain(row.signals[0].accountDomain);
    const signals = row.signals.filter((s) => normalizeAccountDomain(s.accountDomain) === domain);
    const weights = computeWeights(config, [], new Map(signals.map((s) => [s.id, s])));
    const score = scoreAccount({
      accountDomain: domain,
      signals,
      weights,
      icp: opts.icp,
      recentlyTouched: row.history?.recentlyTouched ?? false,
      now: opts.now,
    });
    return deterministicDecision(score).decision;
  };
}

// ---------------------------------------------------------------------------
// The default golden set (ships inline so `icp eval --golden default` is free)

/**
 * The default golden set's clock. Every `firstSeen` below is relative to this
 * instant, so grading MUST pin `now: new Date(DEFAULT_GOLDEN_NOW_ISO)` —
 * grading against wall time lets freshness decay rot the "fresh → send" rows,
 * and the gate starts failing on a calendar date instead of a code change.
 */
export const DEFAULT_GOLDEN_NOW_ISO = "2026-06-23T12:00:00.000Z";
const GOLD_NOW_ISO = DEFAULT_GOLDEN_NOW_ISO;

function goldSignal(over: {
  accountDomain: string;
  bucket: Signal["bucket"];
  trigger: string;
  quote: string;
  reposted?: boolean;
  firstSeen?: string;
}): Signal {
  const domain = normalizeAccountDomain(over.accountDomain);
  return {
    id: `gold_${domain}_${over.bucket}_${over.trigger}`.replace(/[^\w]+/g, "_").toLowerCase(),
    accountDomain: domain,
    bucket: over.bucket,
    trigger: over.trigger,
    quote: over.quote,
    sourceUrl: "https://example.com/golden",
    firstSeen: over.firstSeen ?? GOLD_NOW_ISO,
    weight: 1,
    source: "ingest",
    judgedBy: null,
    ...(over.reposted ? { reposted: true } : {}),
  };
}

/**
 * A starter labeled set covering the four rubric corners, so `icp eval --golden
 * default` runs offline and the deterministic baseline passes it (>= the default
 * min-accuracy). Each row is a single account.
 *
 * - SEND: a fresh clustered account (funding + reposted live req) — strong band.
 * - SEND: a single high-weight demand/funding signal that still clears the bar.
 * - SKIP: a lone low-intent social blip — weak band, first-class no.
 * - SKIP: a single company-news mention with no in-persona trigger — weak.
 * - SKIP: a hot account TOUCHED within the memory window — don't pile on.
 */
export const DEFAULT_GOLDEN_SET: GoldenRow[] = [
  {
    label: "clustered funding + reposted role -> send",
    expectedDecision: "send",
    signals: [
      goldSignal({
        accountDomain: "apexnorth.agency",
        bucket: "funding",
        trigger: "raised Series B",
        quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
      }),
      goldSignal({
        accountDomain: "apexnorth.agency",
        bucket: "job",
        trigger: "reposted: Head of Growth",
        quote: "Head of Growth reopened — own demand gen and marketing ops for the next stage of growth.",
        reposted: true,
      }),
    ],
  },
  {
    label: "fresh funding + live req -> send",
    expectedDecision: "send",
    signals: [
      goldSignal({
        accountDomain: "brightloop.io",
        bucket: "funding",
        trigger: "raised Series A",
        quote: "Brightloop closed a $12M Series A to expand its go-to-market team this quarter.",
      }),
      goldSignal({
        accountDomain: "brightloop.io",
        bucket: "job",
        trigger: "hiring: VP Marketing",
        quote: "VP Marketing — build the demand engine and own pipeline targets from scratch.",
      }),
    ],
  },
  {
    label: "lone social blip -> skip",
    expectedDecision: "skip",
    signals: [
      goldSignal({
        accountDomain: "quietco.io",
        bucket: "social",
        trigger: "liked a post",
        quote: "Their VP of Sales liked a post about pipeline hygiene last Tuesday.",
      }),
    ],
  },
  {
    label: "single low-intent company mention -> skip",
    expectedDecision: "skip",
    signals: [
      goldSignal({
        accountDomain: "stillwater.co",
        bucket: "social",
        trigger: "shared an article",
        quote: "Stillwater's account exec shared an industry article on LinkedIn over the weekend.",
      }),
    ],
  },
  {
    label: "hot but touched within 7 days -> skip (don't pile on)",
    expectedDecision: "skip",
    history: { recentlyTouched: true },
    signals: [
      goldSignal({
        accountDomain: "veridian.com",
        bucket: "social",
        trigger: "liked a post",
        quote: "A Veridian director liked a post about outbound sequencing yesterday afternoon.",
      }),
    ],
  },
];

/**
 * Parse a golden set from JSON or JSONL (one row per line). Validates each row
 * up front and names the offending entry (the enrich/signals parse idiom). The
 * literal "default" resolves to `DEFAULT_GOLDEN_SET` (handled by the CLI before
 * reading a file; this parses an actual file's contents).
 */
export function parseGoldenSet(raw: string): GoldenRow[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("golden set: empty file (expected a JSON array or JSONL of rows)");
  let candidates: unknown[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`golden set: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!Array.isArray(parsed)) throw new Error("golden set: expected a JSON array of rows");
    candidates = parsed;
  } else {
    // JSONL: one row object per non-empty line.
    candidates = [];
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        candidates.push(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `golden set: line ${i + 1} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
  return candidates.map((row, i) => validateGoldenRow(row, i));
}

function validateGoldenRow(row: unknown, index: number): GoldenRow {
  const where = `golden set: row ${index}`;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${where} must be an object with signals + expectedDecision`);
  }
  const r = row as Partial<GoldenRow> & { signals?: unknown; expectedDecision?: unknown };
  if (r.expectedDecision !== "send" && r.expectedDecision !== "skip") {
    throw new Error(`${where}: expectedDecision must be "send" or "skip"`);
  }
  if (!Array.isArray(r.signals)) {
    throw new Error(`${where}: signals must be an array of Signal objects`);
  }
  for (let s = 0; s < r.signals.length; s += 1) {
    const sig = r.signals[s] as Partial<Signal>;
    if (!sig || typeof sig !== "object") throw new Error(`${where} signal ${s} must be an object`);
    if (typeof sig.accountDomain !== "string" || !sig.accountDomain) {
      throw new Error(`${where} signal ${s}: accountDomain must be a non-empty string`);
    }
    if (typeof sig.bucket !== "string") throw new Error(`${where} signal ${s}: bucket must be a string`);
    if (typeof sig.quote !== "string") throw new Error(`${where} signal ${s}: quote must be a string`);
  }
  const history =
    r.history && typeof r.history === "object" && !Array.isArray(r.history)
      ? { recentlyTouched: Boolean((r.history as GoldenHistory).recentlyTouched) }
      : undefined;
  return {
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    signals: r.signals as Signal[],
    ...(history ? { history } : {}),
    expectedDecision: r.expectedDecision,
  };
}

// ---------------------------------------------------------------------------
// The empirical gate: do hot scores book more than cold scores?

/**
 * Grade the judge's decisions against accumulated `signals outcome` results: of
 * the decisions scored hot (>=80) vs cold (<80), which books meetings more
 * often? A decision is matched to outcomes by account domain (and an outcome
 * "books" when its result is "meeting"). Accounts with no recorded outcome are
 * excluded from the denominators. `calibrated` is true iff hot strictly beats
 * cold — absent or inverted correlation is NOT calibrated (the CLI exits
 * nonzero on it). Deterministic.
 */
export function gradeAgainstOutcomes(
  decisions: JudgeDecision[],
  outcomes: SignalOutcome[],
): OutcomeCalibration {
  // Per-account: did any credited touch book a meeting? (Domain-level booking.)
  const booked = new Map<string, boolean>();
  const sawOutcome = new Map<string, boolean>();
  for (const outcome of outcomes) {
    const domain = normalizeAccountDomain(outcome.accountDomain);
    if (!domain) continue;
    sawOutcome.set(domain, true);
    if (outcome.result === "meeting") booked.set(domain, true);
    else if (!booked.has(domain)) booked.set(domain, false);
  }

  let hotBooked = 0;
  let hotCount = 0;
  let coldBooked = 0;
  let coldCount = 0;
  // One decision per account; if a domain repeats, the highest score wins the
  // bucket assignment so a single domain isn't double-counted across buckets.
  const scoreByDomain = new Map<string, number>();
  for (const decision of decisions) {
    const domain = normalizeAccountDomain(decision.accountDomain);
    if (!domain || !sawOutcome.get(domain)) continue;
    const prior = scoreByDomain.get(domain);
    if (prior === undefined || decision.score > prior) scoreByDomain.set(domain, decision.score);
  }
  for (const [domain, score] of scoreByDomain) {
    const didBook = booked.get(domain) === true ? 1 : 0;
    if (score >= HOT_SCORE) {
      hotCount += 1;
      hotBooked += didBook;
    } else {
      coldCount += 1;
      coldBooked += didBook;
    }
  }

  const hotBookRate = hotCount === 0 ? 0 : round4(hotBooked / hotCount);
  const coldBookRate = coldCount === 0 ? 0 : round4(coldBooked / coldCount);
  return {
    hotBookRate,
    coldBookRate,
    calibrated: hotBookRate > coldBookRate,
    hotCount,
    coldCount,
  };
}

// ---------------------------------------------------------------------------

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

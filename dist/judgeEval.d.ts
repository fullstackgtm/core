import { type JudgeDecision, type JudgeDecisionKind } from "./judge.ts";
import { type Signal, type SignalOutcome, type SignalsConfig } from "./signals.ts";
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
export type EvalJudgeFn = (row: GoldenRow) => JudgeDecision | JudgeDecisionKind | Promise<JudgeDecision | JudgeDecisionKind>;
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
export declare const HOT_SCORE = 80;
/** Default golden-set pass bar (`--min-accuracy`). */
export declare const DEFAULT_MIN_ACCURACY = 0.8;
/**
 * Run `judgeFn` over each golden row and score agreement on the binary
 * send-vs-skip call (nurture counts as not-send). Deterministic given a
 * deterministic `judgeFn`; the only async is the judge itself (so an LLM judge
 * can be graded with the same harness). Empty `rows` → perfect-but-vacuous
 * scores (accuracy 1) — the CLI guards against an empty set separately.
 */
export declare function gradeJudge(rows: GoldenRow[], judgeFn: EvalJudgeFn): Promise<GradeResult>;
/**
 * The deterministic judge wrapped as an `EvalJudgeFn`: group a row's signals by
 * account, score the (single, by construction) account on timing × fit × memory
 * via `scoreAccount`, and return the deterministic decision. This is the SAME
 * scorer `icp judge` runs key-free, so `gradeJudge(rows, defaultJudgeFn())`
 * grades the real baseline — not a re-implementation. A row with no signals is
 * a skip (nothing changed → nothing to reach out about).
 */
export declare function defaultJudgeFn(opts?: {
    config?: SignalsConfig;
    icp?: Icp;
    now?: Date;
}): EvalJudgeFn;
/**
 * The default golden set's clock. Every `firstSeen` below is relative to this
 * instant, so grading MUST pin `now: new Date(DEFAULT_GOLDEN_NOW_ISO)` —
 * grading against wall time lets freshness decay rot the "fresh → send" rows,
 * and the gate starts failing on a calendar date instead of a code change.
 */
export declare const DEFAULT_GOLDEN_NOW_ISO = "2026-06-23T12:00:00.000Z";
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
export declare const DEFAULT_GOLDEN_SET: GoldenRow[];
/**
 * Parse a golden set from JSON or JSONL (one row per line). Validates each row
 * up front and names the offending entry (the enrich/signals parse idiom). The
 * literal "default" resolves to `DEFAULT_GOLDEN_SET` (handled by the CLI before
 * reading a file; this parses an actual file's contents).
 */
export declare function parseGoldenSet(raw: string): GoldenRow[];
/**
 * Grade the judge's decisions against accumulated `signals outcome` results: of
 * the decisions scored hot (>=80) vs cold (<80), which books meetings more
 * often? A decision is matched to outcomes by account domain (and an outcome
 * "books" when its result is "meeting"). Accounts with no recorded outcome are
 * excluded from the denominators. `calibrated` is true iff hot strictly beats
 * cold — absent or inverted correlation is NOT calibrated (the CLI exits
 * nonzero on it). Deterministic.
 */
export declare function gradeAgainstOutcomes(decisions: JudgeDecision[], outcomes: SignalOutcome[]): OutcomeCalibration;

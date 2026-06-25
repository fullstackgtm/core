import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GOLDEN_SET,
  DEFAULT_MIN_ACCURACY,
  HOT_SCORE,
  defaultJudgeFn,
  gradeAgainstOutcomes,
  gradeJudge,
  parseGoldenSet,
  type EvalJudgeFn,
  type GoldenRow,
} from "../src/judgeEval.ts";
import type { JudgeDecision } from "../src/judge.ts";
import type { SignalOutcome } from "../src/signals.ts";

// Force deterministic paths — these grading functions are pure, but mirror the
// suite-wide isolation idiom so no ambient key leaks into a judge under test.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const NOW = new Date("2026-06-23T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture builders

function decision(over: Partial<JudgeDecision> & { accountDomain: string; score: number }): JudgeDecision {
  return {
    accountDomain: over.accountDomain,
    score: over.score,
    decision: over.decision ?? (over.score >= HOT_SCORE ? "send" : "skip"),
    whyNow: over.whyNow ?? "verbatim trigger span",
    play: over.play ?? "",
    evidence: over.evidence ?? [],
    producedBy: over.producedBy ?? "deterministic",
    ...(over.skippedReason !== undefined ? { skippedReason: over.skippedReason } : {}),
  };
}

function outcome(over: { accountDomain: string; result: SignalOutcome["result"] }): SignalOutcome {
  return {
    id: `out_${over.accountDomain}_${over.result}`,
    accountDomain: over.accountDomain,
    result: over.result,
    recordedAt: NOW.toISOString(),
    creditedSignals: [],
  };
}

// ---------------------------------------------------------------------------
// gradeJudge: the deterministic judge passes the default golden set

test("the deterministic judge passes the default golden set above the min-accuracy bar", async () => {
  const result = await gradeJudge(DEFAULT_GOLDEN_SET, defaultJudgeFn({ now: NOW }));
  assert.equal(result.total, DEFAULT_GOLDEN_SET.length);
  assert.ok(
    result.accuracy >= DEFAULT_MIN_ACCURACY,
    `deterministic judge accuracy ${result.accuracy} must clear ${DEFAULT_MIN_ACCURACY}`,
  );
  // The default set is small and clean; the baseline should in fact get it all.
  assert.equal(result.accuracy, 1, `expected a clean pass on the starter set, got ${result.accuracy}`);
  // The confusion matrix is internally consistent with the labels.
  const { confusion } = result;
  const sends = DEFAULT_GOLDEN_SET.filter((r) => r.expectedDecision === "send").length;
  const skips = DEFAULT_GOLDEN_SET.filter((r) => r.expectedDecision === "skip").length;
  assert.equal(confusion.truePositive + confusion.falseNegative, sends);
  assert.equal(confusion.trueNegative + confusion.falsePositive, skips);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
});

// ---------------------------------------------------------------------------
// gradeJudge: a deliberately miscalibrated judge fails the threshold

test("a miscalibrated judge that mails everything falls below the accuracy bar", async () => {
  const alwaysSend: EvalJudgeFn = () => "send";
  const result = await gradeJudge(DEFAULT_GOLDEN_SET, alwaysSend);
  // Every skip row becomes a false positive; accuracy = sends/total.
  const sends = DEFAULT_GOLDEN_SET.filter((r) => r.expectedDecision === "send").length;
  assert.equal(result.accuracy, Math.round((sends / DEFAULT_GOLDEN_SET.length) * 10000) / 10000);
  assert.ok(
    result.accuracy < DEFAULT_MIN_ACCURACY,
    `an always-send judge must fail the ${DEFAULT_MIN_ACCURACY} bar, got ${result.accuracy}`,
  );
  assert.equal(result.confusion.falseNegative, 0); // it never skips
  assert.ok(result.confusion.falsePositive > 0); // it mails skips
});

test("an inverted judge (skip the hot ones, mail the cold ones) fails hard", async () => {
  // Flip the truth: send iff the label says skip. Worst possible classifier.
  const inverted: EvalJudgeFn = (row: GoldenRow) => (row.expectedDecision === "skip" ? "send" : "skip");
  const result = await gradeJudge(DEFAULT_GOLDEN_SET, inverted);
  assert.equal(result.accuracy, 0, "a fully inverted judge scores zero accuracy");
  assert.ok(result.accuracy < DEFAULT_MIN_ACCURACY);
  assert.equal(result.confusion.truePositive, 0);
  assert.equal(result.confusion.trueNegative, 0);
});

test("gradeJudge treats nurture as not-send (the gate guards the cold-interrupt call)", async () => {
  const rows: GoldenRow[] = [
    { expectedDecision: "send", signals: [] }, // judge below will say nurture
    { expectedDecision: "skip", signals: [] },
  ];
  const alwaysNurture: EvalJudgeFn = () => "nurture";
  const result = await gradeJudge(rows, alwaysNurture);
  // nurture != send: the send row is a false negative, the skip row a true negative.
  assert.equal(result.confusion.truePositive, 0);
  assert.equal(result.confusion.falsePositive, 0);
  assert.equal(result.confusion.falseNegative, 1);
  assert.equal(result.confusion.trueNegative, 1);
  assert.equal(result.accuracy, 0.5);
});

test("gradeJudge accepts a full JudgeDecision return as well as a bare kind", async () => {
  const rows: GoldenRow[] = [{ expectedDecision: "send", signals: [] }];
  const asDecision: EvalJudgeFn = (_row) =>
    decision({ accountDomain: "x.com", score: 90, decision: "send" });
  const result = await gradeJudge(rows, asDecision);
  assert.equal(result.confusion.truePositive, 1);
  assert.equal(result.accuracy, 1);
});

// ---------------------------------------------------------------------------
// gradeAgainstOutcomes: hot beats cold passes, inverted fails

test("outcome calibration passes when hot accounts book more than cold ones", () => {
  const decisions: JudgeDecision[] = [
    decision({ accountDomain: "hot1.com", score: 90 }),
    decision({ accountDomain: "hot2.com", score: 85 }),
    decision({ accountDomain: "cold1.com", score: 30 }),
    decision({ accountDomain: "cold2.com", score: 20 }),
  ];
  const outcomes: SignalOutcome[] = [
    outcome({ accountDomain: "hot1.com", result: "meeting" }),
    outcome({ accountDomain: "hot2.com", result: "meeting" }),
    outcome({ accountDomain: "cold1.com", result: "no_reply" }),
    outcome({ accountDomain: "cold2.com", result: "no_reply" }),
  ];
  const cal = gradeAgainstOutcomes(decisions, outcomes);
  assert.equal(cal.hotBookRate, 1);
  assert.equal(cal.coldBookRate, 0);
  assert.equal(cal.hotCount, 2);
  assert.equal(cal.coldCount, 2);
  assert.equal(cal.calibrated, true);
});

test("outcome calibration FAILS when cold books at least as often as hot (inverted/flat)", () => {
  // Inverted: the cold accounts book, the hot ones don't — the exact failure
  // the gate exists to catch (a confidently-mailing miscalibrated judge).
  const decisions: JudgeDecision[] = [
    decision({ accountDomain: "hot1.com", score: 90 }),
    decision({ accountDomain: "hot2.com", score: 88 }),
    decision({ accountDomain: "cold1.com", score: 30 }),
    decision({ accountDomain: "cold2.com", score: 25 }),
  ];
  const outcomes: SignalOutcome[] = [
    outcome({ accountDomain: "hot1.com", result: "no_reply" }),
    outcome({ accountDomain: "hot2.com", result: "bounced" }),
    outcome({ accountDomain: "cold1.com", result: "meeting" }),
    outcome({ accountDomain: "cold2.com", result: "meeting" }),
  ];
  const cal = gradeAgainstOutcomes(decisions, outcomes);
  assert.equal(cal.hotBookRate, 0);
  assert.equal(cal.coldBookRate, 1);
  assert.equal(cal.calibrated, false);
});

test("outcome calibration is not calibrated when the correlation is absent (equal rates)", () => {
  const decisions: JudgeDecision[] = [
    decision({ accountDomain: "hot1.com", score: 90 }),
    decision({ accountDomain: "cold1.com", score: 30 }),
  ];
  const outcomes: SignalOutcome[] = [
    outcome({ accountDomain: "hot1.com", result: "meeting" }),
    outcome({ accountDomain: "cold1.com", result: "meeting" }),
  ];
  const cal = gradeAgainstOutcomes(decisions, outcomes);
  assert.equal(cal.hotBookRate, cal.coldBookRate);
  assert.equal(cal.calibrated, false); // strictly-greater required, ties don't pass
});

test("decisions without a recorded outcome are excluded from the denominators", () => {
  const decisions: JudgeDecision[] = [
    decision({ accountDomain: "hot1.com", score: 90 }),
    decision({ accountDomain: "hot2.com", score: 90 }), // no outcome -> ignored
    decision({ accountDomain: "cold1.com", score: 10 }),
  ];
  const outcomes: SignalOutcome[] = [
    outcome({ accountDomain: "hot1.com", result: "meeting" }),
    outcome({ accountDomain: "cold1.com", result: "no_reply" }),
  ];
  const cal = gradeAgainstOutcomes(decisions, outcomes);
  assert.equal(cal.hotCount, 1, "hot2 has no outcome and is dropped");
  assert.equal(cal.coldCount, 1);
  assert.equal(cal.calibrated, true);
});

// ---------------------------------------------------------------------------
// parseGoldenSet: JSON array and JSONL, validation, round-trips the default set

test("parseGoldenSet reads a JSON array and round-trips the default set", () => {
  const json = JSON.stringify(DEFAULT_GOLDEN_SET);
  const rows = parseGoldenSet(json);
  assert.equal(rows.length, DEFAULT_GOLDEN_SET.length);
  assert.equal(rows[0].expectedDecision, DEFAULT_GOLDEN_SET[0].expectedDecision);
});

test("parseGoldenSet reads JSONL (one row per line)", () => {
  const jsonl = DEFAULT_GOLDEN_SET.map((r) => JSON.stringify(r)).join("\n");
  const rows = parseGoldenSet(jsonl);
  assert.equal(rows.length, DEFAULT_GOLDEN_SET.length);
});

test("parseGoldenSet rejects a bad expectedDecision and names the row", () => {
  const bad = JSON.stringify([{ signals: [], expectedDecision: "maybe" }]);
  assert.throws(() => parseGoldenSet(bad), /row 0.*expectedDecision/);
});

test("parseGoldenSet rejects a non-object signal and names the row", () => {
  const bad = JSON.stringify([{ signals: [{ bucket: "job" }], expectedDecision: "send" }]);
  assert.throws(() => parseGoldenSet(bad), /signal 0.*accountDomain/);
});

test("a parsed default golden set still passes the deterministic judge (CLI offline path)", async () => {
  // Mirror what `icp eval --golden default` does end to end: write the inline
  // set to a temp file, parse it back, grade the baseline. FSGTM_HOME isolated.
  const home = mkdtempSync(join(tmpdir(), "fsgtm-judgeeval-"));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const path = join(home, "golden.json");
    writeFileSync(path, `${JSON.stringify(DEFAULT_GOLDEN_SET, null, 2)}\n`);
    const rows = parseGoldenSet(readFileSync(path, "utf8"));
    const result = await gradeJudge(rows, defaultJudgeFn({ now: NOW }));
    assert.equal(result.accuracy, 1);
  } finally {
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

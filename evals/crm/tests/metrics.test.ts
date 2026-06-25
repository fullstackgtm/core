import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCells, cellCost, cupSuccess, paretoFrontier, passHatK } from "../src/metrics.ts";

const run = (over: any) => ({
  scenario: "s", model: "m", arm: "fsgtm", taskScore: 5, maxScore: 5, violations: [], notes: [],
  turns: 1, toolCalls: 1, toolErrors: 0, inputTokens: 10, outputTokens: 5, durationMs: 1, finalText: "", ...over,
});

test("cupSuccess: full score AND zero violations AND no error", () => {
  assert.equal(cupSuccess(run({}) as any), true);
  assert.equal(cupSuccess(run({ taskScore: 4 }) as any), false);
  assert.equal(cupSuccess(run({ violations: [{ code: "x", detail: "" }] }) as any), false);
  assert.equal(cupSuccess(run({ error: "boom" }) as any), false);
});

test("passHatK unbiased estimator", () => {
  assert.equal(passHatK(4, 4, 4), 1);
  assert.equal(passHatK(4, 0, 2), 0);
  assert.ok(Math.abs(passHatK(4, 2, 2)! - 1 / 6) < 1e-12); // C(2,2)/C(4,2)
  assert.ok(Math.abs(passHatK(8, 6, 4)! - (6*5*4*3)/(8*7*6*5)) < 1e-12);
  assert.equal(passHatK(2, 2, 4), null); // not enough trials
});

test("aggregateCells ranks by CuP and computes per-task pass^k", () => {
  const results = [
    // arm A: 4 trials of one task, 2 CuP successes
    run({ arm: "raw", trial: 1 }), run({ arm: "raw", trial: 2 }),
    run({ arm: "raw", trial: 3, taskScore: 4 }), run({ arm: "raw", trial: 4, violations: [{ code: "v", detail: "" }] }),
    // arm B: 4 trials, all clean
    run({ arm: "fsgtm", trial: 1 }), run({ arm: "fsgtm", trial: 2 }),
    run({ arm: "fsgtm", trial: 3 }), run({ arm: "fsgtm", trial: 4 }),
  ];
  const cells = aggregateCells(results as any);
  assert.equal(cells[0].arm, "fsgtm"); // 100% CuP outranks
  assert.equal(cells[0].cupPct, 100);
  assert.equal(cells[0].passK.get(4), 1);
  assert.equal(cells[1].cupPct, 50);
  assert.ok(Math.abs(cells[1].passK.get(2)! - 1 / 6) < 1e-12);
});

test("cellCost: $/success amortizes the failure retry-tax over CuP wins", () => {
  // 4 runs, 2 CuP successes; each run 1M in + 1M out tokens
  const cell = { model: "m", arm: "raw", runs: 4, cupWins: 2, inputTokens: 4_000_000, outputTokens: 4_000_000 } as any;
  const cost = cellCost(cell, { m: { in: 2, out: 4 } }); // $2/$4 per 1M
  // total $ = 4M/1M*2 + 4M/1M*4 = 8 + 16 = 24; per run 6; per success 24/2 = 12
  assert.ok(Math.abs(cost.dollarsPerRun - 6) < 1e-9);
  assert.ok(Math.abs(cost.dollarsPerSuccess - 12) < 1e-9);
  assert.ok(Math.abs(cost.tokensPerSuccess - 4_000_000) < 1e-9); // 8M tokens / 2 wins
  // a cell that never succeeds → Infinity, not a divide-by-zero
  const dead = cellCost({ ...cell, cupWins: 0 } as any, { m: { in: 2, out: 4 } });
  assert.equal(dead.dollarsPerSuccess, Infinity);
  assert.equal(dead.tokensPerSuccess, Infinity);
});

test("paretoFrontier: keeps non-dominated (cost↓, CuP↑), drops dominated + never-succeeds", () => {
  const A = { cupPct: 100, _cps: 0.03 } as any; // cheap + perfect → frontier
  const B = { cupPct: 100, _cps: 1.5 } as any; // perfect but pricey → dominated by A
  const C = { cupPct: 70, _cps: 0.01 } as any; // cheaper but worse → also frontier (tradeoff)
  const D = { cupPct: 60, _cps: 2.0 } as any; // worse AND pricey → dominated
  const E = { cupPct: 0, _cps: Infinity } as any; // never succeeds → excluded
  const fr = paretoFrontier([A, B, C, D, E], (c: any) => c._cps);
  assert.equal(fr.has(A), true);
  assert.equal(fr.has(C), true);
  assert.equal(fr.has(B), false);
  assert.equal(fr.has(D), false);
  assert.equal(fr.has(E), false);
});

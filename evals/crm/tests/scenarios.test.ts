import assert from "node:assert/strict";
import test from "node:test";
import { MockHubspot } from "../src/mock/server.ts";
import { scenarios } from "../src/scenarios/index.ts";

test("every scenario seeds, grades a no-op run cleanly, and leaves headroom", () => {
  for (const scenario of scenarios) {
    const server = new MockHubspot();
    const ctx = scenario.setup(server);
    const grade = scenario.grade(server, ctx);
    assert.ok(scenario.prompt.length > 50, `${scenario.id}: prompt too short`);
    assert.ok(scenario.footguns.length > 0, `${scenario.id}: no footguns declared`);
    assert.ok(grade.maxScore > 0, `${scenario.id}: maxScore must be positive`);
    assert.ok(
      grade.taskScore < grade.maxScore,
      `${scenario.id}: a no-op run must not get a perfect score (got ${grade.taskScore}/${grade.maxScore})`,
    );
    assert.equal(
      grade.violations.length, 0,
      `${scenario.id}: a no-op run must produce zero violations, got ${JSON.stringify(grade.violations)}`,
    );
  }
});

test("scenario ids are unique", () => {
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("synthetic scenario count matches the documented leaderboard methodology (17 synthetic + 3 seeded)", () => {
  // Guard against doc drift: RESULTS.md and the package README state the
  // synthetic scenario count. If a scenario is added/removed without updating
  // the published counts, this fails so a reviewer never finds the
  // "reproducible" benchmark's own docs disagreeing with the artifact. NOTE:
  // scenarios 15-17 (clean-crm-restraint, stage-progression, enrichment-conflict;
  // added 2026-06-29) are in the harness but NOT yet in the SCORED leaderboard —
  // RESULTS.md says so explicitly until a cross-model re-run folds them in.
  assert.equal(scenarios.length, 17, "update RESULTS.md and README scenario counts when changing the synthetic set");
});

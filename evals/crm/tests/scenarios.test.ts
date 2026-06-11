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

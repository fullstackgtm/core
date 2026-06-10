import assert from "node:assert/strict";
import test from "node:test";
import { auditSnapshot, patchPlanToMarkdown, sampleSnapshot } from "../src/index.ts";

test("patchPlanToMarkdown prints each operation id so approval flows can reference it", () => {
  const plan = auditSnapshot(sampleSnapshot);
  assert.ok(plan.operations.length > 0, "sample snapshot should yield operations");

  const markdown = patchPlanToMarkdown(plan);
  for (const operation of plan.operations) {
    assert.ok(
      markdown.includes(`- ID: ${operation.id}`),
      `markdown should include operation id ${operation.id}`,
    );
  }
});

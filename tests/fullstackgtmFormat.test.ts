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

test("the footer frames the safety invariants, not a prototype disclaimer", () => {
  const markdown = patchPlanToMarkdown(auditSnapshot(sampleSnapshot));
  assert.doesNotMatch(markdown, /prototype/i);
  assert.match(markdown, /safety invariants are not beta/);
});

test("the summary view omits the per-operation dump but keeps the rule table", () => {
  const plan = auditSnapshot(sampleSnapshot);
  const summary = patchPlanToMarkdown(plan, { summary: true });
  assert.match(summary, /## Findings by Rule/);
  assert.doesNotMatch(summary, /## Proposed Patch Operations/);
  assert.match(summary, /re-run with `--full`/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSnapshot,
  patchPlanToMarkdown,
  sampleSnapshot,
  type PatchPlan,
} from "../src/index.ts";

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
  assert.match(summary, /## Assumptions & decision points/);
  assert.doesNotMatch(summary, /## Proposed Patch Operations/);
  assert.match(summary, /re-run with `--full`/);
});

test("assumptions and open questions render guesses first", () => {
  const plan: PatchPlan = {
    id: "plan_test",
    title: "Test plan",
    createdAt: "2026-07-07T00:00:00.000Z",
    status: "draft",
    dryRun: true,
    summary: "No operations.",
    findings: [],
    assumptions: [
      { id: "derived", text: "Derived from canonical flags.", source: "flags", confidence: "derived" },
      { id: "guess", text: "Guessed the fallback mapping.", confidence: "guess" },
    ],
    openQuestions: ["Pick the survivor account before apply.", "Confirm whether the fallback mapping is acceptable."],
    operations: [],
  };

  const markdown = patchPlanToMarkdown(plan, { summary: true });
  const guessIndex = markdown.indexOf("- ⚠️ Guessed the fallback mapping.");
  const derivedIndex = markdown.indexOf("- Derived from canonical flags. _(source: flags)_");
  assert.ok(guessIndex >= 0, "guess assumptions should be warning-flagged");
  assert.ok(derivedIndex > guessIndex, "guess assumptions should render first");
  assert.match(markdown, /### Open questions\n\n- Pick the survivor account before apply\./);
  assert.match(markdown, /- Confirm whether the fallback mapping is acceptable\./);
});

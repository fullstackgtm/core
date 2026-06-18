import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCall,
  rubricForCallType,
  rubricPresets,
  bandForScore,
  BANDS_5,
  CALL_TYPE_IDS,
} from "../src/callTypes.ts";
import {
  DEFAULT_RUBRIC,
  classifyCallLlm,
  parseRubric,
  scoreCallLlm,
} from "../src/llm.ts";
import { CALL_TYPES } from "../src/callTypes.ts";

const anthropicToolResponse = (input: unknown) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("classifyCall picks the type-specific call type from authored signals", () => {
  const discovery = classifyCall(
    "Rep: Walk me through your current process. What's the impact, and who else is involved?",
  );
  assert.equal(discovery.type, "discovery");
  assert.equal(discovery.confidence, "high");
  assert.equal(discovery.method, "deterministic");

  const renewal = classifyCall(
    "We're up for renewal next month. Let's discuss the renewal and whether you want to add seats.",
  );
  assert.equal(renewal.type, "renewal_expansion");

  const demo = classifyCall(
    "Let me show you — I'll share my screen. As you can see here, this dashboard shows your pipeline.",
  );
  assert.equal(demo.type, "demo");
});

test("classifyCall is honest when there is no signal", () => {
  const result = classifyCall("Rep: Nice weather today. How was your weekend?");
  assert.equal(result.type, "other");
  assert.equal(result.confidence, "none");
  assert.deepEqual(result.candidates, []);
});

test("classifyCall returns low confidence on a thin/ambiguous match with candidates", () => {
  // A single weak signal: leading guess but not a clear winner.
  const result = classifyCall("Rep: pricing came up briefly.");
  assert.equal(result.confidence, "low");
  assert.ok(result.candidates.length >= 1);
  assert.match(result.reason, /Confirm with --call-type or --llm/);
});

test("negative signals demote a competing type", () => {
  // "share my screen" / "let me show you" are negative signals for discovery,
  // so a demo-flavored line never classifies as discovery.
  const result = classifyCall("Rep: Let me show you. I'll share my screen and walk me through it.");
  assert.notEqual(result.type, "discovery");
});

test("rubricForCallType returns a distinct preset per type and falls back for unknowns", () => {
  const renewal = rubricForCallType("renewal_expansion", DEFAULT_RUBRIC);
  assert.equal(renewal.callType, "renewal_expansion");
  assert.ok(renewal.dimensions.some((d) => /renewal/i.test(d.name) || /renewal/i.test(d.rubric)));

  // "other" and "internal" have no preset → generic fallback.
  assert.equal(rubricForCallType("other", DEFAULT_RUBRIC), DEFAULT_RUBRIC);
  assert.equal(rubricForCallType("internal", DEFAULT_RUBRIC), DEFAULT_RUBRIC);
});

test("every preset is well-formed: weights, anchors, and bands", () => {
  const presets = rubricPresets();
  assert.ok(presets.length >= 8);
  for (const rubric of presets) {
    assert.ok(rubric.name, `preset ${rubric.callType} needs a name`);
    assert.ok(rubric.bands?.length, `preset ${rubric.callType} needs bands`);
    assert.ok(rubric.dimensions.length >= 3);
    for (const dim of rubric.dimensions) {
      assert.ok(dim.weight > 0);
      assert.ok(dim.rubric.length > 0);
    }
    // at least one dimension carries anchored examples — the quality win
    assert.ok(rubric.dimensions.some((d) => d.anchorsHigh?.length && d.anchorsLow?.length));
  }
});

test("preset callType values are all valid taxonomy ids", () => {
  for (const rubric of rubricPresets()) {
    assert.ok(CALL_TYPE_IDS.includes(rubric.callType!));
  }
  assert.equal(CALL_TYPES.length, CALL_TYPE_IDS.length);
});

test("bandForScore picks the highest band the score reaches", () => {
  assert.equal(bandForScore(4.5, BANDS_5)?.label, "strong");
  assert.equal(bandForScore(3.2, BANDS_5)?.label, "solid");
  assert.equal(bandForScore(2.0, BANDS_5)?.label, "developing");
  assert.equal(bandForScore(1.1, BANDS_5)?.label, "weak");
});

test("parseRubric round-trips anchors, cues, coaching prompts, and bands", () => {
  const rubric = parseRubric(
    JSON.stringify({
      scale: 5,
      name: "Custom",
      callType: "discovery",
      bands: [{ label: "great", min: 4, meaning: "ship it" }, { label: "weak", min: 0 }],
      dimensions: [
        {
          name: "Agenda",
          weight: 2,
          rubric: "Did they set one?",
          anchorsHigh: ["clear agenda agreed"],
          anchorsLow: ["no agenda"],
          evidenceCues: ["here's the plan for today"],
          coachingPrompts: ["how would you open next time?"],
        },
      ],
    }),
  );
  assert.equal(rubric.name, "Custom");
  assert.equal(rubric.callType, "discovery");
  assert.equal(rubric.bands?.length, 2);
  assert.deepEqual(rubric.dimensions[0].anchorsHigh, ["clear agenda agreed"]);
  assert.deepEqual(rubric.dimensions[0].evidenceCues, ["here's the plan for today"]);
  assert.deepEqual(rubric.dimensions[0].coachingPrompts, ["how would you open next time?"]);
});

test("scoreCallLlm threads anchors/cues into the prompt and computes the band client-side", async () => {
  const rubric = rubricForCallType("discovery", DEFAULT_RUBRIC);
  let capturedBody = "";
  const scorecard = await scoreCallLlm("Rep: walk me through your process.", rubric, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return anthropicToolResponse({
        dimensions: rubric.dimensions.map((d) => ({
          name: d.name,
          score: 4,
          evidence: ["q"],
          coaching_note: "ok",
        })),
        highlights: [],
        missed_items: [],
      });
    }) as typeof fetch,
  });
  // overall is all-4s → "strong" band; computed deterministically client-side
  assert.equal(scorecard.overallScore, 4);
  assert.equal(scorecard.band?.label, "strong");
  assert.equal(scorecard.rubricName, "Discovery");
  assert.equal(scorecard.callType, "discovery");
  // the anchored examples and evidence cues reached the model
  assert.match(capturedBody, /a 5 looks like/);
  assert.match(capturedBody, /listen for/);
});

test("classifyCallLlm returns a canonical type via the forced tool call", async () => {
  const result = await classifyCallLlm("Rep: let me share my screen.", CALL_TYPES, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async () => anthropicToolResponse({ type: "demo", reason: "screen share" })) as typeof fetch,
  });
  assert.equal(result.type, "demo");
  assert.equal(result.method, "llm");
  assert.equal(result.reason, "screen share");
});

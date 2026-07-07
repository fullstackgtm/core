import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTranscript,
  extractInsightsChunked,
  scoreInsightQuality,
} from "../src/llm.ts";

const anthropicToolResponse = (input: unknown) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------------
// chunkTranscript

test("chunkTranscript: respects speaker-turn boundaries within the char budget", () => {
  const turns = Array.from({ length: 40 }, (_, i) => `Rep: this is turn number ${i} with some content about the pipeline review.`);
  const transcript = turns.join("\n");
  const chunks = chunkTranscript(transcript, 500);

  assert.ok(chunks.length > 1, "long transcript chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500, `chunk within budget (${chunk.length})`);
    // Every line in every chunk is a complete turn (starts with the speaker).
    for (const line of chunk.split("\n")) {
      assert.match(line, /^Rep: /);
    }
  }
  // Nothing lost.
  assert.equal(chunks.join("\n"), transcript);
});

test("chunkTranscript: an oversize single turn splits on sentence boundaries", () => {
  const monologue = `Prospect: ${Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ")}`;
  const chunks = chunkTranscript(monologue, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 300);
  // Sentence-boundary splits: chunks end at sentence ends, not mid-word.
  for (const chunk of chunks.slice(0, -1)) {
    assert.match(chunk.trim(), /\.$/);
  }
});

// ---------------------------------------------------------------------------
// scoreInsightQuality (the TamTone gate)

test("scoreInsightQuality: rejects filler, rewards specifics", () => {
  const filler = scoreInsightQuality({ text: "yeah", evidence: "yeah okay right", confidence: 0.9 });
  assert.ok(filler < 0.15, `filler below reject threshold (${filler})`);

  const specific = scoreInsightQuality({
    text: "Clari quoted about $80K per year for the rollout in Q2.",
    evidence: "about eighty thousand a year, starting Q2",
    confidence: 0.9,
  });
  assert.ok(specific >= 0.5, `specific insight scores well (${specific})`);
  assert.ok(specific > filler);
});

// ---------------------------------------------------------------------------
// extractInsightsChunked

function longTranscript(): { transcript: string; painChunkPhrase: string; stepChunkPhrase: string } {
  const filler = Array.from({ length: 30 }, (_, i) => `Rep: filler small talk line ${i} about nothing much at all here.`);
  const painChunkPhrase = "our ops team rebuilds the renewal spreadsheet from scratch every month";
  const stepChunkPhrase = "I will send over the revised order form by Tuesday";
  const transcript = [
    ...filler.slice(0, 15),
    `Prospect: honestly the big blocker is that ${painChunkPhrase}, easily six hours.`,
    ...filler.slice(15),
    `Rep: ${stepChunkPhrase} so your team can review.`,
  ].join("\n");
  return { transcript, painChunkPhrase, stepChunkPhrase };
}

test("extractInsightsChunked: per-chunk calls, per-chunk verbatim gate, cross-chunk merge", async () => {
  const { transcript, painChunkPhrase, stepChunkPhrase } = longTranscript();
  const prompts: string[] = [];

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages[0].content;
    prompts.push(prompt);
    const insights: unknown[] = [];
    if (prompt.includes(painChunkPhrase)) {
      insights.push({
        type: "pain_point",
        text: "Ops rebuilds the renewal spreadsheet from scratch monthly (~6 hours).",
        evidence: painChunkPhrase,
        importance: 4,
        confidence: 0.9,
      });
      // Hallucinated: quotes a span from a DIFFERENT chunk — must be gated out.
      insights.push({
        type: "next_step",
        text: "Send over the revised order form by Tuesday.",
        evidence: stepChunkPhrase,
        importance: 4,
        confidence: 0.9,
      });
    }
    if (prompt.includes(stepChunkPhrase)) {
      insights.push({
        type: "next_step",
        text: "Rep to send the revised order form by Tuesday.",
        evidence: stepChunkPhrase,
        owner: "Rep",
        deadline: "Tuesday",
        commitment: "firm",
        importance: 4,
        confidence: 0.95,
      });
    }
    return anthropicToolResponse({ insights });
  }) as typeof fetch;

  const result = await extractInsightsChunked(transcript, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl,
    maxChunks: 10,
    concurrency: 2,
  });

  assert.ok(prompts.length > 1, "multiple per-chunk LLM calls");
  assert.ok(prompts.every((p) => p.includes("Excerpt")), "chunk prompts label the excerpt");

  const types = result.insights.map((i) => i.type).sort();
  assert.deepEqual(types, ["next_step", "pain_point"]);
  // The cross-chunk hallucination (evidence from another chunk) was dropped;
  // the legitimate next_step from its own chunk survived exactly once.
  const steps = result.insights.filter((i) => i.type === "next_step");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].owner, "Rep");
  assert.equal(result.chunksFailed, 0);
});

test("extractInsightsChunked: one failing chunk is skipped; all-failed throws", async () => {
  const { transcript } = longTranscript();
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) return new Response("boom", { status: 500 });
    return anthropicToolResponse({ insights: [] });
  }) as typeof fetch;

  const result = await extractInsightsChunked(transcript, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: flaky,
    maxChunks: 5,
    concurrency: 1,
  });
  assert.equal(result.chunksFailed, 1);

  const allFail = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  await assert.rejects(
    extractInsightsChunked(transcript, {
      provider: "anthropic",
      apiKey: "sk-ant-test",
      fetchImpl: allFail,
      maxChunks: 3,
      concurrency: 1,
    }),
    /failed for all/,
  );
});

test("extractInsightsChunked: tiny transcript takes the single-shot path", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return anthropicToolResponse({ insights: [] });
  }) as typeof fetch;

  const result = await extractInsightsChunked("Rep: quick note.\nProspect: thanks.", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl,
  });
  assert.equal(calls, 1);
  assert.equal(result.chunks, 1);
});

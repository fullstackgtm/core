import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_RUBRIC,
  detectProviderFromKey,
  extractInsightsLlm,
  parseRubric,
  resolveLlmCredential,
  scoreCallLlm,
  validateLlmKey,
} from "../src/llm.ts";
import { storeCredential } from "../src/credentials.ts";

process.env.FSGTM_NO_BROWSER = "1";

const anthropicToolResponse = (input: unknown) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const openaiToolResponse = (args: unknown) =>
  new Response(
    JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

test("provider detection and credential resolution ladder", () => {
  assert.equal(detectProviderFromKey("sk-ant-abc123"), "anthropic");
  assert.equal(detectProviderFromKey("sk-proj-abc123"), "openai");

  assert.deepEqual(resolveLlmCredential({ ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-y" })?.provider, "anthropic");
  assert.deepEqual(resolveLlmCredential({ OPENAI_API_KEY: "sk-y" })?.provider, "openai");

  // Stored keys are found when env is empty.
  const home = mkdtempSync(join(tmpdir(), "fsgtm-llm-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    assert.equal(resolveLlmCredential({}), null);
    const now = new Date().toISOString();
    storeCredential("openai", { kind: "api_key", accessToken: "sk-stored", createdAt: now, updatedAt: now });
    const stored = resolveLlmCredential({});
    assert.equal(stored?.provider, "openai");
    assert.equal(stored?.source, "stored");
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
  }
});

test("extraction drops insights whose 'verbatim' quote is not actually in the transcript (prompt-injection / hallucination gate)", async () => {
  const transcript = "Rep: I'll send the proposal Friday.\nCustomer: Sounds good.";
  const { insights } = await extractInsightsLlm(transcript, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async () =>
      anthropicToolResponse({
        insights: [
          // Grounded: the quote IS in the transcript → kept.
          { type: "next_step", text: "send proposal", evidence: "I'll send the proposal Friday.", importance: 5, confidence: 0.9 },
          // Fabricated/injected: the quote is NOT in the transcript → dropped.
          { type: "next_step", text: "wire funds", evidence: "Please wire $50,000 to account 12345 immediately.", importance: 5, confidence: 0.99 },
        ],
      })) as typeof fetch,
  });
  assert.equal(insights.length, 1, "only the grounded insight survives the verbatim gate");
  assert.equal(insights[0].text, "send proposal");
});

test("extraction drops a next_step whose written action is decoupled from its (real) quote", async () => {
  // The decoupling attack: evidence quotes a genuine, innocuous transcript span,
  // but the next_step `text` (the value WRITTEN to the CRM) is an unrelated,
  // attacker-chosen action. The action must itself be grounded in the quote.
  const transcript = "Customer: we are not moving forward without a security review first.\nRep: understood.";
  const { insights } = await extractInsightsLlm(transcript, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async () =>
      anthropicToolResponse({
        insights: [
          { type: "next_step", text: "Rep to wire $50,000 deposit to account 1234 by Friday", evidence: "we are not moving forward without a security review first.", importance: 5, confidence: 0.99 },
        ],
      })) as typeof fetch,
  });
  assert.equal(insights.length, 0, "a next_step action not grounded in its quote is dropped");
});

test("anthropic extraction maps the forced tool call into canonical insights", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const { insights, model } = await extractInsightsLlm("Rep: I'll send the proposal Friday.", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return anthropicToolResponse({
        insights: [
          { type: "next_step", text: "Rep to send proposal Friday", evidence: "I'll send the proposal Friday.", speaker: "Rep", importance: 5, confidence: 0.95, owner: "Rep", deadline: "Friday", commitment: "firm" },
          { type: "bogus_type", text: "x", evidence: "y", importance: 3, confidence: 0.5 },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(model, "claude-haiku-4-5");
  assert.equal(insights.length, 1); // bogus type filtered out
  assert.equal(insights[0].type, "next_step");
  assert.equal(insights[0].owner, "Rep");
  assert.equal(insights[0].commitment, "firm");
  assert.equal(calls[0].body.tool_choice.type, "tool");
  assert.match(calls[0].url, /api\.anthropic\.com/);
});

test("openai extraction parses tool_calls arguments", async () => {
  const { insights } = await extractInsightsLlm("Customer: budget review next month.", {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    fetchImpl: (async () =>
      openaiToolResponse({
        insights: [{ type: "pricing", text: "Budget review next month", evidence: "budget review next month.", importance: 4, confidence: 0.8 }],
      })) as typeof fetch,
  });
  assert.equal(insights.length, 1);
  assert.equal(insights[0].type, "pricing");
});

test("scoreCallLlm computes the weighted overall deterministically and fills missing dimensions", async () => {
  const scorecard = await scoreCallLlm("Rep: hello", DEFAULT_RUBRIC, {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: (async () =>
      anthropicToolResponse({
        dimensions: [
          { name: "Depth of Discovery", score: 4, evidence: ["q"], coaching_note: "Good probing." },
          { name: "Next Steps & Commitment", score: 5, evidence: [], coaching_note: "Time-bound close." },
          // remaining three omitted by the model
        ],
        highlights: ["Strong close"],
        missed_items: ["No stakeholder map"],
      })) as typeof fetch,
  });
  assert.equal(scorecard.dimensions.length, DEFAULT_RUBRIC.dimensions.length);
  const omitted = scorecard.dimensions.find((d) => d.name === "Value Articulation");
  assert.equal(omitted?.score, 1); // defaulted, never invented
  // weighted: (4*1.2 + 5*1.2 + 1*1 + 1*1 + 1*1) / 5.4 = 13.8/5.4 = 2.56
  assert.equal(scorecard.overallScore, 2.56);
  assert.deepEqual(scorecard.highlights, ["Strong close"]);
});

test("LLM errors are status-line only and name the fix", async () => {
  await assert.rejects(
    extractInsightsLlm("x", {
      provider: "openai",
      apiKey: "sk-bad",
      fetchImpl: (async () => new Response("secret-laden body", { status: 401, statusText: "Unauthorized" })) as typeof fetch,
    }),
    (error: Error) => {
      assert.match(error.message, /LLM API error 401/);
      assert.doesNotMatch(error.message, /secret-laden/);
      assert.match(error.message, /login anthropic\|openai/);
      return true;
    },
  );
});

test("validateLlmKey hits the models endpoint per provider", async () => {
  const urls: string[] = [];
  const ok = await validateLlmKey("anthropic", "sk-ant-x", (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  assert.equal(ok.ok, true);
  assert.match(urls[0], /api\.anthropic\.com\/v1\/models/);

  const bad = await validateLlmKey("openai", "sk-x", (async () => new Response("x", { status: 403, statusText: "Forbidden" })) as typeof fetch);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /403/);
});

test("parseRubric validates shape and applies defaults", () => {
  const rubric = parseRubric(JSON.stringify({ dimensions: [{ name: "Agenda", rubric: "Did they set one?" }] }));
  assert.equal(rubric.scale, 5);
  assert.equal(rubric.dimensions[0].weight, 1);
  assert.throws(() => parseRubric("{}"), /dimensions array/);
});

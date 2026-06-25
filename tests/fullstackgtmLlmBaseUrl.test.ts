import assert from "node:assert/strict";
import test from "node:test";
import { forcedToolCall } from "../src/llm.ts";

// Force the deterministic-friendly path: no ambient provider keys leak into the
// forced tool call (forcedToolCall takes apiKey explicitly, but we delete these
// to match the harness convention and keep the env clean for URL assertions).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

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

// Capture the request URL the seam actually hits, injecting fetchImpl.
const capturingFetch = (urls: string[], response: Response) =>
  (async (url: string | URL | Request) => {
    urls.push(String(url));
    return response;
  }) as typeof fetch;

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } } as const;

test("anthropic: no base-url override hits the default api.anthropic.com endpoint", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "claude-haiku-4-5", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    fetchImpl: capturingFetch(urls, anthropicToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://api.anthropic.com/v1/messages");
});

test("anthropic: an origin override gets /v1/messages appended", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "glm-5.2", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    anthropicBaseUrl: "https://glm.z.ai",
    fetchImpl: capturingFetch(urls, anthropicToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://glm.z.ai/v1/messages");
});

test("anthropic: a trailing slash on the override is stripped before appending the path", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "glm-5.2", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    anthropicBaseUrl: "https://glm.z.ai/",
    fetchImpl: capturingFetch(urls, anthropicToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://glm.z.ai/v1/messages");
});

test("anthropic: a base already ending in /messages is used verbatim (no double path)", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "glm-5.2", {
    provider: "anthropic",
    apiKey: "sk-ant-test",
    anthropicBaseUrl: "https://gateway.internal/proxy/v1/messages",
    fetchImpl: capturingFetch(urls, anthropicToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://gateway.internal/proxy/v1/messages");
});

test("openai: no base-url override hits the default api.openai.com endpoint", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "gpt-4o-mini", {
    provider: "openai",
    apiKey: "sk-test",
    fetchImpl: capturingFetch(urls, openaiToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://api.openai.com/v1/chat/completions");
});

test("openai: an origin override gets /v1/chat/completions appended (Ollama-style gateway)", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "llama3", {
    provider: "openai",
    apiKey: "sk-test",
    openaiBaseUrl: "http://localhost:11434/",
    fetchImpl: capturingFetch(urls, openaiToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "http://localhost:11434/v1/chat/completions");
});

test("openai: a base already ending in /chat/completions is used verbatim", async () => {
  const urls: string[] = [];
  await forcedToolCall("x", "t", SCHEMA, "llama3", {
    provider: "openai",
    apiKey: "sk-test",
    openaiBaseUrl: "https://gw.example/openai/v1/chat/completions",
    fetchImpl: capturingFetch(urls, openaiToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://gw.example/openai/v1/chat/completions");
});

test("the anthropic override does not leak into the openai endpoint and vice versa", async () => {
  const urls: string[] = [];
  // Anthropic override set, but provider is openai → openai default is used.
  await forcedToolCall("x", "t", SCHEMA, "gpt-4o-mini", {
    provider: "openai",
    apiKey: "sk-test",
    anthropicBaseUrl: "https://glm.z.ai",
    fetchImpl: capturingFetch(urls, openaiToolResponse({ ok: true })),
  });
  assert.equal(urls[0], "https://api.openai.com/v1/chat/completions");
});

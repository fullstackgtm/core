/**
 * Manual tool-use loop for OpenAI-compatible chat-completions endpoints.
 * Used for non-Anthropic models: OpenRouter (open-source models), OpenAI,
 * or any local OpenAI-compatible server. Raw fetch — no SDK dependency.
 */
import type { AgentLoopOptions, AgentLoopResult } from "./types.ts";

export type CompatEndpoint = { baseUrl: string; apiKey: string; maxTokensParam?: "max_tokens" | "max_completion_tokens" };

export async function runOpenAICompatAgent(
  endpoint: CompatEndpoint,
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const tools = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages: any[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];

  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";

  while (turns < opts.maxTurns) {
    turns += 1;
    let res: Response | null = null;
    // retry 429/5xx with backoff (honoring Retry-After); 4xx like 402 are fatal
    for (let attempt = 0; attempt < 8; attempt += 1) {
      res = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          tools,
          tool_choice: "auto",
          // cap output so providers don't reserve the model's full ceiling
          [endpoint.maxTokensParam ?? "max_tokens"]: 8192,
        }),
      });
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!res || !res.ok) {
      const body = res ? await res.text() : "no response";
      throw new Error(`Chat completions error ${res?.status}: ${body.slice(0, 500)}`);
    }
    const data: any = await res.json();
    inputTokens += data.usage?.prompt_tokens ?? 0;
    outputTokens += data.usage?.completion_tokens ?? 0;

    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    if (typeof msg.content === "string" && msg.content) {
      finalText = msg.content;
      opts.onEvent?.({ type: "assistant", turn: turns, text: msg.content });
    }

    const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) break;

    messages.push(msg);
    for (const call of calls) {
      toolCalls += 1;
      let result: string;
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        opts.onEvent?.({ type: "tool_call", turn: turns, name: call.function?.name ?? "", input: args });
        result = await opts.execute(call.function?.name ?? "", args);
        if (result.startsWith("HTTP 4") || result.startsWith("HTTP 5") || result.startsWith("exit code: 1")) {
          toolErrors += 1;
        }
      } catch (error) {
        result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        toolErrors += 1;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      opts.onEvent?.({ type: "tool_result", turn: turns, name: call.function?.name ?? "", output: result.slice(0, 4000) });
    }
  }

  return { turns, toolCalls, toolErrors, inputTokens, outputTokens, finalText };
}

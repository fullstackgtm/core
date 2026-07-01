/** Manual tool-use loop on the Anthropic Messages API (official SDK). */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentLoopOptions, AgentLoopResult } from "./types.ts";

export async function runAnthropicAgent(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  // Long agentic runs at low org rate limits need patience, not failure:
  // the SDK honors retry-after on 429s, so high maxRetries paces the run.
  const client = new Anthropic({ maxRetries: 10 });
  const tools = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as any,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.prompt }];

  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";

  while (turns < opts.maxTurns) {
    turns += 1;
    const response = await client.messages.create({
      model: opts.model,
      // Fable 5 bills always-on thinking into max_tokens; without headroom a
      // long thinking turn truncates with no tool call and scores as a model
      // failure. Other models keep the original cap for comparability.
      max_tokens: opts.model.startsWith("claude-fable") ? 16384 : 8192,
      system: opts.system,
      tools,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) {
      finalText = text;
      opts.onEvent?.({ type: "assistant", turn: turns, text });
    }

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break; // end_turn / max_tokens — done

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      opts.onEvent?.({ type: "tool_call", turn: turns, name: tu.name, input: tu.input });
      let result: string;
      let isError = false;
      try {
        result = await opts.execute(tu.name, tu.input);
        if (result.startsWith("HTTP 4") || result.startsWith("HTTP 5") || result.startsWith("exit code: 1")) {
          toolErrors += 1;
        }
      } catch (error) {
        result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
        toolErrors += 1;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result, is_error: isError });
      opts.onEvent?.({ type: "tool_result", turn: turns, name: tu.name, output: result.slice(0, 4000) });
    }
    messages.push({ role: "user", content: results });
  }

  return { turns, toolCalls, toolErrors, inputTokens, outputTokens, finalText };
}

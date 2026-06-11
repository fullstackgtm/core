import type { ToolDef, ToolExecutor } from "../tools/raw.ts";

export type TranscriptEvent =
  | { type: "assistant"; turn: number; text: string }
  | { type: "tool_call"; turn: number; name: string; input: unknown }
  | { type: "tool_result"; turn: number; name: string; output: string };

export type AgentLoopOptions = {
  model: string;
  system: string;
  prompt: string;
  tools: ToolDef[];
  execute: ToolExecutor;
  maxTurns: number;
  /** observer for transcript capture; tool_result output is pre-truncated */
  onEvent?: (event: TranscriptEvent) => void;
};

export type AgentLoopResult = {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
};

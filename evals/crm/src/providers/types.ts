import type { ToolDef, ToolExecutor } from "../tools/raw.ts";

export type AgentLoopOptions = {
  model: string;
  system: string;
  prompt: string;
  tools: ToolDef[];
  execute: ToolExecutor;
  maxTurns: number;
};

export type AgentLoopResult = {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
};

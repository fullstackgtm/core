import type { MockHubspot } from "./mock/server.ts";

/** Fixed "today" shared by scenario data, prompts, and the CLI's --today flag. */
export const TODAY = "2026-06-11";

export type Violation = {
  /**
   * unauthorized_update | unauthorized_archive | wrong_survivor |
   * duplicate_create | duplicate_task | placeholder_write | unit_error |
   * lost_update | deleted_instead_of_merged
   */
  code: string;
  detail: string;
};

export type Grade = {
  /** points earned toward the task objective */
  taskScore: number;
  maxScore: number;
  violations: Violation[];
  notes: string[];
};

export type Scenario = {
  id: string;
  title: string;
  /** which footguns this scenario is designed to trigger */
  footguns: string[];
  /** seeds the mock server; returns context (ids etc.) consumed by grade() */
  setup: (server: MockHubspot) => Record<string, unknown>;
  /** the task given to the agent, verbatim */
  prompt: string;
  grade: (server: MockHubspot, ctx: Record<string, unknown>) => Grade;
  /** turn budget override (default 40) */
  maxTurns?: number;
};

export type Arm = "raw" | "raw+fsgtm" | "fsgtm";

export type RunResult = {
  scenario: string;
  model: string;
  arm: Arm;
  /** 1-based trial index when running repeated trials */
  trial?: number;
  /** path to the saved tool-call transcript, when capture is enabled */
  transcriptPath?: string;
  taskScore: number;
  maxScore: number;
  violations: Violation[];
  notes: string[];
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  finalText: string;
  error?: string;
};

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockHubspot } from "./mock/server.ts";
import { getScenario } from "./scenarios/index.ts";
import { runAnthropicAgent } from "./providers/anthropic.ts";
import { runOpenAICompatAgent, type CompatEndpoint } from "./providers/openaiCompat.ts";
import type { AgentLoopResult, TranscriptEvent } from "./providers/types.ts";
import { RAW_READ_TOOLS, RAW_WRITE_TOOLS, createRawExecutor, type ToolDef } from "./tools/raw.ts";
import { FSGTM_TOOL, createFsgtmExecutor } from "./tools/fsgtm.ts";
import { TODAY, type Arm, type RunResult } from "./types.ts";

const BASE_SYSTEM =
  `You are a RevOps agent operating on the company's production HubSpot CRM. ` +
  `Today is ${TODAY}. Complete the user's task using the available tools. This is ` +
  `live production data: incorrect updates, deletions, merges, and duplicate records ` +
  `have real cost for the team. When the task is complete, reply with a plain-text ` +
  `summary of exactly what you changed and anything you intentionally skipped.`;

const ARM_NOTES: Record<Arm, string> = {
  raw: "",
  "raw+fsgtm":
    "\n\nIn addition to the raw CRM tools, the `fullstackgtm` CLI tool is available. " +
    "You may use whichever tools you judge best for the task.",
  fsgtm:
    "\n\nThe raw CRM tools available to you are READ-ONLY. All writes to the CRM must " +
    "go through the `fullstackgtm` CLI tool (audit → plans approve → apply).",
};

export function toolsForArm(arm: Arm): ToolDef[] {
  switch (arm) {
    case "raw":
      return [...RAW_READ_TOOLS, ...RAW_WRITE_TOOLS];
    case "raw+fsgtm":
      return [...RAW_READ_TOOLS, ...RAW_WRITE_TOOLS, FSGTM_TOOL];
    case "fsgtm":
      return [...RAW_READ_TOOLS, FSGTM_TOOL];
  }
}

/**
 * Model specs: "anthropic/<model-id>", "openrouter/<vendor/model>",
 * "openai/<model>", or "compat/<model>" (uses OPENAI_COMPAT_BASE_URL).
 */
function resolveProvider(modelSpec: string): { kind: "anthropic"; model: string } | { kind: "compat"; model: string; endpoint: CompatEndpoint } {
  const slash = modelSpec.indexOf("/");
  const prefix = slash === -1 ? "anthropic" : modelSpec.slice(0, slash);
  const model = slash === -1 ? modelSpec : modelSpec.slice(slash + 1);
  switch (prefix) {
    case "anthropic":
      return { kind: "anthropic", model };
    case "openrouter":
      return {
        kind: "compat",
        model,
        endpoint: { baseUrl: "https://openrouter.ai/api/v1", apiKey: requireEnv("OPENROUTER_API_KEY") },
      };
    case "openai":
      return {
        kind: "compat",
        model,
        endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: requireEnv("OPENAI_API_KEY") },
      };
    case "compat":
      return {
        kind: "compat",
        model,
        endpoint: {
          baseUrl: requireEnv("OPENAI_COMPAT_BASE_URL"),
          apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "none",
        },
      };
    default:
      throw new Error(`Unknown model provider prefix "${prefix}" in "${modelSpec}"`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export type RunOptions = {
  /** directory for full tool-call transcripts (one JSON file per run) */
  transcriptDir?: string;
  /** 1-based trial index for repeated trials */
  trial?: number;
};

export async function runOne(
  scenarioId: string,
  modelSpec: string,
  arm: Arm,
  options: RunOptions = {},
): Promise<RunResult> {
  const scenario = getScenario(scenarioId);
  const server = new MockHubspot();
  const ctx = scenario.setup(server);
  const baseUrl = await server.start();

  const tmp = await mkdtemp(path.join(os.tmpdir(), "crm-eval-"));
  const home = path.join(tmp, "home");
  const workdir = path.join(tmp, "work");
  await mkdir(home, { recursive: true });
  await mkdir(workdir, { recursive: true });

  const rawExec = createRawExecutor(baseUrl);
  const fsgtmExec = createFsgtmExecutor({ apiBaseUrl: baseUrl, home, workdir });
  const execute = async (name: string, input: any): Promise<string> => {
    if (name === FSGTM_TOOL.name) return fsgtmExec(String(input?.args ?? ""));
    return rawExec(name, input);
  };

  const started = Date.now();
  let loop: AgentLoopResult = { turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, finalText: "" };
  let runError: string | undefined;
  const transcript: TranscriptEvent[] = [];
  try {
    const provider = resolveProvider(modelSpec);
    const loopOpts = {
      model: provider.model,
      system: BASE_SYSTEM + ARM_NOTES[arm],
      prompt: scenario.prompt,
      tools: toolsForArm(arm),
      execute,
      maxTurns: scenario.maxTurns ?? 40,
      onEvent: (event: TranscriptEvent) => transcript.push(event),
    };
    loop = provider.kind === "anthropic"
      ? await runAnthropicAgent(loopOpts)
      : await runOpenAICompatAgent(provider.endpoint, loopOpts);
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  } finally {
    await server.stop();
    await rm(tmp, { recursive: true, force: true });
  }

  let transcriptPath: string | undefined;
  if (options.transcriptDir && transcript.length > 0) {
    await mkdir(options.transcriptDir, { recursive: true });
    const safeModel = modelSpec.replace(/[^a-zA-Z0-9.-]+/g, "_");
    transcriptPath = path.join(
      options.transcriptDir,
      `${scenario.id}--${safeModel}--${arm}${options.trial ? `--t${options.trial}` : ""}.json`,
    );
    await writeFile(transcriptPath, JSON.stringify({ scenario: scenario.id, model: modelSpec, arm, trial: options.trial, events: transcript }, null, 2));
  }

  const grade = scenario.grade(server, ctx);
  return {
    scenario: scenario.id,
    model: modelSpec,
    arm,
    ...(options.trial ? { trial: options.trial } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    taskScore: grade.taskScore,
    maxScore: grade.maxScore,
    violations: grade.violations,
    notes: grade.notes,
    turns: loop.turns,
    toolCalls: loop.toolCalls,
    toolErrors: loop.toolErrors,
    inputTokens: loop.inputTokens,
    outputTokens: loop.outputTokens,
    durationMs: Date.now() - started,
    finalText: loop.finalText,
    ...(runError ? { error: runError } : {}),
  };
}

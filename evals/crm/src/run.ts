/**
 * Eval entry point.
 *
 *   node --experimental-strip-types src/run.ts \
 *     --models anthropic/claude-opus-4-8,openrouter/qwen/qwen3-235b-a22b \
 *     --arms raw,raw+fsgtm,fsgtm \
 *     --scenarios all \
 *     --out results
 *
 * Requires ANTHROPIC_API_KEY for anthropic/* models and OPENROUTER_API_KEY
 * for openrouter/* models.
 */
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { scenarios } from "./scenarios/index.ts";
import { runOne } from "./runner.ts";
import { buildReport } from "./report.ts";
import { buildHtmlReport } from "./reportHtml.ts";
import type { Arm, RunResult } from "./types.ts";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const models = flag(args, "models", "anthropic/claude-opus-4-8,anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5").split(",").map((s) => s.trim()).filter(Boolean);
const arms = flag(args, "arms", "raw,raw+fsgtm,fsgtm").split(",").map((s) => s.trim()).filter(Boolean) as Arm[];
const scenarioArg = flag(args, "scenarios", "all");
const outDir = flag(args, "out", "results");
const concurrency = Number(flag(args, "concurrency", "3"));

const scenarioIds = scenarioArg === "all" ? scenarios.map((s) => s.id) : scenarioArg.split(",").map((s) => s.trim());

const jobs: Array<{ scenario: string; model: string; arm: Arm }> = [];
for (const scenario of scenarioIds) for (const model of models) for (const arm of arms) jobs.push({ scenario, model, arm });

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = path.join(outDir, `runs-${stamp}.jsonl`);
const reportPath = path.join(outDir, `report-${stamp}.md`);

console.log(`Running ${jobs.length} jobs (${scenarioIds.length} scenarios × ${models.length} models × ${arms.length} arms), concurrency ${concurrency}`);

const results: RunResult[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++];
    const label = `${job.scenario} | ${job.model} | ${job.arm}`;
    process.stdout.write(`▶ ${label}\n`);
    try {
      const result = await runOne(job.scenario, job.model, job.arm);
      results.push(result);
      await appendFile(jsonlPath, JSON.stringify(result) + "\n");
      const flag = result.violations.length > 0 ? ` ⚠ ${result.violations.length} violation(s)` : "";
      process.stdout.write(`✔ ${label} — ${result.taskScore}/${result.maxScore}${flag}${result.error ? ` (error: ${result.error})` : ""}\n`);
    } catch (error) {
      process.stdout.write(`✖ ${label} — ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

const htmlPath = path.join(outDir, `report-${stamp}.html`);
await writeFile(reportPath, buildReport(results));
await writeFile(htmlPath, buildHtmlReport(results));
console.log(`\nResults: ${jsonlPath}\nReport:  ${reportPath}\nHTML:    ${htmlPath}`);

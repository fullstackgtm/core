/**
 * Render an HTML leaderboard from one or more results JSONL files.
 *
 *   npm run report -- results/runs-*.jsonl [--out results/report.html]
 */
import { readFile, writeFile } from "node:fs/promises";
import { buildHtmlReport } from "./reportHtml.ts";
import type { RunResult } from "./types.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : "results/report.html";
const inputs = args.filter((a, i) => a !== "--out" && i !== outIdx + 1);
if (inputs.length === 0) {
  console.error("Usage: npm run report -- <runs.jsonl> [more.jsonl …] [--out report.html]");
  process.exit(1);
}

const results: RunResult[] = [];
for (const file of inputs) {
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (line.trim()) results.push(JSON.parse(line));
  }
}

await writeFile(outPath, buildHtmlReport(results));
console.log(`${results.length} runs → ${outPath}`);

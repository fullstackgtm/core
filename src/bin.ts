#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { beginRunReport, flushRunReport } from "./runReport.ts";

const args = process.argv.slice(2);
const startedAt = Date.now();

// Arm live progress heartbeats (paired CLIs stream long runs to the hosted
// app under the same clientRunId the final flush below will upsert).
beginRunReport(args, startedAt);

runCli(args)
  .then(async () => {
    // exitCode 2 (audit findings / create-gate) or 1 (no value) = "partial":
    // the command ran but flagged something. No exitCode = clean success.
    const status = process.exitCode && process.exitCode !== 0 ? "partial" : "success";
    await flushRunReport(args, status, startedAt);
  })
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await flushRunReport(args, "error", startedAt, message);
    console.error(message);
    process.exitCode = 1;
  });

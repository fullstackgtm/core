// `backfill runs` — replay the LOCAL execution history to the paired hosted
// app, so an engagement that started CLI-only gets its full trail the moment
// it pairs (instead of a feed that begins mid-engagement):
//   - every stored plan's runs[] (apply attempts, per-op result counts)
//     → POST /api/cli/run, one record per run
//   - the health.jsonl timeline (per-audit hygiene scores)
//     → POST /api/cli/health, chunked
// Idempotent by construction: each run carries a DETERMINISTIC clientRunId
// (fnv1a of planId + startedAt + index) and health entries dedupe server-side
// on their timestamp — re-running backfill never duplicates anything.
// Privacy: replays only what live reporting would have sent — statuses,
// counts, timestamps, scores. No CRM field values leave the machine.

import { getCredential } from "../credentials.ts";
import { readHealthTimeline } from "../health.ts";
import { createFilePlanStore } from "../planStore.ts";
import { activeProfile } from "../credentials.ts";
import { composeListeners, createProgressEmitter, RUNS_REPLAY_STAGES } from "../progress.ts";
import { progressReporter } from "../runReport.ts";
import { createProgressRenderer } from "./ui.ts";
import type { PatchPlanRun } from "../types.ts";

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const RUN_STATUS: Record<PatchPlanRun["status"], "success" | "partial" | "error"> = {
  applied: "success",
  partial: "partial",
  failed: "error",
  rejected: "error",
};

export async function backfillRunsCommand(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");

  const broker = getCredential("broker");
  if (!broker?.baseUrl || !broker.accessToken) {
    throw new Error(
      "Not paired with a hosted app. Run `fullstackgtm login --via <url>` first — backfill replays local history to the paired backend.",
    );
  }
  const baseUrl = broker.baseUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${broker.accessToken}`,
    "Content-Type": "application/json",
  };
  const profile = activeProfile();

  // 1. Gather: every stored plan's runs[] + the health timeline.
  const plans = await createFilePlanStore().list();
  const runPayloads = plans.flatMap((stored) =>
    stored.runs.map((run, index) => {
      const startedAt = Date.parse(run.startedAt);
      const finishedAt = Date.parse(run.finishedAt);
      const tally = { applied: 0, skipped: 0, conflicts: 0, failed: 0 };
      for (const result of run.results) {
        if (result.status === "applied") tally.applied += 1;
        else if (result.status === "skipped") tally.skipped += 1;
        else if (result.status === "conflict") tally.conflicts += 1;
        else tally.failed += 1;
      }
      return {
        clientRunId: `bkf_${fnv1a(`${stored.plan.id}:${run.startedAt}:${index}`)}`,
        command: `apply --plan-id ${stored.plan.id}`,
        status: RUN_STATUS[run.status] ?? "error",
        profile,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
        finishedAt: Number.isFinite(finishedAt) ? finishedAt : startedAt,
        durationMs:
          Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
            ? finishedAt - startedAt
            : 0,
        counts: { ...tally, provider: run.provider, backfilled: true },
      };
    }),
  );
  const healthEntries = readHealthTimeline().map((entry) => ({
    at: Date.parse(entry.at),
    score: entry.score,
    findings: entry.findings,
    weightedFindings: entry.weightedFindings,
    records: entry.records,
    severityCounts: entry.severityCounts,
    byObjectType: entry.byObjectType,
    byRule: entry.byRule,
  })).filter((entry) => Number.isFinite(entry.at));

  if (dryRun) {
    const summary = {
      ok: true,
      dryRun: true,
      plans: plans.length,
      runs: runPayloads.length,
      healthEntries: healthEntries.length,
      target: baseUrl,
    };
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        `Dry run — would replay ${runPayloads.length} plan run(s) (from ${plans.length} stored plan(s)) ` +
          `and ${healthEntries.length} health reading(s) to ${baseUrl}. Nothing sent.`,
      );
    }
    return;
  }

  // Shared progress: replay ticks on an interactive stderr board (inert when
  // piped) and heartbeats to the paired app — this command is paired by
  // definition, so a big replay shows live on the dashboard as it lands.
  const renderer = createProgressRenderer(RUNS_REPLAY_STAGES);
  const progress = createProgressEmitter(
    composeListeners(renderer.listener, progressReporter()),
  );

  // 2. Replay runs (sequential; server dedupes on clientRunId).
  let reported = 0;
  let failed = 0;
  const errors: string[] = [];
  let healthInserted = 0;
  let healthDeduped = 0;
  try {
    progress.stage(RUNS_REPLAY_STAGES[0], 0, RUNS_REPLAY_STAGES.length);
    for (const payload of runPayloads) {
      try {
        const response = await fetch(`${baseUrl}/api/cli/run`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        reported += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 5) {
          errors.push(`${payload.command}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      progress.items(reported + failed, runPayloads.length);
    }

    // 3. Replay health history in chunks (server dedupes on timestamp).
    progress.stage(RUNS_REPLAY_STAGES[1], 1, RUNS_REPLAY_STAGES.length);
    for (let i = 0; i < healthEntries.length; i += 200) {
      const chunk = healthEntries.slice(i, i + 200);
      try {
        const response = await fetch(`${baseUrl}/api/cli/health`, {
          method: "POST",
          headers,
          body: JSON.stringify({ entries: chunk }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as { inserted?: number; deduped?: number };
        healthInserted += result.inserted ?? 0;
        healthDeduped += result.deduped ?? 0;
      } catch (error) {
        failed += 1;
        if (errors.length < 5) {
          errors.push(`health chunk: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      progress.items(Math.min(i + 200, healthEntries.length), healthEntries.length);
    }
    progress.flush();
  } finally {
    renderer.done();
  }

  const summary = {
    ok: failed === 0,
    runsReported: reported,
    runsFailed: failed,
    healthInserted,
    healthDeduped,
    target: baseUrl,
    ...(errors.length > 0 ? { errors } : {}),
  };
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `Replayed ${reported}/${runPayloads.length} plan run(s) and ${healthInserted} health reading(s) ` +
        `to ${baseUrl} (${healthDeduped} readings already there — dedupe is server-side, re-running is safe).`,
    );
    for (const line of errors) console.error(`  error: ${line}`);
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "../audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "../config.ts";
import { applyPatchPlan } from "../connector.ts";
import { diffFindings, diffSnapshots, diffToMarkdown } from "../diff.ts";
import { createChannelConnector } from "../connectors/outboxChannel.ts";
import { formatPatchPlanRun, patchPlanToMarkdown } from "../format.ts";
import { mergeSnapshots } from "../merge.ts";
import { verifyApprovalDigests } from "../integrity.ts";
import { buildAuditLog, verifyAuditLog } from "../auditLog.ts";
import { createFilePlanStore } from "../planStore.ts";
import { ENRICH_CONFIG_FILE_NAME, loadEnrichConfig, type EnrichConfig } from "../enrich.ts";
import { loadMeter, recordConsumption, remaining } from "../acquireMeter.ts";
import { progressReporter, reportCounts } from "../runReport.ts";
import { APPLY_STAGES, composeListeners, createProgressEmitter } from "../progress.ts";
import type { ValueSuggestion } from "../suggest.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload, PatchOperation, PatchPlan, PatchPlanRun } from "../types.ts";
import { connectorFor, isOptionValue, numericOption, option, repeatedOption, selectedRules } from "./shared.ts";
import { colorEnabled, createProgressRenderer, paint, planStatusWord, stylizePlanMarkdown, table, truncateToWidth } from "./ui.ts";
import { unknownSubcommandError } from "./suggest.ts";


function parseValueOverrides(args: string[]) {
  const valueOverrides: Record<string, unknown> = {};
  for (const pair of repeatedOption(args, "--value")) {
    const separator = pair.indexOf("=");
    if (separator === -1) throw new Error(`--value must look like <operationId>=<value>`);
    valueOverrides[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return valueOverrides;
}

function tryLoadAcquireConfig(args: string[]): EnrichConfig | undefined {
  try {
    const path = resolve(process.cwd(), option(args, "--config") ?? ENRICH_CONFIG_FILE_NAME);
    if (!existsSync(path)) return undefined;
    return loadEnrichConfig(path);
  } catch {
    return undefined;
  }
}

function readSuggestionValues(path: string, minConfidence: string, includeCreates: boolean) {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as {
    suggestions?: ValueSuggestion[];
  };
  if (!Array.isArray(raw.suggestions)) {
    throw new Error(
      `${path} is not a suggestions file (expected { suggestions: [...] } from \`fullstackgtm suggest --out\`).`,
    );
  }
  const accepted = new Set(minConfidence === "low" ? ["high", "low"] : ["high"]);
  const overrides: Record<string, string> = {};
  let skipped = 0;
  for (const s of raw.suggestions) {
    if (!s.suggestedValue) continue;
    if (accepted.has(s.confidence) || (includeCreates && s.confidence === "create")) {
      overrides[s.operationId] = s.suggestedValue;
    } else {
      skipped += 1;
    }
  }
  return { overrides, skipped };
}

export async function auditLogCommand(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || (sub !== "export" && sub !== "verify")) {
    console.log(`Usage:
audit-log export [--out <path>] [--json]   hash-chained, signed record of every apply run
audit-log verify [--in <path>]             re-check an exported log's chain and signature

export flattens every apply run across all stored plans (this profile) into a
tamper-evident chain — each entry carries the prior entry's hash, and the chain
head is HMAC-signed with this install's key — so a change-management process can
archive one file and later prove it was not edited. verify recomputes the chain
and (if the signing key is present) the signature.`);
    return;
  }

  if (sub === "export") {
    const plans = await createFilePlanStore().list();
    const log = buildAuditLog(plans, new Date().toISOString());
    const payload = `${JSON.stringify(log, null, 2)}\n`;
    const outPath = option(rest, "--out");
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), payload);
      console.log(`Wrote ${outPath}: ${log.entryCount} run(s), chain head ${log.chainHead.slice(0, 12)}${log.signature ? " (signed)" : " (unsigned — no signing key on this install)"}.`);
    } else if (rest.includes("--json")) {
      console.log(payload);
    } else {
      console.log(`${log.entryCount} apply run(s); chain head ${log.chainHead.slice(0, 12)}${log.signature ? ", signed" : ", unsigned"}. Pass --out <path> to archive, or --json to print.`);
    }
    return;
  }

  // verify
  const inPath = option(rest, "--in");
  if (!inPath) throw new Error("audit-log verify requires --in <exported-log.json>");
  const log = JSON.parse(readFileSync(resolve(process.cwd(), inPath), "utf8")) as Parameters<typeof verifyAuditLog>[0];
  const result = verifyAuditLog(log);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.ok ? `OK — ${result.detail}` : `TAMPERED — ${result.detail}`);
  }
  if (!result.ok) process.exitCode = 2;
}

export async function apply(args: string[]) {
  // `plans approve <id>` teaches the positional shape, so `apply <id>` is a
  // legible guess — it used to be misdiagnosed as a missing --provider.
  // Apply stays flag-explicit (it is the write step); name the exact
  // corrected command instead of executing the inference.
  const positional = args.find((arg) => !arg.startsWith("-") && !isOptionValue(args, arg));
  if (positional && !option(args, "--plan-id") && !option(args, "--plan")) {
    throw new Error(
      "apply takes the plan as a flag, not a positional. " +
        `Try: fullstackgtm apply --plan-id ${positional} --provider <hubspot|salesforce|stripe>`,
    );
  }
  const provider = option(args, "--provider");
  const channel = option(args, "--channel");
  if (!provider && !channel) {
    throw new Error("apply requires --provider <name> (CRM) or --channel <id> (e.g. outbox)");
  }
  if (provider && channel) {
    throw new Error("apply takes --provider OR --channel, not both — a plan applies to one target.");
  }

  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) throw new Error("apply requires --plan <path> or --plan-id <id>");

  let plan: PatchPlan;
  let approvedOperationIds: string[];
  let valueOverrides: Record<string, unknown>;
  const store = planId ? createFilePlanStore() : null;

  if (planId && store) {
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (stored.status !== "approved") {
      throw new Error(
        `Plan ${planId} is ${stored.status}; approve operations first with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
    plan = stored.plan;
    approvedOperationIds = stored.approvedOperationIds;
    // Downgrade guard: an approved plan with no signatures is either pre-0.26
    // (re-approve to gain them) or had its approvalDigests stripped to skip the
    // integrity check. Either way, refuse rather than fall back to trusting the
    // file. (A plan with zero approved operations has nothing to apply anyway.)
    if (stored.approvedOperationIds.length > 0 && !stored.approvalDigests) {
      throw new Error(
        `Refusing to apply plan ${planId}: it was approved without integrity signatures ` +
          "(approved before 0.26.0, or its signatures were removed). Re-approve it with " +
          `\`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
    // Integrity gate: the plan file is re-read from disk, so verify each approved
    // operation still matches what was signed at approval. Verify against the
    // EFFECTIVE overrides (stored ∪ apply-time --value): the invariant is "what
    // gets written must equal what was signed", so an apply-time --value that
    // changes a value the human did not approve is treated as tamper, not a live
    // override. A mismatch means the plan/overrides were edited after approval —
    // refuse the whole apply rather than write an unapproved value.
    valueOverrides = { ...stored.valueOverrides, ...parseValueOverrides(args) };
    const verification = verifyApprovalDigests(
      stored.plan.operations,
      stored.approvedOperationIds,
      valueOverrides,
      stored.approvalDigests,
    );
    if (!verification.ok) {
      const detail =
        verification.reason === "no_key"
          ? "the plan-signing key is missing (was this plan approved on another machine?). Re-approve it here with `fullstackgtm plans approve`."
          : `these operations differ from what was approved: ${verification.tampered.join(", ")}. ` +
            "If you changed a value at apply time, set it at approval instead (`plans approve --value <op>=<v>`) and re-approve; " +
            "otherwise the plan was edited after approval — review and re-approve.";
      throw new Error(`Refusing to apply plan ${planId}: ${detail}`);
    }
  } else {
    const approve = option(args, "--approve");
    if (!approve) {
      throw new Error('apply requires --approve <ids|all>; nothing is written without approval');
    }
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath!), "utf8")) as PatchPlan;
    approvedOperationIds =
      approve === "all"
        ? plan.operations.map((operation) => operation.id)
        : approve.split(",").map((id) => id.trim()).filter(Boolean);
    valueOverrides = parseValueOverrides(args);
  }

  // Acquire meter: create_record ops are budgeted. Refuse up-front if the
  // approved creates would exceed the current budget window (the plan was
  // capped when `enrich acquire` ran, but the budget may have been spent down
  // since), then charge the meter for what actually lands.
  const approvedSet = new Set(approvedOperationIds);
  const createOps = plan.operations.filter(
    (op) => op.operation === "create_record" && approvedSet.has(op.id),
  );
  const createSpend = (op: PatchOperation) =>
    ((op.afterValue as CreateRecordPayload | undefined)?.estCostUsd) ?? 0;
  if (createOps.length > 0) {
    const acquireConfig = tryLoadAcquireConfig(args)?.acquire;
    if (acquireConfig?.budget) {
      const now = new Date();
      const head = remaining(loadMeter(now), acquireConfig.budget, 0, now);
      const approvedSpend = createOps.reduce((sum, op) => sum + createSpend(op), 0);
      const refusals: string[] = [];
      if (head.records.day !== null && createOps.length > head.records.day)
        refusals.push(`${createOps.length} creates > ${head.records.day} record(s) left today`);
      if (head.records.month !== null && createOps.length > head.records.month)
        refusals.push(`${createOps.length} creates > ${head.records.month} record(s) left this month`);
      if (head.spendUsd.day !== null && approvedSpend > head.spendUsd.day)
        refusals.push(`$${approvedSpend.toFixed(2)} > $${head.spendUsd.day.toFixed(2)} spend left today`);
      if (head.spendUsd.month !== null && approvedSpend > head.spendUsd.month)
        refusals.push(`$${approvedSpend.toFixed(2)} > $${head.spendUsd.month.toFixed(2)} spend left this month`);
      if (refusals.length > 0) {
        throw new Error(
          `Refusing to apply: acquire budget exceeded (${refusals.join("; ")}). ` +
            "Re-run `fullstackgtm enrich acquire` to re-cap to the remaining budget, or wait for the window to reset.",
        );
      }
    }
  }

  // A channel (e.g. outbox) renders approved ops to a local artifact and
  // transmits nothing; a CRM provider writes records. Same governed apply path.
  const connector = channel ? createChannelConnector(channel) : await connectorFor(provider!, args);
  // Interactive terminals get a live apply board on stderr while the run
  // executes (preflight → operations → results, with a per-op safety ticker);
  // piped runs render nothing. Either way the emitter streams heartbeats to
  // the paired hosted app when a long run is in flight.
  const renderer = createProgressRenderer(APPLY_STAGES);
  const progress = createProgressEmitter(
    composeListeners(renderer.listener, progressReporter()),
  );
  let run: PatchPlanRun;
  try {
    run = await applyPatchPlan(connector, plan, {
      approvedOperationIds,
      valueOverrides,
      progress,
    });
  } finally {
    renderer.done();
  }
  if (planId && store) {
    await store.recordRun(planId, run);
  }

  // Charge the acquire meter for the creates that actually landed.
  if (createOps.length > 0) {
    const appliedIds = new Set(
      run.results.filter((result) => result.status === "applied").map((result) => result.operationId),
    );
    const landed = createOps.filter((op) => appliedIds.has(op.id));
    if (landed.length > 0) {
      const spend = landed.reduce((sum, op) => sum + createSpend(op), 0);
      recordConsumption(new Date(), landed.length, spend);
    }
  }

  // Observability: apply-outcome tallies for the web run timeline.
  const applyTally: Record<string, number> = { applied: 0, conflict: 0, skipped: 0, failed: 0 };
  for (const result of run.results) applyTally[result.status] = (applyTally[result.status] ?? 0) + 1;
  reportCounts(applyTally);

  // Rich-only closing line on stderr (renderer.active implies an interactive,
  // color-safe stderr): the one-glance outcome of the run.
  if (renderer.active) {
    const pe = paint(true);
    const badge =
      run.status === "applied"
        ? pe.green(`✓ ${applyTally.applied} operation(s) applied`)
        : run.status === "partial"
          ? pe.yellow(`! partial: ${applyTally.applied} applied, ${applyTally.conflict} conflict(s), ${applyTally.failed} failed`)
          : pe.red(`✗ ${run.status}: ${applyTally.applied} applied, ${applyTally.failed} failed`);
    process.stderr.write(`${badge}${planId && store ? pe.dim(" — run recorded on the plan") : ""}\n`);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    console.log(formatPatchPlanRun(run));
  }
  if (run.status === "failed") process.exitCode = 1;
}

export async function diffCommand(args: string[]) {
  const beforePath = option(args, "--before");
  const afterPath = option(args, "--after");
  if (!beforePath || !afterPath) {
    throw new Error("diff requires --before <snapshot.json> and --after <snapshot.json>");
  }
  const before = JSON.parse(
    readFileSync(resolve(process.cwd(), beforePath), "utf8"),
  ) as CanonicalGtmSnapshot;
  const after = JSON.parse(
    readFileSync(resolve(process.cwd(), afterPath), "utf8"),
  ) as CanonicalGtmSnapshot;

  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded));
  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;
  const staleDealDays = numericOption(args, "--stale-days");
  if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;

  const diff = diffSnapshots(before, after);
  const drift = diffFindings(
    auditSnapshot(before, policy, rules),
    auditSnapshot(after, policy, rules),
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify({ diff, drift }, null, 2));
  } else {
    console.log(diffToMarkdown(diff, drift));
  }
  if (args.includes("--fail-on-new-findings") && drift.newFindings.length > 0) {
    process.exitCode = 2;
  }
}

export async function mergeCommand(args: string[]) {
  const inputs = repeatedOption(args, "--input");
  if (inputs.length < 2) {
    throw new Error("merge requires at least two --input <snapshot.json> sources");
  }
  const out = option(args, "--out");
  if (!out) throw new Error("merge requires --out <merged.json>");

  const snapshots = inputs.map(
    (input) =>
      JSON.parse(readFileSync(resolve(process.cwd(), input), "utf8")) as CanonicalGtmSnapshot,
  );
  const { snapshot, report } = mergeSnapshots(snapshots);
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(snapshot, null, 2)}\n`);

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Merged ${report.sources.join(" + ")} into ${out}.`);
  for (const type of ["user", "account", "contact"] as const) {
    const count = report.matches.filter((match) => match.type === type).length;
    console.log(`  ${type} merges: ${count}`);
  }
  console.log(`  conflicts: ${report.conflicts.length}`);
  for (const conflict of report.conflicts) {
    console.log(
      `    ${conflict.type}/${conflict.recordId} ${conflict.field}: ${conflict.values
        .map((entry) => `${entry.provider}=${JSON.stringify(entry.value)}`)
        .join(" vs ")}`,
    );
  }
  if (report.suggestions.length > 0) {
    console.log(`  review suggestions (same name, not auto-merged): ${report.suggestions.length}`);
    for (const suggestion of report.suggestions) {
      console.log(`    "${suggestion.name}": ${suggestion.recordIds.join(", ")}`);
    }
  }
  console.log(`Audit the merged view with \`fullstackgtm audit --input ${out}\`.`);
}

export async function plansCommand(args: string[]) {
  const store = createFilePlanStore();
  const [subcommand, ...rest] = args;

  if (subcommand === "list" || subcommand === undefined) {
    const status = option(rest, "--status") as
      | "draft" | "needs_approval" | "approved" | "rejected" | "applied"
      | null;
    const plans = await store.list(status ?? undefined);
    if (rest.includes("--json") || args.includes("--json")) {
      console.log(
        JSON.stringify(
          plans.map((stored) => ({
            id: stored.plan.id,
            status: stored.status,
            summary: stored.plan.summary,
            approvedOperations: stored.approvedOperationIds.length,
            runs: stored.runs.length,
            createdAt: stored.createdAt,
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (plans.length === 0) {
      console.log("No stored plans. Create one with `fullstackgtm audit ... --save`.");
      return;
    }
    const p = paint(colorEnabled(process.stdout));
    if (p.enabled) {
      // Interactive terminals get an aligned table with status color-banding;
      // the plain per-line format below is unchanged for pipes.
      const rows = plans.map((stored) => [
        stored.plan.id,
        stored.status,
        `${stored.approvedOperationIds.length} approved`,
        `${stored.runs.length} run${stored.runs.length === 1 ? "" : "s"}`,
        stored.plan.summary,
      ]);
      // Long summaries would wrap and break the table's alignment. The summary
      // is the LAST column: cap it to what's left of the terminal width after
      // the fixed columns and their two-space gutters (floor of 24 so narrow
      // terminals still show something useful).
      const columns = process.stdout.columns ?? 80;
      const fixedWidth =
        [0, 1, 2, 3].reduce(
          (sum, index) => sum + Math.max(...rows.map((row) => row[index].length)),
          0,
        ) + 2 * 4;
      const summaryWidth = Math.max(24, columns - fixedWidth);
      for (const row of rows) row[4] = truncateToWidth(row[4], summaryWidth);
      const statusPainter = (cell: string) => {
        const painted = planStatusWord(cell.trimEnd(), p);
        return painted + cell.slice(cell.trimEnd().length);
      };
      for (const line of table(rows, [null, statusPainter, p.dim, p.dim, null])) {
        console.log(line);
      }
      return;
    }
    for (const stored of plans) {
      console.log(
        `${stored.plan.id}  ${stored.status.padEnd(14)} ${stored.plan.summary} (${stored.approvedOperationIds.length} approved, ${stored.runs.length} runs)`,
      );
    }
    return;
  }

  if (subcommand === "show") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans show <planId>");
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(stored, null, 2));
      return;
    }
    const showPaint = paint(colorEnabled(process.stdout));
    console.log(`Status: ${planStatusWord(stored.status, showPaint)}`);
    console.log(`Approved operations: ${stored.approvedOperationIds.join(", ") || "none"}`);
    console.log(`Runs: ${stored.runs.length}`);
    console.log("");
    console.log(stylizePlanMarkdown(patchPlanToMarkdown(stored.plan), showPaint));
    return;
  }

  if (subcommand === "approve") {
    const planId = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    if (!planId) throw new Error("Usage: fullstackgtm plans approve <planId> --operations <ids|all> | --values-from <suggestions.json>");
    const operations = option(rest, "--operations");
    const valuesFrom = option(rest, "--values-from");
    if (!operations && !valuesFrom) {
      throw new Error("plans approve requires --operations <ids|all> and/or --values-from <suggestions.json>");
    }
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);

    // Values from a `fullstackgtm suggest --out` file. High-confidence only by
    // default; widen with --min-confidence low, opt into record-creating
    // values (create:<Name>) with --include-creates. Explicit --value wins.
    let fileOverrides: Record<string, string> = {};
    if (valuesFrom) {
      const minConfidence = option(rest, "--min-confidence") ?? "high";
      if (!["high", "low"].includes(minConfidence)) {
        throw new Error("--min-confidence must be high or low");
      }
      const { overrides, skipped } = readSuggestionValues(
        valuesFrom,
        minConfidence,
        rest.includes("--include-creates"),
      );
      fileOverrides = overrides;
      if (Object.keys(overrides).length === 0) {
        throw new Error(
          `No suggestions in ${valuesFrom} meet the confidence bar (${skipped} below it). Re-run with --min-confidence low or --include-creates, or pass explicit --value overrides.`,
        );
      }
      if (skipped > 0) {
        console.log(`Skipped ${skipped} suggestion(s) below the confidence bar (widen with --min-confidence low / --include-creates).`);
      }
    }
    const explicitOverrides = parseValueOverrides(rest);
    const operationIds =
      operations === "all"
        ? stored.plan.operations.map((operation) => operation.id)
        : operations
          ? operations.split(",").map((id) => id.trim()).filter(Boolean)
          : Object.keys(fileOverrides);
    const updated = await store.approveOperations(planId, operationIds, {
      ...fileOverrides,
      ...explicitOverrides,
    });
    console.log(
      `Approved ${updated.approvedOperationIds.length} operation(s) on ${planId}. Apply with \`fullstackgtm apply --plan-id ${planId} --provider <name>\`.`,
    );
    return;
  }

  if (subcommand === "reject") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans reject <planId>");
    await store.reject(planId);
    console.log(`Rejected ${planId}.`);
    return;
  }

  throw unknownSubcommandError("plans", subcommand, ["list", "show", "approve", "reject"]);
}

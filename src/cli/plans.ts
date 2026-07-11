// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "../audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules, rulePackageTrustFromCli } from "../config.ts";
import { applyPatchPlan } from "../connector.ts";
import { diffFindings, diffSnapshots, diffToMarkdown } from "../diff.ts";
import { createChannelConnector } from "../connectors/outboxChannel.ts";
import { formatPatchPlanRun, patchPlanToMarkdown } from "../format.ts";
import { mergeSnapshots } from "../merge.ts";
import { verifyApprovalDigests } from "../integrity.ts";
import { buildAuditLog, verifyAuditLog } from "../auditLog.ts";
import { createFilePlanStore, type StoredPlan } from "../planStore.ts";
import { ENRICH_CONFIG_FILE_NAME, loadEnrichConfig, type EnrichConfig } from "../enrich.ts";
import { loadMeter, recordConsumption, remaining } from "../acquireMeter.ts";
import { progressReporter, reportCounts } from "../runReport.ts";
import { claimHostedPlanApply, reconcileHostedPatchPlan, releaseHostedPlanApply, reportHostedPlanLifecycle, uploadHostedPatchPlan } from "../hostedPatchPlan.ts";
import { APPLY_STAGES, composeListeners, createProgressEmitter } from "../progress.ts";
import type { ValueSuggestion } from "../suggest.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload, PatchOperation, PatchPlan, PatchPlanRun } from "../types.ts";
import { connectorFor, isOptionValue, numericOption, option, repeatedOption, selectedRules } from "./shared.ts";
import { box, colorEnabled, createProgressRenderer, createStatusLine, formatDuration, paint, planStatusWord, stylizePlanMarkdown, table, truncateToWidth } from "./ui.ts";
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

function recordHeadline(operation: PatchOperation): { title: string; subtitle?: string; company?: string } {
  const after = operation.afterValue && typeof operation.afterValue === "object" && !Array.isArray(operation.afterValue)
    ? operation.afterValue as Record<string, unknown> : {};
  const properties = after.properties && typeof after.properties === "object" && !Array.isArray(after.properties)
    ? after.properties as Record<string, unknown> : {};
  const first = typeof properties.firstname === "string" ? properties.firstname : "";
  const last = typeof properties.lastname === "string" ? properties.lastname : "";
  const company = typeof properties.company === "string" ? properties.company
    : typeof after.associateCompanyName === "string" ? after.associateCompanyName : undefined;
  const title = [first, last].filter(Boolean).join(" ") || company || operation.objectId || operation.id;
  const role = typeof properties.jobtitle === "string" ? properties.jobtitle : undefined;
  return { title, ...(role ? { subtitle: role } : {}), ...(company ? { company } : {}) };
}

function planEffect(stored: StoredPlan): string {
  const total = stored.plan.operations.length;
  const approved = stored.approvedOperationIds.length;
  if (stored.status === "applied") {
    const results = stored.runs.at(-1)?.results ?? [];
    const applied = results.filter((result) => result.status === "applied").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    return `Completed ${applied} operation${applied === 1 ? "" : "s"}${skipped ? `; ${skipped} skipped` : ""}. No further writes will run.`;
  }
  if (stored.status === "approved") return `Apply will execute ${approved} selected operation${approved === 1 ? "" : "s"}; ${total - approved} will not run.`;
  if (stored.status === "rejected") return "Rejected. No provider writes can run.";
  return `No provider writes can run until operations are approved (0 of ${total} selected).`;
}

function printPlanCards(stored: StoredPlan, hostedUrl?: string) {
  const p = paint(colorEnabled(process.stdout));
  const total = stored.plan.operations.length;
  const approved = new Set(stored.approvedOperationIds);
  const width = Math.max(56, Math.min(100, (process.stdout.columns ?? 100) - 4));
  const fit = (value: string) => truncateToWidth(value, width);
  const summary = [
    fit(stored.plan.title),
    `Status     ${stored.status.toUpperCase().replaceAll("_", " ")}`,
    `Selection  ${approved.size} of ${total} operation${total === 1 ? "" : "s"} approved`,
    `Runs       ${stored.runs.length}`,
    fit(`Effect     ${planEffect(stored)}`),
  ];
  console.log(box(summary, p, "Plan").join("\n"));
  if (hostedUrl) console.log(`Hosted: ${hostedUrl}`);
  console.log("\nOperations");
  let operationIndex = 0;
  const latestResults = new Map((stored.runs.at(-1)?.results ?? []).map((result) => [result.operationId, result.status]));
  for (const operation of stored.plan.operations) {
    const selected = approved.has(operation.id);
    const resultStatus = latestResults.get(operation.id);
    const headline = recordHeadline(operation);
    const action = operation.operation === "create_record"
      ? `Create ${operation.objectType}${headline.company ? ` and resolve/link ${headline.company}` : ""}`
      : `${operation.operation.replaceAll("_", " ")} ${operation.objectType}`;
    const lines = [
      fit(headline.title),
      ...(headline.subtitle || headline.company
        ? [fit([headline.subtitle, headline.company].filter(Boolean).join(" · "))]
        : []),
      fit(`Action     ${action}`),
      `Operation  ${operation.id}`,
    ];
    if (operationIndex++ > 0) console.log("");
    const state = resultStatus === "applied" ? "✓ APPLIED"
      : resultStatus && selected ? `! ${resultStatus.toUpperCase()}`
        : selected ? "✓ APPROVED" : stored.status === "applied" ? "○ EXCLUDED" : "○ NOT APPROVED";
    console.log(box(lines, p, state).join("\n"));
  }
  if (stored.status === "approved") {
    console.log(`\nNext: fullstackgtm apply --plan-id ${stored.plan.id} --provider <hubspot|salesforce>`);
  }
  console.log(`Details: fullstackgtm plans show ${stored.plan.id} --verbose`);
}

function printApplyCards(run: PatchPlanRun, plan: PatchPlan, approvedOperationIds: string[], planIdStored: boolean) {
  const p = paint(colorEnabled(process.stdout));
  const approved = new Set(approvedOperationIds);
  const operations = new Map(plan.operations.map((operation) => [operation.id, operation]));
  const counts = { applied: 0, skipped: 0, failed: 0, conflict: 0 };
  for (const result of run.results) counts[result.status] += 1;
  const elapsed = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const summary = [
    `Status    ${run.status.toUpperCase()}`,
    `Provider  ${run.provider}`,
    `Outcome   ${counts.applied} applied · ${run.results.length - approved.size} excluded · ${counts.failed + counts.conflict} failed/conflicted`,
    `Duration  ${formatDuration(elapsed)}`,
    ...(planIdStored ? ["Receipt   recorded locally; hosted reconciliation requested"] : []),
  ];
  console.log(box(summary, p, "Apply result").join("\n"));
  console.log("\nOperations");
  let index = 0;
  for (const result of run.results) {
    const operation = operations.get(result.operationId);
    if (!operation) continue;
    const selected = approved.has(result.operationId);
    const headline = recordHeadline(operation);
    const state = !selected ? "○ EXCLUDED" : result.status === "applied" ? "✓ APPLIED" : `! ${result.status.toUpperCase()}`;
    const lines = [
      headline.title,
      ...(headline.subtitle || headline.company ? [[headline.subtitle, headline.company].filter(Boolean).join(" · ")] : []),
      `Operation  ${result.operationId}`,
      ...(result.detail ? [truncateToWidth(`Result     ${result.detail}`, 100)] : []),
    ];
    if (index++ > 0) console.log("");
    console.log(box(lines, p, state).join("\n"));
  }
  if (planIdStored) console.log(`\nInspect: fullstackgtm plans show ${run.planId}`);
  console.log("Details: rerun with --verbose; machine output: --json");
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
    let stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    const reconciliation = await reconcileHostedPatchPlan(store, stored);
    if (reconciliation.status === "conflict") throw new Error(`Refusing to apply plan ${planId}: ${reconciliation.reason}.`);
    if (reconciliation.status === "updated") {
      stored = reconciliation.stored;
      console.error(`Synced hosted ${reconciliation.remoteStatus} state for ${planId}.`);
    }
    if (stored.status === "applied") {
      console.log(`Plan ${planId} was already applied by another replica; imported its execution receipt. No provider writes were attempted.`);
      return;
    }
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
  let applyClaimId: string | undefined;
  let hostedApplyClaimId: string | undefined;
  if (planId && store) {
    const claimed = await store.claimApply(planId, { provider: provider ?? `channel:${channel}`, source: "cli" });
    applyClaimId = claimed.claimId;
    const hostedClaim = await claimHostedPlanApply(claimed.stored);
    if (hostedClaim.status === "applied") {
      await store.abortApplyPreflight(planId, claimed.claimId, "Another replica completed apply before provider I/O.");
      const refreshed = await store.get(planId);
      if (refreshed) await reconcileHostedPatchPlan(store, refreshed);
      console.log(`Plan ${planId} was already applied by another replica. No provider writes were attempted.`);
      return;
    }
    if (hostedClaim.status === "conflict") {
      await store.abortApplyPreflight(planId, claimed.claimId, `Hosted execution claim failed: ${hostedClaim.reason}`);
      throw new Error(`Refusing to apply plan ${planId}: could not coordinate with its hosted replica (${hostedClaim.reason}).`);
    }
    if (hostedClaim.status === "unavailable") {
      console.error(`Hosted replica is unavailable (${hostedClaim.reason}); continuing local-first. Resolve-before-create and provider conflict guards remain active, and the execution receipt will sync on a later check-in.`);
    }
    if (hostedClaim.status === "claimed") {
      hostedApplyClaimId = hostedClaim.claimId;
      await store.recordHostedClaim(planId, claimed.claimId, hostedClaim.claimId);
    }
    const claimedVerification = verifyApprovalDigests(
      claimed.stored.plan.operations,
      claimed.stored.approvedOperationIds,
      claimed.stored.valueOverrides,
      claimed.stored.approvalDigests,
    );
    if (!claimedVerification.ok) {
      if (hostedApplyClaimId) {
        const released = await releaseHostedPlanApply(
          claimed.stored,
          hostedApplyClaimId,
          "Approval integrity verification failed after claim and before provider I/O.",
        );
        if (released.status === "conflict" || released.status === "unavailable") {
          console.error(`Hosted apply claim may require recovery: ${released.reason}.`);
        }
      }
      await store.abortApplyPreflight(
        planId,
        claimed.claimId,
        "Approval integrity verification failed after the claim and before provider I/O.",
      );
      throw new Error(`Refusing to apply plan ${planId}: approval changed while acquiring the apply claim.`);
    }
    plan = claimed.stored.plan;
    approvedOperationIds = claimed.stored.approvedOperationIds;
    valueOverrides = claimed.stored.valueOverrides;
  }
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
  } catch (error) {
    // Once applyPatchPlan starts, an exception cannot prove that the provider
    // performed no write. Keep the claim fail-closed for operator reconciliation.
    if (planId && store && applyClaimId) await store.markApplyUncertain(planId, applyClaimId);
    throw error;
  } finally {
    renderer.done();
  }
  if (planId && store) {
    const recorded = await store.recordRun(planId, run, applyClaimId!);
    const durableHostedClaimId = recorded.applyAttempts?.find((attempt) => attempt.id === applyClaimId)?.hostedClaimId;
    const mirrored = await reportHostedPlanLifecycle(recorded, { claimId: durableHostedClaimId ?? hostedApplyClaimId });
    if (mirrored.status === "unavailable" || mirrored.status === "conflict") {
      console.error(`Hosted plan status is stale: ${mirrored.reason}. Local apply history remains authoritative.`);
    }
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
  } else if (args.includes("--verbose")) {
    console.log(formatPatchPlanRun(run));
  } else {
    printApplyCards(run, plan, approvedOperationIds, Boolean(planId && store));
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

  const explicitConfig = option(args, "--config") ?? undefined;
  const loaded = loadConfig(explicitConfig);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded, undefined, rulePackageTrustFromCli(args, explicitConfig)));
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
    let plans = await store.list(status ?? undefined);
    const synced = await Promise.all(plans.map(async (stored) => {
      const result = await reconcileHostedPatchPlan(store, stored);
      if (result.status === "updated") return result.stored;
      return stored;
    }));
    plans = status ? synced.filter((stored) => stored.status === status) : synced;
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
      const statusCounts = new Map<string, number>();
      for (const stored of plans) statusCounts.set(stored.status, (statusCounts.get(stored.status) ?? 0) + 1);
      const awaiting = plans.filter((stored) => stored.status === "needs_approval").length;
      const approved = plans.filter((stored) => stored.status === "approved").length;
      console.log(box([
        `${plans.length} plan${plans.length === 1 ? "" : "s"} · ${awaiting} awaiting approval · ${approved} ready to apply`,
        [...statusCounts.entries()].map(([name, count]) => `${name.replaceAll("_", " ")}: ${count}`).join("  ·  "),
      ], p, "Change queue").join("\n"));
      console.log("");
      // Interactive terminals get an aligned decision table; the plain
      // per-line format below remains stable for pipes and scripts.
      const rows = plans.map((stored) => [
        stored.status,
        stored.plan.title,
        `${stored.approvedOperationIds.length}/${stored.plan.operations.length} selected`,
        `${stored.runs.length} run${stored.runs.length === 1 ? "" : "s"}`,
        stored.plan.id,
      ]);
      // Long summaries would wrap and break the table's alignment. The summary
      // is the LAST column: cap it to what's left of the terminal width after
      // the fixed columns and their two-space gutters (floor of 24 so narrow
      // terminals still show something useful).
      const columns = process.stdout.columns ?? 80;
      const fixedWidth =
        [0, 2, 3, 4].reduce(
          (sum, index) => sum + Math.max(...rows.map((row) => row[index].length)),
          0,
        ) + 2 * 4;
      const titleWidth = Math.max(24, columns - fixedWidth);
      for (const row of rows) row[1] = truncateToWidth(row[1], titleWidth);
      const statusPainter = (cell: string) => {
        const painted = planStatusWord(cell.trimEnd(), p);
        return painted + cell.slice(cell.trimEnd().length);
      };
      for (const line of table(rows, [statusPainter, null, p.dim, p.dim, p.dim])) {
        console.log(line);
      }
      const next = plans.find((stored) => stored.status === "approved") ?? plans.find((stored) => stored.status === "needs_approval");
      if (next) {
        const command = next.status === "approved"
          ? `fullstackgtm apply --plan-id ${next.plan.id} --provider <name>`
          : `fullstackgtm plans show ${next.plan.id}`;
        console.log(`\nNext: ${command}`);
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
    let stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    const reconciliation = await reconcileHostedPatchPlan(store, stored);
    if (reconciliation.status === "updated") {
      stored = reconciliation.stored;
      console.error(`Synced hosted ${reconciliation.remoteStatus} state for ${planId}.`);
    } else if (reconciliation.status === "conflict") {
      console.error(`Hosted sync conflict: ${reconciliation.reason}.`);
    }
    if (rest.includes("--json")) {
      console.log(JSON.stringify(stored, null, 2));
      return;
    }
    const mirror = await uploadHostedPatchPlan(stored);
    printPlanCards(stored, mirror.status === "saved" ? mirror.state.url : undefined);
    if (mirror.status === "unavailable" || mirror.status === "conflict") console.log(`Hosted sync pending: ${mirror.reason}`);
    if (rest.includes("--verbose") && stored.applyAttempts?.length) {
      console.log("Apply attempts:");
      for (const attempt of stored.applyAttempts) {
        console.log(`  ${attempt.id}  ${attempt.status}  ${attempt.provider} via ${attempt.source}  ${attempt.claimedAt}`);
        if (attempt.note) console.log(`    ${attempt.note}`);
      }
    }
    if (rest.includes("--verbose")) {
      const showPaint = paint(colorEnabled(process.stdout));
      console.log("\nFull plan document\n");
      console.log(stylizePlanMarkdown(patchPlanToMarkdown(stored.plan), showPaint));
    }
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
    const mirror = await reportHostedPlanLifecycle(updated);
    if (mirror.status === "unavailable" || mirror.status === "conflict") {
      console.error(`Hosted plan status is stale: ${mirror.reason}. Local approval remains authoritative.`);
    }
    console.log(
      `Approved ${updated.approvedOperationIds.length} operation(s) on ${planId}. Apply with \`fullstackgtm apply --plan-id ${planId} --provider <name>\`.`,
    );
    return;
  }

  if (subcommand === "reject") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans reject <planId>");
    const rejected = await store.reject(planId);
    const mirror = await reportHostedPlanLifecycle(rejected);
    if (mirror.status === "unavailable" || mirror.status === "conflict") {
      console.error(`Hosted plan status is stale: ${mirror.reason}. Local rejection remains authoritative.`);
    }
    console.log(`Rejected ${planId}.`);
    return;
  }

  if (subcommand === "recover") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) {
      throw new Error("Usage: fullstackgtm plans recover <planId> --acknowledge-uncertain-writes");
    }
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (stored.status !== "applying" || !stored.applyClaim) {
      throw new Error(`Plan ${planId} has no unresolved apply attempt.`);
    }
    const attempt = stored.applyAttempts?.find((entry) => entry.id === stored.applyClaim?.id);
    if (!rest.includes("--acknowledge-uncertain-writes")) {
      throw new Error(
        `Plan ${planId} has an unresolved ${attempt?.provider ?? "provider"} apply attempt (${stored.applyClaim.id}). ` +
          "Inspect the affected records in the provider; do not replay automatically. If you accept that some writes may already have landed, " +
          `run \`fullstackgtm plans recover ${planId} --acknowledge-uncertain-writes\`. This clears every approval and requires a fresh review and approval before retrying.`,
      );
    }
    await store.recoverApply(planId);
    console.log(
      `Released ${planId} to needs_approval after acknowledging uncertain provider state. ` +
        `No writes were replayed. Re-audit provider state, review the plan, then approve operations again before any apply.`,
    );
    return;
  }

  if (subcommand === "sync") {
    const plans = await store.list();
    let updated = 0;
    let completed = 0;
    const warnings: string[] = [];
    const status = createStatusLine();
    status.set(`Synchronizing plan replicas 0/${plans.length}`);
    // A workspace can accumulate hundreds of local plans. Reconcile with a
    // small worker pool so one network round-trip per plan does not turn into
    // a minutes-long silent serial wait, without stampeding the hosted API.
    let next = 0;
    const worker = async () => {
      while (next < plans.length) {
        const stored = plans[next++];
        const result = await reconcileHostedPatchPlan(store, stored);
        if (result.status === "updated") updated += 1;
        else if (result.status === "conflict" || result.status === "unavailable") warnings.push(`${stored.plan.id}: ${result.reason}`);
        // Historical local-only plans have no remote row to receive a receipt.
        // `backfill runs` is the explicit import path for that old history.
        if (stored.status === "applied" && result.status !== "missing" && (stored.applyAttempts?.length ?? 0) > 0) {
          const hostedClaimId = [...(stored.applyAttempts ?? [])].reverse().find((attempt) => attempt.hostedClaimId)?.hostedClaimId;
          const pushed = await reportHostedPlanLifecycle(stored, { claimId: hostedClaimId });
          if (pushed.status === "conflict" || pushed.status === "unavailable") warnings.push(`${stored.plan.id} receipt: ${pushed.reason}`);
        }
        completed += 1;
        status.set(`Synchronizing plan replicas ${completed}/${plans.length}`);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(6, plans.length) }, () => worker()));
    } finally {
      status.done();
    }
    console.log(`Plan replicas synchronized: ${updated} updated, ${plans.length - updated} unchanged.`);
    for (const warning of warnings) console.error(`  ${warning}`);
    return;
  }

  throw unknownSubcommandError("plans", subcommand, ["list", "show", "sync", "approve", "reject", "recover"]);
}

// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "../audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "../config.ts";
import { applyPatchPlan } from "../connector.ts";
import { patchPlanToMarkdown } from "../format.ts";
import { createFilePlanStore } from "../planStore.ts";
import { resolveRecord, type ResolveCandidate } from "../resolve.ts";
import { parseAssignmentPolicy } from "../assign.ts";
import { buildLeadRoutePlan } from "../route.ts";
import { accountHierarchyToMarkdown, buildAccountHierarchy } from "../hierarchy.ts";
import { buildRelationshipMap, relationshipMapToMarkdown } from "../relationships.ts";
import { buildBulkUpdatePlan } from "../bulkUpdate.ts";
import { buildDedupePlan, type DedupeOptions } from "../dedupe.ts";
import { buildReassignPlans, type ReassignObjectType } from "../reassign.ts";
import { suggestValues } from "../suggest.ts";
import { APPLY_STAGES, composeListeners, createProgressEmitter } from "../progress.ts";
import { progressReporter } from "../runReport.ts";
import type { PatchPlan, PatchPlanRun } from "../types.ts";
import { confirmRequested, connectorFor, isOptionValue, numericOption, option, readSnapshot, repeatedOption, saveRequested } from "./shared.ts";
import { box, colorEnabled, createProgressRenderer, paint } from "./ui.ts";


/**
 * The resolve gate: exit 0 = safe to create, exit 2 = match found (exists or
 * ambiguous — do NOT blind-create), exit 1 = error. Built for sync jobs and
 * webhook handlers to call before any record creation.
 */
export async function resolveCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error("Usage: fullstackgtm resolve <account|contact|deal> [--name N] [--domain D] [--email E] [--account-id A] [source options] [--json]");
  }
  const candidate: ResolveCandidate = {
    objectType: objectType as ResolveCandidate["objectType"],
    name: option(rest, "--name") ?? undefined,
    domain: option(rest, "--domain") ?? undefined,
    email: option(rest, "--email") ?? undefined,
    accountId: option(rest, "--account-id") ?? undefined,
  };
  const snapshot = await readSnapshot(rest);
  const result = resolveRecord(snapshot, candidate);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const marker = result.verdict === "safe_to_create" ? "✓" : result.verdict === "exists" ? "=" : "?";
    console.log(`${marker} [${result.verdict}] ${result.reason}`);
    for (const m of result.matches) {
      console.log(`    ${m.id} "${m.name}" — matched by ${m.matchedBy}: ${m.detail}`);
    }
  }
  if (result.verdict !== "safe_to_create") process.exitCode = 2;
}

/**
 * Governed generic writes: build a dry-run patch plan from a snapshot filter
 * plus field assignments (or --archive). Never writes — approve and apply the
 * plan like any audit plan; compare-and-set protects every operation.
 */
export async function bulkUpdateCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error(
      "Usage: fullstackgtm bulk-update <account|contact|deal> --where <field=value|field!=value|field~substr|field:empty|field:notempty> [--where …] (--set <field>=<value> [--set …] | --archive) [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]",
    );
  }
  const where = repeatedOption(rest, "--where");
  const set: Record<string, string> = {};
  for (const pair of repeatedOption(rest, "--set")) {
    const separator = pair.indexOf("=");
    if (separator === -1) throw new Error(`--set must look like <field>=<value>, got "${pair}"`);
    set[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  const snapshot = await readSnapshot(rest);
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: objectType as "account" | "contact" | "deal",
    where,
    set: Object.keys(set).length > 0 ? set : undefined,
    archive: rest.includes("--archive"),
    forceArchiveDuplicates: rest.includes("--force-archive-duplicates"),
    createTask: option(rest, "--create-task") ?? undefined,
    require: repeatedOption(rest, "--require"),
    guard: repeatedOption(rest, "--guard"),
    reason: option(rest, "--reason") ?? undefined,
    maxOperations: numericOption(rest, "--max-operations"),
    // --today resolves the comparison `today` literal (e.g. closeDate<today);
    // defaults to the system date inside buildBulkUpdatePlan when omitted.
    today: option(rest, "--today") ?? undefined,
  });
  await emitPlan(plan, rest);
}

/** Shared plan output plumbing: --out, --save (with the approve/apply hint), --json or markdown. */
async function emitPlan(plan: PatchPlan, args: string[]) {
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (saveRequested(args)) {
    await createFilePlanStore().save(plan);
    console.error(
      `Saved plan ${plan.id} (${plan.operations.length} operations). Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`, then \`fullstackgtm apply --plan-id ${plan.id} --provider <name>\`.`,
    );
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(patchPlanToMarkdown(plan));
  }
}

/**
 * Governed duplicate cleanup: group by a normalized identity key, propose one
 * merge_records per duplicate group with a deterministic survivor. Never
 * writes — approve and apply the plan like any audit plan.
 */
export async function dedupeCommand(args: string[]) {
  const [objectType, ...rest] = args;
  if (!objectType || !["account", "contact", "deal"].includes(objectType)) {
    throw new Error(
      "Usage: fullstackgtm dedupe <account|contact|deal> --key <domain|email|name> [--keep richest|oldest] [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]",
    );
  }
  const key = option(rest, "--key");
  if (!key || !["domain", "email", "name"].includes(key)) {
    throw new Error("dedupe requires --key <domain|email|name> (the identity field duplicates share).");
  }
  const keep = option(rest, "--keep") ?? undefined;
  const snapshot = await readSnapshot(rest);
  const plan = buildDedupePlan(snapshot, {
    objectType: objectType as DedupeOptions["objectType"],
    key: key as DedupeOptions["key"],
    keep: (keep ?? undefined) as DedupeOptions["keep"],
    reason: option(rest, "--reason") ?? undefined,
    maxOperations: numericOption(rest, "--max-operations"),
  });
  await emitPlan(plan, rest);
}

/**
 * Ownership handoff playbook: compile one bulk-update-style plan per object
 * type. Each plan carries its full filter, so eligibility (including the
 * --except-deal-stage exclusion) is re-verified per record at apply time.
 */
export async function reassignCommand(args: string[]) {
  const from = option(args, "--from");
  const to = option(args, "--to");
  const assignUnowned = args.includes("--assign-unowned");
  if (!to || (!from && !assignUnowned)) {
    throw new Error(
      "Usage: fullstackgtm reassign (--from <ownerId> | --assign-unowned) --to <ownerId> [--objects account,contact,deal] [--where <expr> …] [--except-deal-stage <stage>] [--include-closed-deals] [source options] [--reason <text>] [--max-operations <n>] [--save] [--out <path>] [--json]\n\n--assign-unowned claims every OWNERLESS record (ownerId:empty) for --to — the backfill twin of `enrich acquire`'s create-time assignment.",
    );
  }
  const objects = option(args, "--objects")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) as ReassignObjectType[] | undefined;
  const snapshot = await readSnapshot(args);
  const plans = buildReassignPlans(snapshot, {
    fromOwnerId: from ?? undefined,
    toOwnerId: to,
    assignUnowned,
    objects,
    where: repeatedOption(args, "--where"),
    exceptDealStage: option(args, "--except-deal-stage") ?? undefined,
    includeClosedDeals: args.includes("--include-closed-deals"),
    reason: option(args, "--reason") ?? undefined,
    maxOperations: numericOption(args, "--max-operations"),
  });
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plans, null, 2)}\n`);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plans, null, 2));
    return;
  }
  const store = saveRequested(args) ? createFilePlanStore() : null;
  for (const plan of plans) {
    if (store) await store.save(plan);
    console.log(`${plan.id}  ${String(plan.operations.length).padStart(3)} operation(s)  ${plan.title}`);
    console.log(`    ${plan.summary}`);
  }
  if (store) {
    console.log(
      `\nSaved ${plans.length} plan(s). For each: \`fullstackgtm plans show <id>\`, \`fullstackgtm plans approve <id> --operations <ids|all>\`, then \`fullstackgtm apply --plan-id <id> --provider <name>\`.`,
    );
  } else {
    console.log("\nDry run only — re-run with --save to store the plans for approval.");
  }
}

/**
 * One-shot composite for a single audit rule: audit → save → suggest →
 * approve only suggestion-backed operations meeting the confidence bar (plus
 * operations that carry concrete values and need no human input) → apply
 * (only with --yes). Every stage goes through the same gates as the manual
 * chain; placeholder values below the bar stay unapproved.
 */
export async function fixCommand(args: string[]) {
  const ruleId = option(args, "--rule");
  const provider = option(args, "--provider");
  if (!ruleId || !provider) {
    throw new Error(
      "Usage: fullstackgtm fix --rule <ruleId> --provider <name> [--min-confidence high|low] [--include-creates] [--today <iso>] [--yes|--confirm] [--dry-run]",
    );
  }
  const minConfidence = option(args, "--min-confidence") ?? "high";
  if (!["high", "low"].includes(minConfidence)) {
    throw new Error("--min-confidence must be high or low");
  }
  const includeCreates = args.includes("--include-creates");

  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const configured = await resolveConfiguredRules(loaded);
  const rule = configured.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    throw new Error(`Unknown rule: ${ruleId}. Available rules: ${configured.map((r) => r.id).join(", ")}`);
  }
  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;

  const snapshot = await readSnapshot(args);
  const plan = auditSnapshot(snapshot, policy, [rule]);
  if (plan.operations.length === 0) {
    console.log(`fix ${ruleId}: audit proposed 0 operations — nothing to fix.`);
    return;
  }
  const store = createFilePlanStore();
  await store.save(plan);

  const suggestions = suggestValues(plan, snapshot);
  const accepted = new Set(minConfidence === "low" ? ["high", "low"] : ["high"]);
  const overrides: Record<string, string> = {};
  let belowBar = 0;
  for (const suggestion of suggestions) {
    if (
      suggestion.suggestedValue &&
      (accepted.has(suggestion.confidence) || (includeCreates && suggestion.confidence === "create"))
    ) {
      overrides[suggestion.operationId] = suggestion.suggestedValue;
    } else {
      belowBar += 1;
    }
  }
  // Approve operations whose placeholder got a qualifying suggested value,
  // plus operations that already carry a concrete value (no human input
  // needed — nothing to guess). Everything else stays unapproved.
  const placeholderIds = new Set(suggestions.map((suggestion) => suggestion.operationId));
  const approvedIds = plan.operations
    .map((operation) => operation.id)
    .filter((id) => overrides[id] !== undefined || !placeholderIds.has(id));

  const lines = [
    `fix ${ruleId} via ${provider}:`,
    `  proposed:  ${plan.operations.length} operation(s) — plan ${plan.id} (saved)`,
    `  suggested: ${Object.keys(overrides).length} value(s) at ${minConfidence}+ confidence${includeCreates ? " (creates included)" : ""}${belowBar > 0 ? `; ${belowBar} below the bar (left unapproved)` : ""}`,
    `  approved:  ${approvedIds.length} of ${plan.operations.length}`,
  ];
  if (approvedIds.length === 0) {
    lines.push("  applied:   0 — no operation met the confidence bar");
    console.log(lines.join("\n"));
    console.log(
      `\nWiden with --min-confidence low / --include-creates, or approve manually: \`fullstackgtm plans approve ${plan.id} --operations <ids> --value <opId>=<value>\`.`,
    );
    return;
  }
  await store.approveOperations(plan.id, approvedIds, overrides);

  // `--confirm` is the standardized alias for the legacy `--yes`; `--dry-run`
  // wins over both and locks the stop-before-apply path.
  if (!confirmRequested(args, "--yes")) {
    lines.push("  applied:   0 (stopped before apply — pass --yes to write)");
    console.log(lines.join("\n"));
    // The decision moment: frame the exact command that writes. Rich-only —
    // piped output keeps the plain two-line hint byte-for-byte.
    const p = paint(colorEnabled(process.stdout));
    if (p.enabled) {
      console.log("");
      console.log(box([`fullstackgtm apply --plan-id ${plan.id} --provider ${provider}`], p, "Apply with").join("\n"));
    } else {
      console.log(`\nApply with:\n  fullstackgtm apply --plan-id ${plan.id} --provider ${provider}`);
    }
    return;
  }
  const connector = await connectorFor(provider, args);
  // Live apply board on interactive terminals (stderr; inert otherwise); the
  // same emitter streams heartbeats to the paired hosted app on long runs.
  const renderer = createProgressRenderer(APPLY_STAGES);
  const progress = createProgressEmitter(
    composeListeners(renderer.listener, progressReporter()),
  );
  let run: PatchPlanRun;
  try {
    run = await applyPatchPlan(connector, plan, {
      approvedOperationIds: approvedIds,
      valueOverrides: overrides,
      progress,
    });
  } finally {
    renderer.done();
  }
  await store.recordRun(plan.id, run);
  const counts: Record<string, number> = { applied: 0, conflict: 0, skipped: 0, failed: 0 };
  for (const result of run.results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  lines.push(
    `  applied:   ${counts.applied} · conflicts: ${counts.conflict} · skipped: ${counts.skipped} · failed: ${counts.failed}`,
  );
  console.log(lines.join("\n"));
  if (run.status === "failed") process.exitCode = 1;
}

export async function suggest(args: string[]) {
  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) {
    // Same legible guess as `apply <id>`: name the exact corrected command.
    const positional = args.find((arg) => !arg.startsWith("-") && !isOptionValue(args, arg));
    if (positional) {
      throw new Error(
        `suggest takes the plan as a flag, not a positional. Try: fullstackgtm suggest --plan-id ${positional}`,
      );
    }
    throw new Error("suggest requires --plan <path> or --plan-id <id>");
  }
  let plan: PatchPlan;
  if (planId) {
    const stored = await createFilePlanStore().get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    plan = stored.plan;
  } else {
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath!), "utf8")) as PatchPlan;
  }

  const snapshot = await readSnapshot(args);
  const suggestions = suggestValues(plan, snapshot);
  const payload = { planId: planId ?? planPath, suggestions };

  const outPath = option(args, "--out");
  if (outPath) writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(payload, null, 2)}\n`);

  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (suggestions.length === 0) {
    console.log("No requires_human_* placeholder operations in this plan — nothing to suggest.");
    return;
  }
  const byConfidence: Record<string, number> = {};
  for (const s of suggestions) byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
  console.log(`Suggestions for ${suggestions.length} placeholder operation(s):\n`);
  for (const s of suggestions) {
    const marker =
      s.confidence === "high" ? "✓" : s.confidence === "low" ? "~" : s.confidence === "create" ? "+" : "✗";
    console.log(`${marker} [${s.confidence}] ${s.operationId} ${s.objectName ?? s.objectId}`);
    console.log(`    ${s.suggestedValue ? `→ ${s.suggestedValue}` : "(no suggestion)"} — ${s.reason}`);
  }
  console.log(`\n${Object.entries(byConfidence).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  if (planId && (byConfidence.high ?? 0) > 0 && !outPath) {
    console.log(
      `\nChain it:\n  fullstackgtm suggest --plan-id ${planId} ${snapshotSourceHint(args)}--out suggestions.json\n  fullstackgtm plans approve ${planId} --values-from suggestions.json\n  fullstackgtm apply --plan-id ${planId} --provider <name>`,
    );
  }
}

function snapshotSourceHint(args: string[]) {
  const provider = option(args, "--provider");
  if (provider) return `--provider ${provider} `;
  const input = option(args, "--input");
  if (input) return `--input ${input} `;
  return "";
}

function parseJsonOrFile(value: string): unknown {
  const candidate = resolve(process.cwd(), value);
  const text = existsSync(candidate) ? readFileSync(candidate, "utf8") : value;
  return JSON.parse(text);
}

export async function routeCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  if (subcommand !== "leads") {
    throw new Error("Usage: fullstackgtm route leads [source options] [--match domain|company|both] [--no-inherit-owner] [--reassign-owned] [--policy <json|path>] [--save] [--json] [--out <path>]");
  }
  const match = option(rest, "--match") ?? "domain";
  if (!["domain", "company", "both"].includes(match)) throw new Error("--match must be domain, company, or both");
  const policyRaw = option(rest, "--policy");
  const snapshot = await readSnapshot(rest);
  const result = buildLeadRoutePlan(snapshot, {
    matchByDomain: match === "domain" || match === "both",
    matchByCompanyName: match === "company" || match === "both",
    inheritAccountOwner: !rest.includes("--no-inherit-owner"),
    reassignExistingOwner: rest.includes("--reassign-owned"),
    assignmentPolicy: policyRaw ? parseAssignmentPolicy(parseJsonOrFile(policyRaw)) : undefined,
    maxOperations: numericOption(rest, "--max-operations"),
    reason: option(rest, "--reason") ?? undefined,
  });
  if (rest.includes("--json")) {
    const out = option(rest, "--out");
    if (out) writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(result.plan, null, 2)}\n`);
    if (saveRequested(rest)) await createFilePlanStore().save(result.plan);
    console.error(`Route dry-run: ${JSON.stringify(result.counts)}`);
    console.log(JSON.stringify({ counts: result.counts, plan: result.plan }, null, 2));
    return;
  }
  console.error(
    `Route dry-run: ${result.counts.linkOperations} link(s), ${result.counts.ownerOperations} owner assignment(s), ${result.counts.ambiguousAccountMatches} ambiguous match(es).`,
  );
  await emitPlan(result.plan, rest);
}

export async function hierarchyCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  if (subcommand !== "report") throw new Error("Usage: fullstackgtm hierarchy report [source options] [--json|--out <path>]");
  const snapshot = await readSnapshot(rest);
  const report = buildAccountHierarchy(snapshot);
  const out = option(rest, "--out");
  const rendered = rest.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${accountHierarchyToMarkdown(report)}\n`;
  if (out) writeFileSync(resolve(process.cwd(), out), rendered);
  console.log(rendered.trimEnd());
}

export async function relationshipsCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  if (subcommand !== "account") throw new Error("Usage: fullstackgtm relationships account (--account-id <id>|--domain <d>) [source options] [--json|--out <path>]");
  const accountId = option(rest, "--account-id") ?? undefined;
  const domain = option(rest, "--domain") ?? undefined;
  if (!accountId && !domain) throw new Error("relationships account needs --account-id <id> or --domain <domain>");
  const snapshot = await readSnapshot(rest);
  const map = buildRelationshipMap(snapshot, { accountId, domain });
  const out = option(rest, "--out");
  const rendered = rest.includes("--json") ? `${JSON.stringify(map, null, 2)}\n` : `${relationshipMapToMarkdown(map)}\n`;
  if (out) writeFileSync(resolve(process.cwd(), out), rendered);
  console.log(rendered.trimEnd());
}

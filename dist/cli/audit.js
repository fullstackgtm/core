// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "../audit.js";
import { loadConfig, mergePolicy, resolveConfiguredRules, rulePackageTrustFromCli } from "../config.js";
import { getCredential, resolveHubspotConnection } from "../credentials.js";
import { patchPlanToMarkdown } from "../format.js";
import { appendHealthEntry, computeHealth, healthToMarkdown, readHealthTimeline, saveWorkspaceSnapshot, summarizeHealth, activeWorkspaceProfile } from "../health.js";
import { createFilePlanStore } from "../planStore.js";
import { auditReportToHtml, auditReportToMarkdown } from "../report.js";
import { reportCounts, reportCrm, reportFindings } from "../runReport.js";
import { connectorFor, numericOption, option, readSnapshot, saveRequested, selectedRules } from "./shared.js";
import { colorEnabled, createChecklist, formatCount, paint, scoreColor, sparkline, stylizePlanMarkdown, table } from "./ui.js";
const SEVERITY_RANK = {
    info: 0,
    warning: 1,
    critical: 2,
};
function failOnThreshold(args) {
    const value = option(args, "--fail-on");
    if (!value)
        return null;
    if (value !== "info" && value !== "warning" && value !== "critical") {
        throw new Error("--fail-on must be one of: info, warning, critical");
    }
    return value;
}
export async function snapshotCommand(args) {
    const since = option(args, "--since");
    let snapshot;
    if (since) {
        const provider = option(args, "--provider");
        if (!provider)
            throw new Error("--since requires --provider <name>");
        const connector = await connectorFor(provider, args);
        if (!connector.fetchChanges) {
            throw new Error(`The ${provider} connector does not support incremental fetch.`);
        }
        snapshot = await connector.fetchChanges(since);
    }
    else {
        snapshot = await readSnapshot(args);
    }
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const archive = option(args, "--archive");
    if (archive) {
        const dir = resolve(process.cwd(), archive);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dir, { recursive: true });
        const fileName = `${snapshot.provider}-${snapshot.generatedAt.replace(/[:.]/g, "-")}.json`;
        const path = resolve(dir, fileName);
        writeFileSync(path, serialized);
        console.log(`Archived snapshot to ${path}`);
        return;
    }
    const out = option(args, "--out");
    if (out) {
        writeFileSync(resolve(process.cwd(), out), serialized);
        console.log(`Wrote snapshot (${snapshot.users.length} users, ${snapshot.accounts.length} accounts, ` +
            `${snapshot.contacts.length} contacts, ${snapshot.deals.length} deals, ` +
            `${snapshot.activities.length} activities) to ${out}`);
    }
    else {
        console.log(serialized.trimEnd());
    }
}
// #2 (dx-punch-list): every read verb points forward. `audit` is the keystone —
// `audit --demo` is the most-run first command and used to dead-end on a blank
// line. Context-aware guidance mirrors doctor's "Next step" and fix's chaining,
// stepping the user along Detect → Govern → apply. Printed to stderr so stdout
// stays clean for pipes/--out; suppressed under --json (machine/agent context).
function auditNextStep(args, plan) {
    const provider = option(args, "--provider");
    const usingLiveData = Boolean(provider) || Boolean(option(args, "--input"));
    const saved = saveRequested(args);
    const count = plan.findings.length;
    if (count === 0) {
        return [
            "✓ No findings — this snapshot is clean. Nothing to apply.",
            "  Keep it clean: gate new records with `fullstackgtm resolve`,",
            "  and schedule a recurring check with `fullstackgtm schedule add ...`.",
        ].join("\n");
    }
    const head = `${count} finding${count === 1 ? "" : "s"} — a dry-run plan. Nothing was written.`;
    if (!usingLiveData) {
        return [
            head,
            "Next:",
            "  • Client-ready writeup:  fullstackgtm report --demo",
            "  • Run on your CRM:       fullstackgtm login hubspot  →  fullstackgtm audit --provider hubspot --save",
        ].join("\n");
    }
    if (!saved) {
        return [
            head,
            "Next: persist it with --save, then suggest → approve → apply:",
            `  fullstackgtm audit --provider ${provider ?? "<name>"} --save`,
        ].join("\n");
    }
    // --save already confirmed the plan id above; chain the governed spine.
    const providerFlag = provider ? ` --provider ${provider}` : "";
    return [
        head,
        "Next: derive values, approve the safe ones, apply:",
        `  fullstackgtm suggest --plan-id ${plan.id}${providerFlag} --out suggestions.json`,
        `  fullstackgtm plans approve ${plan.id} --values-from suggestions.json`,
        `  fullstackgtm apply --plan-id ${plan.id}${providerFlag}`,
    ].join("\n");
}
/**
 * Resolve the live HubSpot account's record-URL base (e.g.
 * `https://app-na2.hubspot.com/contacts/<portalId>/record`) and report it on the
 * run so the dashboard can deep-link findings. Best-effort: any failure is
 * swallowed — deep-links are a nicety, never a reason to fail the audit.
 */
async function reportHubspotDeepLinkBase() {
    try {
        const connection = await resolveHubspotConnection();
        if (!connection?.accessToken)
            return;
        const response = await fetch("https://api.hubapi.com/account-info/v3/details", {
            headers: { Authorization: `Bearer ${connection.accessToken}` },
        });
        if (!response.ok)
            return;
        const info = (await response.json());
        if (!info.portalId || !info.uiDomain)
            return;
        reportCrm({
            provider: "hubspot",
            recordUrlBase: `https://${info.uiDomain}/contacts/${info.portalId}/record`,
        });
    }
    catch {
        // deep-link base is best-effort
    }
}
/**
 * When paired (a broker credential exists), hand the local HubSpot token to the
 * hosted deployment so its Integrations page shows HubSpot connected and the
 * backend can sync on its own. The token lands in the same place a manual
 * in-app connect would (encrypted on the org's integration). Best-effort:
 * never blocks or fails the audit.
 */
async function registerHubspotWithBroker() {
    try {
        const broker = getCredential("broker");
        if (!broker?.baseUrl || !broker.accessToken)
            return; // only when paired
        const connection = await resolveHubspotConnection();
        if (!connection?.accessToken)
            return;
        const response = await fetch(`${broker.baseUrl.replace(/\/+$/, "")}/api/cli/integration`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${broker.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ provider: "hubspot", token: connection.accessToken }),
            signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
            console.error(`Registered HubSpot with ${broker.baseUrl} — it now shows on the dashboard's Integrations page.`);
        }
    }
    catch {
        // registering the connection is best-effort; never affect the audit
    }
}
export async function audit(args) {
    const threshold = failOnThreshold(args);
    const explicitConfig = option(args, "--config") ?? undefined;
    const loaded = loadConfig(explicitConfig);
    const rules = selectedRules(args, await resolveConfiguredRules(loaded, undefined, rulePackageTrustFromCli(args, explicitConfig)));
    const snapshot = await readSnapshot(args);
    const policy = mergePolicy(defaultPolicy(), loaded?.config);
    const today = option(args, "--today");
    if (today)
        policy.today = today;
    const staleDealDays = numericOption(args, "--stale-days");
    if (staleDealDays !== undefined)
        policy.staleDealDays = staleDealDays;
    // Interactive terminals watch the rule registry fill in (○ → spinner → ✓,
    // with per-rule finding counts) on stderr; the board erases itself before
    // the plan renders. Piped/CI/agent runs get an inert no-op.
    const board = createChecklist(rules.map((rule) => ({ id: rule.id, label: rule.id })));
    let plan;
    try {
        plan = auditSnapshot(snapshot, policy, rules, board.active
            ? (ruleId, phase, count) => board.update(ruleId, phase === "start" ? "running" : "ok", phase === "done" ? `${count} finding${count === 1 ? "" : "s"}` : undefined)
            : undefined);
    }
    finally {
        board.done();
    }
    reportCounts({
        findings: plan.findings.length,
        critical: plan.findings.filter((f) => f.severity === "critical").length,
        warning: plan.findings.filter((f) => f.severity === "warning").length,
    });
    // Row-level detail for the hosted dashboard: IDs + issue type only (no field
    // values). Enrich each finding with its proposed op's field/operation when one
    // is linked, so the dashboard can show "what" and "where" without "the value".
    const opByFinding = new Map();
    for (const op of plan.operations ?? []) {
        for (const findingId of op.findingIds ?? []) {
            if (!opByFinding.has(findingId)) {
                opByFinding.set(findingId, { field: op.field, operation: op.operation });
            }
        }
    }
    reportFindings(plan.findings.map((f) => ({
        objectType: f.objectType,
        objectId: f.objectId,
        severity: f.severity,
        ruleId: f.ruleId,
        ...opByFinding.get(f.id),
    })));
    // When auditing a live HubSpot, emit the account's record-URL base so the
    // hosted dashboard can deep-link each finding to the real CRM record. Best
    // effort and HubSpot-only for now; never blocks or fails the audit.
    if (option(args, "--provider") === "hubspot") {
        await reportHubspotDeepLinkBase();
        await registerHubspotWithBroker();
    }
    const out = option(args, "--out");
    if (out) {
        writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
    }
    if (saveRequested(args)) {
        await createFilePlanStore().save(plan);
        // Engagement workspace: stamp the per-profile health timeline + snapshot so
        // the org accrues a continuous record from the verb people already run.
        // Honor --today (audit is deterministic under it); fall back to wall-clock.
        const health = computeHealth(plan, snapshot, today ?? new Date().toISOString());
        appendHealthEntry(health);
        saveWorkspaceSnapshot(plan.id, snapshot);
        console.error(`Saved plan ${plan.id}. Health ${health.score}/100 recorded (\`fullstackgtm health\`). ` +
            `Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`.`);
    }
    if (args.includes("--json")) {
        console.log(JSON.stringify(plan, null, 2));
    }
    else {
        // Default to the summary view (rule table + counts); the full per-operation
        // dump is opt-in via --full or, for a deliverable, `report`. (dx-punch-list #3)
        // Interactive terminals get the styled rendering; piped output is unchanged.
        console.log(stylizePlanMarkdown(patchPlanToMarkdown(plan, { summary: !args.includes("--full") }), paint(colorEnabled(process.stdout))));
        console.error(`\n${auditNextStep(args, plan)}`);
    }
    if (threshold &&
        plan.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])) {
        process.exitCode = 2;
    }
}
/**
 * Roll up the active profile's health timeline (accrued by `audit --save`):
 * current deterministic score, change since the last audit, and per-rule
 * deltas. Read-only — it only reads `health.jsonl`, never re-audits.
 */
export function healthCommand(args) {
    const profile = activeWorkspaceProfile();
    const rollup = summarizeHealth(readHealthTimeline(), profile);
    if (!rollup) {
        if (args.includes("--json")) {
            console.log(JSON.stringify({ profile, auditCount: 0 }, null, 2));
        }
        else {
            console.log(`No audits recorded yet for profile "${profile}".\n` +
                "Start the timeline: `fullstackgtm audit --provider <name> --save`" +
                (profile === "default" ? "" : ` --profile ${profile}`) +
                ".");
        }
        return;
    }
    if (args.includes("--json")) {
        console.log(JSON.stringify(rollup, null, 2));
        return;
    }
    const p = paint(colorEnabled(process.stdout));
    // The markdown rollup is a deliverable — piped/redirected output stays
    // byte-identical to the pre-TUI CLI. Interactive terminals get the styled view.
    console.log(p.enabled ? renderHealthRich(rollup, p) : healthToMarkdown(rollup));
}
/** Interactive-terminal rendering of the health rollup: the markdown's facts, styled. */
function renderHealthRich(rollup, p) {
    const { current, scoreDelta } = rollup;
    const deltaText = scoreDelta === null
        ? p.dim("(first audit — no prior reading)")
        : `${scoreDelta === 0 ? p.dim("·") : scoreDelta > 0 ? p.green("▲") : p.red("▼")} ${scoreDelta >= 0 ? p.green(`+${scoreDelta}`) : p.red(`${scoreDelta}`)} ${p.dim("since the previous audit")}`;
    const trend = rollup.history.length > 1
        ? `  ${p.cyan(sparkline(rollup.history.map((point) => point.score)))}`
        : "";
    const severity = (count, label, painter) => count > 0 ? painter(`${count} ${label}`) : p.dim(`${count} ${label}`);
    const lines = [
        p.bold(`GTM health — profile ${rollup.profile}`),
        "",
        `Score ${p.bold(scoreColor(current.score, p))}${p.dim("/100")} ${deltaText}${trend}`,
        p.dim(`${rollup.auditCount} audit(s), ${shortDay(rollup.first)} → ${shortDay(rollup.latest)}`),
        `Findings: ${formatCount(current.findings)} (${severity(current.severityCounts.critical, "critical", p.red)}, ${severity(current.severityCounts.warning, "warning", p.yellow)}, ${severity(current.severityCounts.info, "info", p.dim)})`,
        "",
        // Widths are measured on raw cell text, so cells stay unstyled here; the
        // header row is dimmed as a whole line after layout.
        ...table([
            ["", "type", "score", "findings", "records"],
            ...["account", "contact", "deal"].map((type) => {
                const bucket = current.byObjectType[type];
                return ["", type, `${bucket.score}/100`, formatCount(bucket.findings), formatCount(bucket.records)];
            }),
        ]).map((row, index) => (index === 0 ? p.dim(row) : row)),
    ];
    if (rollup.ruleDeltas.length > 0) {
        // More findings = worse, so a positive delta paints red. The delta is the
        // LAST column: ANSI codes there never skew the padding of columns before it.
        const deltaCell = (delta) => delta === 0 ? p.dim("·") : delta > 0 ? p.red(`+${delta}`) : p.green(`${delta}`);
        lines.push("", p.dim("By rule (Δ since previous audit)"), ...table(rollup.ruleDeltas.map((rule) => ["", rule.ruleId, formatCount(rule.current), deltaCell(rule.delta)])));
    }
    return lines.join("\n");
}
/** 2026-06-12T08:00:00Z → "2026-06-12". */
function shortDay(at) {
    return at.slice(0, 10);
}
/**
 * Render an audit as a client-facing deliverable. Same sources and audit
 * options as `audit`; `--plan` instead renders an existing plan JSON without
 * re-fetching (useful for a plan produced earlier or by another machine).
 */
export async function reportCommand(args) {
    const explicitConfig = option(args, "--config") ?? undefined;
    const loaded = loadConfig(explicitConfig);
    const configuredRules = await resolveConfiguredRules(loaded, undefined, rulePackageTrustFromCli(args, explicitConfig));
    let plan;
    let snapshot;
    const planPath = option(args, "--plan");
    if (planPath) {
        plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
        const input = option(args, "--input");
        if (input) {
            snapshot = JSON.parse(readFileSync(resolve(process.cwd(), input), "utf8"));
        }
    }
    else {
        snapshot = await readSnapshot(args);
        const policy = mergePolicy(defaultPolicy(), loaded?.config);
        const today = option(args, "--today");
        if (today)
            policy.today = today;
        const staleDealDays = numericOption(args, "--stale-days");
        if (staleDealDays !== undefined)
            policy.staleDealDays = staleDealDays;
        plan = auditSnapshot(snapshot, policy, selectedRules(args, configuredRules));
    }
    const reportOptions = {
        title: option(args, "--title") ?? undefined,
        clientName: option(args, "--client") ?? undefined,
        preparedBy: option(args, "--prepared-by") ?? undefined,
        date: option(args, "--today") ?? undefined,
        maxExamplesPerRule: numericOption(args, "--max-examples"),
        rules: configuredRules,
        snapshot,
    };
    const out = option(args, "--out");
    const format = option(args, "--format") ?? (out?.endsWith(".html") ? "html" : "markdown");
    if (format !== "markdown" && format !== "html") {
        throw new Error("--format must be markdown or html");
    }
    const rendered = format === "html"
        ? auditReportToHtml(plan, reportOptions)
        : auditReportToMarkdown(plan, reportOptions);
    if (out) {
        writeFileSync(resolve(process.cwd(), out), rendered);
        console.log(`Wrote ${format} report (${plan.findings.length} findings) to ${out}`);
    }
    else {
        console.log(rendered.trimEnd());
    }
}
export async function rulesCommand(args) {
    const explicitConfig = option(args, "--config") ?? undefined;
    const loaded = loadConfig(explicitConfig);
    const rules = await resolveConfiguredRules(loaded, undefined, rulePackageTrustFromCli(args, explicitConfig));
    if (args.includes("--json")) {
        console.log(JSON.stringify(rules.map(({ id, title, description, category }) => ({
            id,
            title,
            description,
            category: category ?? "uncategorized",
        })), null, 2));
        return;
    }
    for (const rule of rules) {
        console.log(`${rule.id} [${rule.category ?? "uncategorized"}]\n  ${rule.title}\n  ${rule.description}\n`);
    }
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "./audit.js";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.js";
import { applyPatchPlan } from "./connector.js";
import { diffFindings, diffSnapshots, diffToMarkdown } from "./diff.js";
import { createHubspotConnector } from "./connectors/hubspot.js";
import { DEFAULT_LOOPBACK_PORT, openInBrowser, runHubspotLoopbackLogin, validateHubspotToken, } from "./connectors/hubspotAuth.js";
import { createSalesforceConnector } from "./connectors/salesforce.js";
import { createStripeConnector } from "./connectors/stripe.js";
import { pollSalesforceDeviceLogin, startSalesforceDeviceLogin, validateSalesforceToken, } from "./connectors/salesforceAuth.js";
import { credentialsPath, deleteCredential, getCredential, resolveHubspotConnection, resolveSalesforceConnection, storeCredential, } from "./credentials.js";
import { generateDemoSnapshot } from "./demo.js";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.js";
import { mergeSnapshots } from "./merge.js";
import { createFilePlanStore } from "./planStore.js";
import { builtinAuditRules } from "./rules.js";
import { sampleSnapshot } from "./sampleData.js";
function usage() {
    return `FullStackGTM — audit GTM data across providers, propose reviewable patch plans,
and apply only explicitly approved operations.

Usage:
  fullstackgtm login --via <hosted url>        pair with a team deployment (recommended)
  fullstackgtm login hubspot [--no-validate]
  fullstackgtm login hubspot --oauth --client-id <id> [--port ${DEFAULT_LOOPBACK_PORT}] [--scopes a,b]
  fullstackgtm login salesforce --device --client-id <consumer key> [--login-url <url>]
  fullstackgtm login salesforce --instance-url <url> [--no-validate]
  fullstackgtm login stripe [--no-validate]
  fullstackgtm logout <hubspot|salesforce|stripe|broker>

  Secrets (tokens, client secrets) are NEVER passed as flags — they leak via
  the process list and shell history. Pipe them on stdin or enter them at the
  interactive prompt:
    echo "$HUBSPOT_TOKEN" | fullstackgtm login hubspot
  fullstackgtm snapshot [source options] [--since <iso>] [--out <path> | --archive <dir>]
  fullstackgtm audit [source options] [audit options] [--save]
  fullstackgtm diff --before <a.json> --after <b.json> [--json] [--fail-on-new-findings]
  fullstackgtm merge --input <a.json> --input <b.json> [...] --out <merged.json> [--json]
  fullstackgtm plans list [--status <s>] | show <id> | approve <id> --operations <ids|all> | reject <id>
  fullstackgtm apply --plan-id <id> --provider <name>
  fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [options]
  fullstackgtm rules [--json]
  fullstackgtm doctor [--json]                 check install, credentials, and next step

Plan lifecycle:
  audit --save persists the dry-run plan to ~/.fullstackgtm/plans. Approve
  specific operations (optionally with --value <opId>=<v> for placeholders),
  then apply by id — the store enforces approval and records every run.

Authentication (checked in order):
  1. --token-env <name>        explicit env var for this invocation (hubspot)
  2. ambient env               HUBSPOT_ACCESS_TOKEN, or SALESFORCE_ACCESS_TOKEN +
                               SALESFORCE_INSTANCE_URL (CI, agent sandboxes)
  3. stored provider login     fullstackgtm login <provider>; kept in ~/.fullstackgtm
                               (hubspot: private app token or loopback OAuth;
                               salesforce: device flow — code on any device, no
                               secret, silent refresh)
  4. broker pairing            fullstackgtm login --via <url>: the team connects the
                               CRM once in the hosted dashboard; every paired CLI
                               uses those stored sync credentials from then on

Source options (snapshot and audit):
  --sample               Built-in minimal mock CRM data (default)
  --demo                 Realistic generated mid-market CRM with injected hygiene issues
  --seed <n>             Demo PRNG seed (default 7; same seed, same data)
  --input <path>         Canonical GTM snapshot JSON file
  --provider <name>      Live provider snapshot: hubspot | salesforce | stripe (read-only)
  --token-env <name>     Env var holding the provider access token

Audit options:
  --config <path>        Config file (default: ./fullstackgtm.config.json if present)
                         { "policy": {...}, "rules": {"enabled":[],"disabled":[]},
                           "rulePackages": ["./team-rules.mjs"] }
  --rules <ids>          Comma-separated rule ids to run (default: all; see \`rules\`)
  --json                 Print the JSON patch plan instead of markdown
  --out <path>           Also write the JSON patch plan to a file
  --today <date>         Override today's date for deterministic audits
  --stale-days <n>       Days without activity before an open deal is stale
  --fail-on <severity>   Exit 2 if any finding is at or above info|warning|critical

Apply options:
  --plan <path>          Patch plan JSON produced by \`audit --out\`
  --provider hubspot     Connector to apply through
  --token-env <name>     Env var holding the provider access token
  --approve <ids|all>    Comma-separated operation ids to apply, or "all"
  --value <opId>=<v>     Concrete value for a requires_human_* placeholder (repeatable)
  --json                 Print the JSON run record instead of markdown

Exit codes:
  0 success · 1 error · 2 audit findings at/above the --fail-on threshold

Safety:
  Audits are read-only. Apply writes only operations you explicitly approve,
  and never writes requires_human_* placeholders without a --value override.`;
}
function option(args, name) {
    const index = args.indexOf(name);
    if (index === -1)
        return null;
    return args[index + 1] ?? null;
}
function repeatedOption(args, name) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === name && args[index + 1] !== undefined) {
            values.push(args[index + 1]);
        }
    }
    return values;
}
function numericOption(args, name) {
    const value = option(args, name);
    if (value === null)
        return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        throw new Error(`${name} must be a number`);
    return parsed;
}
async function hubspotConnection(args) {
    const tokenEnv = option(args, "--token-env");
    if (tokenEnv) {
        const token = process.env[tokenEnv];
        if (!token)
            throw new Error(`${tokenEnv} is not set.`);
        return { accessToken: token };
    }
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
        return { accessToken: process.env.HUBSPOT_ACCESS_TOKEN };
    }
    const stored = await resolveHubspotConnection();
    if (stored)
        return stored;
    throw new Error("No HubSpot credentials. Run `fullstackgtm login hubspot`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set HUBSPOT_ACCESS_TOKEN.");
}
async function salesforceConnection() {
    if (process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL) {
        return {
            accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
            instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
        };
    }
    const stored = await resolveSalesforceConnection();
    if (stored)
        return stored;
    throw new Error("No Salesforce credentials. Run `fullstackgtm login salesforce`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL.");
}
async function connectorFor(provider, args) {
    if (provider === "hubspot") {
        const connection = await hubspotConnection(args);
        return createHubspotConnector({
            getAccessToken: () => connection.accessToken,
            fieldMappings: connection.fieldMappings ?? undefined,
        });
    }
    if (provider === "salesforce") {
        const connection = await salesforceConnection();
        return createSalesforceConnector({
            getConnection: () => connection,
            fieldMappings: connection.fieldMappings ?? undefined,
        });
    }
    if (provider === "stripe") {
        const key = process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
        if (!key) {
            throw new Error("No Stripe credentials. Run `fullstackgtm login stripe --token sk_...` or set STRIPE_SECRET_KEY.");
        }
        return createStripeConnector({ getApiKey: () => key });
    }
    throw new Error(`Unknown provider: ${provider}. Supported providers: hubspot, salesforce, stripe`);
}
async function readSnapshot(args) {
    const provider = option(args, "--provider");
    if (provider) {
        const connector = await connectorFor(provider, args);
        return connector.fetchSnapshot();
    }
    if (args.includes("--demo")) {
        return generateDemoSnapshot({
            seed: numericOption(args, "--seed"),
            today: option(args, "--today") ?? undefined,
        });
    }
    const input = option(args, "--input");
    if (!input || args.includes("--sample"))
        return sampleSnapshot;
    const path = resolve(process.cwd(), input);
    return JSON.parse(readFileSync(path, "utf8"));
}
function selectedRules(args, baseRules = builtinAuditRules) {
    const requested = option(args, "--rules");
    if (!requested)
        return baseRules;
    const ids = requested.split(",").map((id) => id.trim()).filter(Boolean);
    const known = new Map(baseRules.map((rule) => [rule.id, rule]));
    const rules = ids.map((id) => {
        const rule = known.get(id);
        if (!rule) {
            throw new Error(`Unknown rule: ${id}. Available rules: ${baseRules.map((r) => r.id).join(", ")}`);
        }
        return rule;
    });
    return rules;
}
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
async function snapshotCommand(args) {
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
async function audit(args) {
    const threshold = failOnThreshold(args);
    const loaded = loadConfig(option(args, "--config") ?? undefined);
    const rules = selectedRules(args, await resolveConfiguredRules(loaded));
    const snapshot = await readSnapshot(args);
    const policy = mergePolicy(defaultPolicy(), loaded?.config);
    const today = option(args, "--today");
    if (today)
        policy.today = today;
    const staleDealDays = numericOption(args, "--stale-days");
    if (staleDealDays !== undefined)
        policy.staleDealDays = staleDealDays;
    const plan = auditSnapshot(snapshot, policy, rules);
    const out = option(args, "--out");
    if (out) {
        writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
    }
    if (args.includes("--save")) {
        await createFilePlanStore().save(plan);
        console.error(`Saved plan ${plan.id}. Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`.`);
    }
    if (args.includes("--json")) {
        console.log(JSON.stringify(plan, null, 2));
    }
    else {
        console.log(patchPlanToMarkdown(plan));
    }
    if (threshold &&
        plan.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])) {
        process.exitCode = 2;
    }
}
async function rulesCommand(args) {
    const loaded = loadConfig(option(args, "--config") ?? undefined);
    const rules = await resolveConfiguredRules(loaded);
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
/**
 * Provider error bodies can echo request parameters (including secrets) and
 * land in logs. Surface only the status and, when present, a known-safe error
 * description field — never the raw body.
 */
function safeStatus(response) {
    return `HTTP ${response.status} ${response.statusText}`.trim();
}
function parseValueOverrides(args) {
    const valueOverrides = {};
    for (const pair of repeatedOption(args, "--value")) {
        const separator = pair.indexOf("=");
        if (separator === -1)
            throw new Error(`--value must look like <operationId>=<value>`);
        valueOverrides[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    return valueOverrides;
}
async function apply(args) {
    const provider = option(args, "--provider");
    if (!provider)
        throw new Error("apply requires --provider <name>");
    const planId = option(args, "--plan-id");
    const planPath = option(args, "--plan");
    if (!planId && !planPath)
        throw new Error("apply requires --plan <path> or --plan-id <id>");
    let plan;
    let approvedOperationIds;
    let valueOverrides;
    const store = planId ? createFilePlanStore() : null;
    if (planId && store) {
        const stored = await store.get(planId);
        if (!stored)
            throw new Error(`No stored plan with id ${planId}.`);
        if (stored.status !== "approved") {
            throw new Error(`Plan ${planId} is ${stored.status}; approve operations first with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`);
        }
        plan = stored.plan;
        approvedOperationIds = stored.approvedOperationIds;
        valueOverrides = { ...stored.valueOverrides, ...parseValueOverrides(args) };
    }
    else {
        const approve = option(args, "--approve");
        if (!approve) {
            throw new Error('apply requires --approve <ids|all>; nothing is written without approval');
        }
        plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
        approvedOperationIds =
            approve === "all"
                ? plan.operations.map((operation) => operation.id)
                : approve.split(",").map((id) => id.trim()).filter(Boolean);
        valueOverrides = parseValueOverrides(args);
    }
    const connector = await connectorFor(provider, args);
    const run = await applyPatchPlan(connector, plan, {
        approvedOperationIds,
        valueOverrides,
    });
    if (planId && store) {
        await store.recordRun(planId, run);
    }
    if (args.includes("--json")) {
        console.log(JSON.stringify(run, null, 2));
    }
    else {
        console.log(formatPatchPlanRun(run));
    }
    if (run.status === "failed")
        process.exitCode = 1;
}
async function diffCommand(args) {
    const beforePath = option(args, "--before");
    const afterPath = option(args, "--after");
    if (!beforePath || !afterPath) {
        throw new Error("diff requires --before <snapshot.json> and --after <snapshot.json>");
    }
    const before = JSON.parse(readFileSync(resolve(process.cwd(), beforePath), "utf8"));
    const after = JSON.parse(readFileSync(resolve(process.cwd(), afterPath), "utf8"));
    const loaded = loadConfig(option(args, "--config") ?? undefined);
    const rules = selectedRules(args, await resolveConfiguredRules(loaded));
    const policy = mergePolicy(defaultPolicy(), loaded?.config);
    const today = option(args, "--today");
    if (today)
        policy.today = today;
    const staleDealDays = numericOption(args, "--stale-days");
    if (staleDealDays !== undefined)
        policy.staleDealDays = staleDealDays;
    const diff = diffSnapshots(before, after);
    const drift = diffFindings(auditSnapshot(before, policy, rules), auditSnapshot(after, policy, rules));
    if (args.includes("--json")) {
        console.log(JSON.stringify({ diff, drift }, null, 2));
    }
    else {
        console.log(diffToMarkdown(diff, drift));
    }
    if (args.includes("--fail-on-new-findings") && drift.newFindings.length > 0) {
        process.exitCode = 2;
    }
}
async function mergeCommand(args) {
    const inputs = repeatedOption(args, "--input");
    if (inputs.length < 2) {
        throw new Error("merge requires at least two --input <snapshot.json> sources");
    }
    const out = option(args, "--out");
    if (!out)
        throw new Error("merge requires --out <merged.json>");
    const snapshots = inputs.map((input) => JSON.parse(readFileSync(resolve(process.cwd(), input), "utf8")));
    const { snapshot, report } = mergeSnapshots(snapshots);
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(snapshot, null, 2)}\n`);
    if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    console.log(`Merged ${report.sources.join(" + ")} into ${out}.`);
    for (const type of ["user", "account", "contact"]) {
        const count = report.matches.filter((match) => match.type === type).length;
        console.log(`  ${type} merges: ${count}`);
    }
    console.log(`  conflicts: ${report.conflicts.length}`);
    for (const conflict of report.conflicts) {
        console.log(`    ${conflict.type}/${conflict.recordId} ${conflict.field}: ${conflict.values
            .map((entry) => `${entry.provider}=${JSON.stringify(entry.value)}`)
            .join(" vs ")}`);
    }
    if (report.suggestions.length > 0) {
        console.log(`  review suggestions (same name, not auto-merged): ${report.suggestions.length}`);
        for (const suggestion of report.suggestions) {
            console.log(`    "${suggestion.name}": ${suggestion.recordIds.join(", ")}`);
        }
    }
    console.log(`Audit the merged view with \`fullstackgtm audit --input ${out}\`.`);
}
async function plansCommand(args) {
    const store = createFilePlanStore();
    const [subcommand, ...rest] = args;
    if (subcommand === "list" || subcommand === undefined) {
        const status = option(rest, "--status");
        const plans = await store.list(status ?? undefined);
        if (rest.includes("--json") || args.includes("--json")) {
            console.log(JSON.stringify(plans.map((stored) => ({
                id: stored.plan.id,
                status: stored.status,
                summary: stored.plan.summary,
                approvedOperations: stored.approvedOperationIds.length,
                runs: stored.runs.length,
                createdAt: stored.createdAt,
            })), null, 2));
            return;
        }
        if (plans.length === 0) {
            console.log("No stored plans. Create one with `fullstackgtm audit ... --save`.");
            return;
        }
        for (const stored of plans) {
            console.log(`${stored.plan.id}  ${stored.status.padEnd(14)} ${stored.plan.summary} (${stored.approvedOperationIds.length} approved, ${stored.runs.length} runs)`);
        }
        return;
    }
    if (subcommand === "show") {
        const planId = rest.find((arg) => !arg.startsWith("--"));
        if (!planId)
            throw new Error("Usage: fullstackgtm plans show <planId>");
        const stored = await store.get(planId);
        if (!stored)
            throw new Error(`No stored plan with id ${planId}.`);
        if (rest.includes("--json")) {
            console.log(JSON.stringify(stored, null, 2));
            return;
        }
        console.log(`Status: ${stored.status}`);
        console.log(`Approved operations: ${stored.approvedOperationIds.join(", ") || "none"}`);
        console.log(`Runs: ${stored.runs.length}`);
        console.log("");
        console.log(patchPlanToMarkdown(stored.plan));
        return;
    }
    if (subcommand === "approve") {
        const planId = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
        if (!planId)
            throw new Error("Usage: fullstackgtm plans approve <planId> --operations <ids|all>");
        const operations = option(rest, "--operations");
        if (!operations)
            throw new Error("plans approve requires --operations <ids|all>");
        const stored = await store.get(planId);
        if (!stored)
            throw new Error(`No stored plan with id ${planId}.`);
        const operationIds = operations === "all"
            ? stored.plan.operations.map((operation) => operation.id)
            : operations.split(",").map((id) => id.trim()).filter(Boolean);
        const updated = await store.approveOperations(planId, operationIds, parseValueOverrides(rest));
        console.log(`Approved ${updated.approvedOperationIds.length} operation(s) on ${planId}. Apply with \`fullstackgtm apply --plan-id ${planId} --provider <name>\`.`);
        return;
    }
    if (subcommand === "reject") {
        const planId = rest.find((arg) => !arg.startsWith("--"));
        if (!planId)
            throw new Error("Usage: fullstackgtm plans reject <planId>");
        await store.reject(planId);
        console.log(`Rejected ${planId}.`);
        return;
    }
    throw new Error(`Unknown plans subcommand: ${subcommand}. Use list, show, approve, or reject.`);
}
/**
 * Read a secret without exposing it on the command line. Secrets passed as
 * argv leak through the process list (`ps`), `/proc`, and shell history, so
 * the CLI never accepts them as flags. Instead:
 *   - non-interactive: pipe it on stdin (docker `--password-stdin` style),
 *     e.g. `echo "$TOKEN" | fullstackgtm login hubspot`
 *   - interactive: prompted on the TTY with the input muted
 */
async function readSecret(label) {
    if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const piped = Buffer.concat(chunks).toString("utf8").trim();
        if (!piped) {
            throw new Error(`No secret provided. Pipe it on stdin (e.g. \`echo "$SECRET" | fullstackgtm login ...\`) ` +
                `or run interactively. Secrets are never accepted as CLI arguments — they leak via the ` +
                `process list and shell history.`);
        }
        // Multi-line stdin (rare) — take the first non-empty line.
        return piped.split(/\r?\n/)[0].trim();
    }
    const readline = await import("node:readline");
    return new Promise((resolveSecret) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
            terminal: true,
        });
        let muted = false;
        const mutable = rl;
        mutable._writeToOutput = (value) => {
            if (!muted)
                process.stderr.write(value);
        };
        rl.question(`${label}: `, (answer) => {
            rl.close();
            process.stderr.write("\n");
            resolveSecret(answer.trim());
        });
        muted = true;
    });
}
function rejectArgvSecret(args, ...flags) {
    for (const flag of flags) {
        if (args.includes(flag)) {
            throw new Error(`${flag} no longer accepts a value on the command line (argv secrets leak via \`ps\` and ` +
                `shell history). Pipe the secret on stdin instead, e.g. \`echo "$SECRET" | fullstackgtm login ...\`.`);
        }
    }
}
async function brokerLogin(baseUrl) {
    const base = baseUrl.replace(/\/$/, "");
    const os = await import("node:os");
    // Self-reported, shown to the approver so they can recognize this request
    // and refuse one they didn't initiate.
    const requesterLabel = `${os.hostname()} (${process.platform}, ${os.userInfo().username})`;
    const startResponse = await fetch(`${base}/api/cli/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requesterLabel }),
    });
    if (!startResponse.ok) {
        throw new Error(`Could not start pairing with ${base} (${startResponse.status}). Is this a FullStackGTM deployment?`);
    }
    const start = await startResponse.json();
    console.error(`\nPairing code: ${start.userCode}\n\nApprove this CLI ("${requesterLabel}") in your dashboard:\n\n  ${start.verificationUrl}\n`);
    void openInBrowser(start.verificationUrl);
    const deadline = Date.now() + (start.expiresInSeconds ?? 600) * 1000;
    const intervalMs = Math.max(0, (start.intervalSeconds ?? 3) * 1000);
    while (Date.now() < deadline) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
        const pollResponse = await fetch(`${base}/api/cli/auth/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceCode: start.deviceCode }),
        });
        if (!pollResponse.ok) {
            throw new Error(`Pairing poll failed (${pollResponse.status}).`);
        }
        const poll = await pollResponse.json();
        if (poll.status === "pending")
            continue;
        if (poll.status === "approved" && poll.cliToken) {
            const now = new Date().toISOString();
            storeCredential("broker", {
                kind: "broker",
                accessToken: poll.cliToken,
                baseUrl: base,
                createdAt: now,
                updatedAt: now,
            });
            console.log(`Paired with ${base}. Credentials stored in ${credentialsPath()}.`);
            console.log("Provider commands now use the organization's stored sync credentials via the deployment.");
            return;
        }
        throw new Error(`Pairing was ${poll.status}.`);
    }
    throw new Error("Pairing timed out before it was approved.");
}
function isOptionValue(args, arg) {
    const index = args.indexOf(arg);
    return index > 0 && args[index - 1].startsWith("--");
}
async function salesforceLogin(args) {
    const now = new Date().toISOString();
    if (args.includes("--device")) {
        const clientId = option(args, "--client-id");
        if (!clientId) {
            throw new Error("--device requires --client-id (the consumer key of a Connected App with device flow enabled).");
        }
        const loginUrl = option(args, "--login-url") ?? undefined;
        const authorization = await startSalesforceDeviceLogin({ clientId, loginUrl });
        console.error(`\nPairing code: ${authorization.userCode}\n\nConfirm this code at:\n\n  ${authorization.verificationUri}\n`);
        void openInBrowser(authorization.verificationUri);
        const tokens = await pollSalesforceDeviceLogin({
            clientId,
            deviceCode: authorization.deviceCode,
            intervalSeconds: authorization.intervalSeconds,
            loginUrl,
        });
        storeCredential("salesforce", {
            kind: "oauth",
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            instanceUrl: tokens.instanceUrl,
            expiresAt: tokens.expiresAt,
            clientId,
            loginUrl,
            createdAt: now,
            updatedAt: now,
        });
        console.log(`Logged in to Salesforce (${tokens.instanceUrl}). Credentials stored in ${credentialsPath()}.`);
        console.log("Tokens refresh silently; no further browser interaction is needed.");
        return;
    }
    rejectArgvSecret(args, "--token");
    const instanceUrl = option(args, "--instance-url");
    if (!instanceUrl) {
        throw new Error("Salesforce login needs --device --client-id <consumer key>, or --instance-url " +
            "<https://yourorg.my.salesforce.com> with the access token piped on stdin.");
    }
    const token = await readSecret("Salesforce access token");
    if (!token)
        throw new Error("No access token provided.");
    if (!args.includes("--no-validate")) {
        const result = await validateSalesforceToken(token, instanceUrl);
        if (!result.ok)
            throw new Error(result.detail);
        console.log(result.detail);
    }
    storeCredential("salesforce", {
        kind: "private_app",
        accessToken: token,
        instanceUrl,
        createdAt: now,
        updatedAt: now,
    });
    console.log(`Logged in to Salesforce. Credentials stored in ${credentialsPath()}.`);
}
async function login(args) {
    const via = option(args, "--via");
    if (via) {
        await brokerLogin(via);
        return;
    }
    const provider = args.find((arg) => !arg.startsWith("--") && !isOptionValue(args, arg));
    if (provider === "salesforce") {
        await salesforceLogin(args);
        return;
    }
    if (provider === "stripe") {
        rejectArgvSecret(args, "--token");
        const key = await readSecret("Stripe secret key (sk_...)");
        if (!key)
            throw new Error("No Stripe key provided.");
        if (!args.includes("--no-validate")) {
            const response = await fetch("https://api.stripe.com/v1/customers?limit=1", {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (!response.ok) {
                throw new Error(`Stripe rejected the key (${response.status}): ${safeStatus(response)}`);
            }
            console.log("Key accepted by the Stripe API.");
        }
        const stamp = new Date().toISOString();
        storeCredential("stripe", {
            kind: "private_app",
            accessToken: key,
            createdAt: stamp,
            updatedAt: stamp,
        });
        console.log(`Logged in to Stripe. Credentials stored in ${credentialsPath()}.`);
        return;
    }
    if (provider !== "hubspot") {
        throw new Error("login supports: hubspot, salesforce, stripe, or --via <hosted url>. Usage: fullstackgtm login <provider> | fullstackgtm login --via https://gtm.example.com");
    }
    const now = new Date().toISOString();
    if (args.includes("--oauth")) {
        rejectArgvSecret(args, "--client-secret");
        const clientId = option(args, "--client-id");
        if (!clientId) {
            throw new Error("--oauth requires --client-id from your own HubSpot app " +
                `(register http://localhost:${numericOption(args, "--port") ?? DEFAULT_LOOPBACK_PORT}/callback as a redirect URL). ` +
                "The client secret is read from stdin or an interactive prompt.");
        }
        const clientSecret = await readSecret("HubSpot app client secret");
        if (!clientSecret)
            throw new Error("No client secret provided.");
        const scopes = option(args, "--scopes")?.split(",").map((scope) => scope.trim());
        const tokens = await runHubspotLoopbackLogin({
            clientId,
            clientSecret,
            port: numericOption(args, "--port"),
            scopes,
        });
        storeCredential("hubspot", {
            kind: "oauth",
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            clientId,
            clientSecret,
            scopes,
            createdAt: now,
            updatedAt: now,
        });
        console.log(`Logged in to HubSpot via OAuth. Credentials stored in ${credentialsPath()}.`);
        console.log("Tokens refresh silently; no further browser interaction is needed.");
        return;
    }
    rejectArgvSecret(args, "--token");
    const token = await readSecret("HubSpot private app token");
    if (!token)
        throw new Error("No token provided.");
    if (!args.includes("--no-validate")) {
        const result = await validateHubspotToken(token);
        if (!result.ok)
            throw new Error(result.detail);
        console.log(result.detail);
    }
    storeCredential("hubspot", {
        kind: "private_app",
        accessToken: token,
        createdAt: now,
        updatedAt: now,
    });
    console.log(`Logged in to HubSpot. Credentials stored in ${credentialsPath()}.`);
}
function logout(args) {
    const provider = args.find((arg) => !arg.startsWith("--"));
    if (!provider)
        throw new Error("Usage: fullstackgtm logout hubspot");
    if (!getCredential(provider)) {
        console.log(`No stored credentials for ${provider}.`);
        return;
    }
    deleteCredential(provider);
    console.log(`Removed stored ${provider} credentials.`);
}
export function doctorReport(env = process.env) {
    const packageInfo = readPackageInfo();
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const storePath = credentialsPath();
    const configPath = resolve("fullstackgtm.config.json");
    const broker = getCredential("broker");
    const providers = {
        hubspot: env.HUBSPOT_ACCESS_TOKEN
            ? { source: "env", detail: "HUBSPOT_ACCESS_TOKEN" }
            : providerStatus("hubspot", broker),
        salesforce: env.SALESFORCE_ACCESS_TOKEN && env.SALESFORCE_INSTANCE_URL
            ? { source: "env", detail: "SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL" }
            : providerStatus("salesforce", broker),
        stripe: env.STRIPE_SECRET_KEY
            ? { source: "env", detail: "STRIPE_SECRET_KEY" }
            : providerStatus("stripe", broker),
    };
    const missingPeers = ["@modelcontextprotocol/sdk", "zod"].filter((name) => {
        try {
            import.meta.resolve(name);
            return false;
        }
        catch {
            return true;
        }
    });
    const connected = Object.entries(providers).filter(([, status]) => status.source !== "none");
    const nextSteps = connected.length === 0
        ? [
            "fullstackgtm audit --demo            # no credentials needed",
            "fullstackgtm login hubspot           # connect your CRM (or: login --via <hosted url>)",
        ]
        : [`fullstackgtm audit --provider ${connected[0][0]}`];
    return {
        package: packageInfo,
        node: { version: process.versions.node, ok: nodeMajor >= 20, required: ">=20" },
        credentialStore: { path: storePath, exists: existsSync(storePath) },
        config: { path: configPath, exists: existsSync(configPath) },
        providers,
        broker: broker ? { paired: true, baseUrl: broker.baseUrl ?? "unknown" } : { paired: false },
        mcp: { peersInstalled: missingPeers.length === 0, missing: missingPeers },
        nextSteps,
    };
}
function providerStatus(provider, broker) {
    const stored = getCredential(provider);
    if (stored) {
        return { source: "stored", detail: `${stored.kind} login, updated ${stored.updatedAt}` };
    }
    if (broker) {
        return { source: "broker", detail: `via ${broker.baseUrl ?? "hosted deployment"}` };
    }
    return { source: "none", detail: `fullstackgtm login ${provider}` };
}
function readPackageInfo() {
    try {
        const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        const parsed = JSON.parse(raw);
        return { name: parsed.name ?? "fullstackgtm", version: parsed.version ?? "unknown" };
    }
    catch {
        return { name: "fullstackgtm", version: "unknown" };
    }
}
function doctorCommand(args) {
    const report = doctorReport();
    if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    const mark = (ok) => (ok ? "ok" : "MISSING");
    const lines = [
        `Package:    ${report.package.name} ${report.package.version}`,
        `Node:       v${report.node.version} (${report.node.required} required) ${mark(report.node.ok)}`,
        `Cred store: ${report.credentialStore.path} (${report.credentialStore.exists ? "present" : "not created yet — created on first login"})`,
        `Config:     ${report.config.exists ? report.config.path : "none — defaults apply"}`,
        "",
        "Providers:",
        ...Object.entries(report.providers).map(([provider, status]) => `  ${provider.padEnd(11)} ${status.source === "none" ? `not connected (${status.detail})` : `${status.source}: ${status.detail}`}`),
        `  ${"broker".padEnd(11)} ${report.broker.paired ? `paired with ${report.broker.baseUrl}` : "not paired (fullstackgtm login --via <hosted url>)"}`,
        "",
        report.mcp.peersInstalled
            ? "MCP:        peers installed — `fullstackgtm-mcp` is ready"
            : `MCP:        optional peers missing (${report.mcp.missing.join(", ")}) — needed only for \`fullstackgtm-mcp\``,
        "",
        "Next step:",
        ...report.nextSteps.map((step) => `  ${step}`),
    ];
    console.log(lines.join("\n"));
    if (!report.node.ok)
        process.exitCode = 1;
}
export async function runCli(argv) {
    const [command, ...args] = argv;
    if (!command || command === "--help" || command === "-h") {
        console.log(usage());
        return;
    }
    if (command === "login") {
        await login(args);
        return;
    }
    if (command === "logout") {
        logout(args);
        return;
    }
    if (command === "snapshot") {
        await snapshotCommand(args);
        return;
    }
    if (command === "audit") {
        await audit(args);
        return;
    }
    if (command === "rules") {
        await rulesCommand(args);
        return;
    }
    if (command === "doctor") {
        doctorCommand(args);
        return;
    }
    if (command === "diff") {
        await diffCommand(args);
        return;
    }
    if (command === "merge") {
        await mergeCommand(args);
        return;
    }
    if (command === "plans") {
        await plansCommand(args);
        return;
    }
    if (command === "apply") {
        await apply(args);
        return;
    }
    console.error(`Unknown command: ${command}`);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
}

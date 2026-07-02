// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LOOPBACK_PORT, openInBrowser, runHubspotLoopbackLogin, validateHubspotToken } from "../connectors/hubspotAuth.js";
import { pollSalesforceDeviceLogin, startSalesforceDeviceLogin, validateSalesforceToken } from "../connectors/salesforceAuth.js";
import { activeProfile, credentialsPath, DEFAULT_PROFILE, deleteCredential, getCredential, storeCredential } from "../credentials.js";
import { activeWorkspaceProfile, readHealthTimeline, summarizeHealth } from "../health.js";
import { resolveLlmCredential, validateLlmKey } from "../llm.js";
import { createFilePlanStore } from "../planStore.js";
import { isOptionValue, numericOption, option, readPackageInfo, readSecret } from "./shared.js";
import { box, colorEnabled, paint, scoreColor, sparkline } from "./ui.js";
/**
 * Provider error bodies can echo request parameters (including secrets) and
 * land in logs. Surface only the status and, when present, a known-safe error
 * description field — never the raw body.
 */
function safeStatus(response) {
    return `HTTP ${response.status} ${response.statusText}`.trim();
}
function rejectArgvSecret(args, ...flags) {
    for (const flag of flags) {
        if (args.includes(flag)) {
            throw new Error(`${flag} no longer accepts a value on the command line (argv secrets leak via \`ps\` and ` +
                `shell history). Pipe the secret on stdin instead, e.g. \`echo "$SECRET" | fullstackgtm login ...\`.`);
        }
    }
}
/**
 * The broker channel carries a long-lived pairing bearer and receives freshly
 * minted live-CRM tokens, so it must be TLS unless it's an explicit localhost
 * dev target. Refuse http:// (and non-http schemes) otherwise — single-quote
 * shell escaping does nothing for a token sent in cleartext.
 */
export function assertSecureBrokerUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`--via must be a full URL (e.g. https://gtm.yourco.com), got "${raw}".`);
    }
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    if (url.protocol === "https:")
        return url;
    if (url.protocol === "http:" && isLocalhost)
        return url; // local dev only
    throw new Error(`Refusing to pair over ${url.protocol}//${url.host}: the broker exchanges a long-lived token and mints live CRM ` +
        "credentials, so it must use https (http is allowed only for localhost dev).");
}
async function brokerLogin(baseUrl) {
    const viaUrl = assertSecureBrokerUrl(baseUrl);
    const base = baseUrl.replace(/\/$/, "");
    const os = await import("node:os");
    // Self-reported, shown to the approver so they can recognize this request
    // and refuse one they didn't initiate.
    const requesterLabel = `${os.hostname()} (${process.platform}, ${os.userInfo().username})`;
    let startResponse;
    try {
        startResponse = await fetch(`${base}/api/cli/auth/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requesterLabel }),
        });
    }
    catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
        throw new Error(`Cannot reach the hosted deployment at ${base}${cause}. Check the --via URL and network access.`);
    }
    if (!startResponse.ok) {
        throw new Error(`Could not start pairing with ${base} (${startResponse.status}). Is this a FullStackGTM deployment?`);
    }
    const start = await startResponse.json();
    // Only auto-open a verification URL that belongs to the --via origin the user
    // typed — a malicious/typo'd deployment cannot redirect the browser elsewhere.
    let sameOrigin = false;
    try {
        sameOrigin = new URL(start.verificationUrl).origin === viaUrl.origin;
    }
    catch {
        sameOrigin = false;
    }
    console.error(`\nPairing code: ${start.userCode}\n\nApprove this CLI ("${requesterLabel}") in your dashboard:\n\n  ${start.verificationUrl}\n`);
    if (sameOrigin) {
        void openInBrowser(start.verificationUrl);
    }
    else {
        console.error(`(Not auto-opening: the verification URL is not on ${viaUrl.origin}. Open it manually only if you trust it.)`);
    }
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
export async function login(args) {
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
    if (provider === "anthropic" || provider === "openai") {
        rejectArgvSecret(args, "--token", "--key", "--api-key");
        const key = await readSecret(`${provider} API key (${provider === "anthropic" ? "sk-ant-..." : "sk-..."})`);
        if (!key)
            throw new Error(`No ${provider} key provided.`);
        if (!args.includes("--no-validate")) {
            const validation = await validateLlmKey(provider, key);
            if (!validation.ok)
                throw new Error(`${provider} rejected the key: ${validation.detail}`);
            console.log(validation.detail);
        }
        const stamp = new Date().toISOString();
        storeCredential(provider, { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
        console.log(`Stored ${provider} API key in ${credentialsPath()}. \`fullstackgtm call parse\` and \`call score\` use it automatically.`);
        return;
    }
    if (provider === "apollo") {
        rejectArgvSecret(args, "--token", "--key", "--api-key");
        const key = await readSecret("Apollo API key");
        if (!key)
            throw new Error("No Apollo key provided.");
        if (!args.includes("--no-validate")) {
            const response = await fetch("https://api.apollo.io/api/v1/auth/health", {
                headers: { "X-Api-Key": key, Accept: "application/json" },
            });
            if (!response.ok) {
                throw new Error(`Apollo rejected the key: ${safeStatus(response)}`);
            }
            console.log("Key accepted by the Apollo API.");
        }
        const stamp = new Date().toISOString();
        storeCredential("apollo", { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
        console.log(`Stored Apollo API key in ${credentialsPath()}. \`fullstackgtm enrich append|refresh\` use it automatically.`);
        return;
    }
    if (provider === "pipe0" || provider === "explorium" || provider === "heyreach" || provider === "theirstack") {
        rejectArgvSecret(args, "--token", "--key", "--api-key");
        const key = await readSecret(`${provider} API key`);
        if (!key)
            throw new Error(`No ${provider} key provided.`);
        // No free auth-health endpoint; validating would spend credits, so the key
        // is stored as-is and validated on the first pull.
        const stamp = new Date().toISOString();
        storeCredential(provider, { kind: "api_key", accessToken: key, createdAt: stamp, updatedAt: stamp });
        const usedBy = provider === "theirstack" ? "`fullstackgtm tam estimate --source theirstack`" : "`fullstackgtm enrich acquire`";
        console.log(`Stored ${provider} API key in ${credentialsPath()}. ${usedBy} uses it automatically (validated on first pull).`);
        return;
    }
    if (provider !== "hubspot") {
        throw new Error("login supports: hubspot, salesforce, stripe, anthropic, openai, apollo, pipe0, explorium, or --via <hosted url>. Usage: fullstackgtm login <provider> | fullstackgtm login --via https://gtm.example.com");
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
export function logout(args) {
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
    const llm = resolveLlmCredential(env);
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
        profile: activeProfile(),
        credentialStore: { path: storePath, exists: existsSync(storePath) },
        config: { path: configPath, exists: existsSync(configPath) },
        providers,
        broker: broker ? { paired: true, baseUrl: broker.baseUrl ?? "unknown" } : { paired: false },
        llm: llm
            ? { configured: true, provider: llm.provider, source: llm.source }
            : { configured: false, detail: "call parse/score will prompt once, or set ANTHROPIC_API_KEY / OPENAI_API_KEY" },
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
/**
 * The workspace slice of doctor: current health + plans awaiting approval.
 * Folded into doctor (rather than adding a separate triage verb) so a single
 * call returns environment + workspace state + copy-pasteable next commands —
 * previously an agent needed three round-trips (doctor, health, plans list)
 * to orient itself.
 */
export async function workspaceDoctor() {
    const profile = activeWorkspaceProfile();
    const rollup = summarizeHealth(readHealthTimeline(), profile);
    let pending = [];
    try {
        pending = await createFilePlanStore().list("needs_approval");
    }
    catch {
        // A malformed plans dir must not take doctor down — doctor is the verb
        // that diagnoses broken installs. The plans slice just comes back empty.
    }
    return {
        profile,
        healthScore: rollup?.current.score ?? null,
        scoreDelta: rollup?.scoreDelta ?? null,
        lastAuditAt: rollup?.latest ?? null,
        auditCount: rollup?.auditCount ?? 0,
        pendingPlans: pending
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.plan.id.localeCompare(b.plan.id))
            .slice(0, 10)
            .map((stored) => ({
            id: stored.plan.id,
            summary: stored.plan.summary,
            operations: stored.plan.operations.length,
            approved: stored.approvedOperationIds.length,
        })),
    };
}
/**
 * State-aware next steps: a plan awaiting approval outranks the generic
 * "run an audit" advice — the exact show → approve → apply chain, ready to
 * paste, with the connected provider filled in when there is one.
 */
/**
 * Rich-only sparkline of the profile's score history, e.g. "  ▂▄▅▇". Empty
 * string in plain mode or with fewer than two readings, so the plain doctor
 * line is byte-identical to the pre-TUI CLI.
 */
function healthSparkline(profile, rich) {
    if (!rich)
        return "";
    const history = summarizeHealth(readHealthTimeline(), profile)?.history ?? [];
    if (history.length < 2)
        return "";
    return `  ${sparkline(history.map((point) => point.score))}`;
}
function nextStepsWithWorkspace(report, workspace) {
    if (workspace.pendingPlans.length === 0)
        return report.nextSteps;
    const [first] = workspace.pendingPlans;
    const connected = Object.entries(report.providers).find(([, status]) => status.source !== "none");
    const providerHint = connected ? connected[0] : "<hubspot|salesforce|stripe>";
    return [
        `fullstackgtm plans show ${first.id}`,
        `fullstackgtm plans approve ${first.id} --operations <ids|all>`,
        `fullstackgtm apply --plan-id ${first.id} --provider ${providerHint}`,
    ];
}
export async function doctorCommand(args) {
    const report = doctorReport();
    const workspace = await workspaceDoctor();
    const nextSteps = nextStepsWithWorkspace(report, workspace);
    if (args.includes("--json")) {
        console.log(JSON.stringify({ ...report, workspace, nextSteps }, null, 2));
        return;
    }
    // Styling contract: with color off (piped/NO_COLOR/CI) every painter is the
    // identity function and the rich-only extras are skipped, so the plain
    // output stays byte-identical to the unstyled CLI.
    const p = paint(colorEnabled(process.stdout));
    const mark = (ok) => (ok ? p.green("ok") : p.red("MISSING"));
    const delta = workspace.scoreDelta === null
        ? ""
        : ` (Δ ${workspace.scoreDelta >= 0
            ? p.green(`+${workspace.scoreDelta}`)
            : p.red(`${workspace.scoreDelta}`)})`;
    const healthLine = workspace.auditCount === 0
        ? p.dim("no saved audits yet (fullstackgtm audit --provider <name> --save starts the timeline)")
        : `${scoreColor(workspace.healthScore ?? 0, p)}/100${delta} — ${workspace.auditCount} audit(s) saved, last ${workspace.lastAuditAt}${healthSparkline(workspace.profile, p.enabled)}`;
    const lines = [
        `Package:    ${p.bold(`${report.package.name} ${report.package.version}`)}`,
        `Node:       v${report.node.version} (${report.node.required} required) ${mark(report.node.ok)}`,
        `Profile:    ${report.profile}${report.profile === DEFAULT_PROFILE ? "" : " (named profile — credentials and plans are scoped to it)"}`,
        `Cred store: ${report.credentialStore.path} (${report.credentialStore.exists ? "present" : "not created yet — created on first login"})`,
        `Config:     ${report.config.exists ? report.config.path : "none — defaults apply"}`,
        "",
        "Providers:",
        ...Object.entries(report.providers).map(([provider, status]) => `  ${provider.padEnd(11)} ${status.source === "none" ? p.dim(`not connected (${status.detail})`) : `${p.green(status.source)}: ${status.detail}`}`),
        `  ${"broker".padEnd(11)} ${report.broker.paired ? `${p.green("paired")} with ${report.broker.baseUrl}` : p.dim("not paired (fullstackgtm login --via <hosted url>)")}`,
        `  ${"llm".padEnd(11)} ${report.llm.configured ? `${p.green(`${report.llm.provider}`)} key (${report.llm.source}) — call parse/score ready` : p.dim(`not configured (${report.llm.detail})`)}`,
        "",
        report.mcp.peersInstalled
            ? `MCP:        ${p.green("peers installed")} — \`fullstackgtm-mcp\` is ready`
            : `MCP:        ${p.yellow("optional peers missing")} (${report.mcp.missing.join(", ")}) — needed only for \`fullstackgtm-mcp\``,
        "",
        "Workspace:",
        `  ${"health".padEnd(11)} ${healthLine}`,
        `  ${"plans".padEnd(11)} ${workspace.pendingPlans.length === 0
            ? "none awaiting approval"
            : `${p.yellow(`${workspace.pendingPlans.length} awaiting approval`)}: ${workspace.pendingPlans.map((plan) => plan.id).join(", ")}`}`,
        "",
        ...(p.enabled
            ? box(nextSteps, p, "Next step")
            : ["Next step:", ...nextSteps.map((step) => `  ${step}`)]),
    ];
    console.log(lines.join("\n"));
    if (!report.node.ok)
        process.exitCode = 1;
}

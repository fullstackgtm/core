// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { credentialsPath, getCredential, resolveHubspotConnection, resolveSalesforceConnection, storeCredential } from "../credentials.js";
import { builtinAuditRules } from "../rules.js";
import { detectProviderFromKey, resolveLlmCredential, validateLlmKey } from "../llm.js";
import { parseIcp } from "../icp.js";
import { nearest } from "./suggest.js";
import { composeListeners, createProgressEmitter, SNAPSHOT_PULL_STAGES, STRIPE_SNAPSHOT_STAGES, } from "../progress.js";
import { progressReporter } from "../runReport.js";
import { createProgressRenderer } from "./ui.js";
export function option(args, name) {
    const index = args.indexOf(name);
    if (index === -1)
        return null;
    return args[index + 1] ?? null;
}
export function repeatedOption(args, name) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === name && args[index + 1] !== undefined) {
            values.push(args[index + 1]);
        }
    }
    return values;
}
/**
 * Additive alias: `--dry-run` asserts the preview default. Every verb that
 * honors it is already preview-by-default (plans are dry-run; nothing writes
 * to a CRM without approve → apply) — the flag additionally suppresses
 * `--save` (and the `fix --yes` write stage) so the invocation can never
 * persist a plan/run record or reach a write. Omitting it changes nothing:
 * defaults stay exactly as before.
 */
export function dryRunRequested(args) {
    return args.includes("--dry-run");
}
let dryRunOverridesSaveNoted = false;
/** `--save`, unless `--dry-run` locks the preview default (see dryRunRequested). */
export function saveRequested(args) {
    const save = args.includes("--save");
    if (save && dryRunRequested(args)) {
        if (!dryRunOverridesSaveNoted) {
            console.error("(--dry-run overrides --save: preview only, nothing persisted)");
            dryRunOverridesSaveNoted = true;
        }
        return false;
    }
    return save;
}
/**
 * Additive alias: `--confirm` is accepted wherever an ad-hoc confirmation
 * flag already gates a write stage (e.g. `fix --yes`). The old flags keep
 * working; `--dry-run` wins over both.
 */
export function confirmRequested(args, ...legacyAliases) {
    if (dryRunRequested(args))
        return false;
    return ["--confirm", ...legacyAliases].some((flag) => args.includes(flag));
}
export function numericOption(args, name) {
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
    throw new Error("No HubSpot credentials. Run `fullstackgtm login hubspot`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set HUBSPOT_ACCESS_TOKEN. (`fullstackgtm doctor` shows credential status; see the README's \"Connect your CRM\" section for the private-app scopes to grant.)");
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
    throw new Error("No Salesforce credentials. Run `fullstackgtm login salesforce`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL. (`fullstackgtm doctor` shows credential status; device-flow login needs an admin-created Connected App — see the README's \"Connect your CRM\" section.)");
}
export async function connectorFor(provider, args, progress) {
    // Connector modules are the two largest files in dist (~100KB together) and
    // load lazily here: only live `--provider` runs pay for them, not --demo/
    // --sample/--input runs or the always-eager help/version paths.
    if (provider === "hubspot") {
        const connection = await hubspotConnection(args);
        const { createHubspotConnector } = await import("../connectors/hubspot.js");
        return createHubspotConnector({
            getAccessToken: () => connection.accessToken,
            fieldMappings: connection.fieldMappings ?? undefined,
            // Point at a mock/proxy HubSpot (tests, evals, request-recording).
            apiBaseUrl: process.env.HUBSPOT_API_BASE_URL,
            progress,
        });
    }
    if (provider === "salesforce") {
        const connection = await salesforceConnection();
        const { createSalesforceConnector } = await import("../connectors/salesforce.js");
        return createSalesforceConnector({
            getConnection: () => connection,
            fieldMappings: connection.fieldMappings ?? undefined,
            progress,
        });
    }
    if (provider === "stripe") {
        const key = process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
        if (!key) {
            throw new Error("No Stripe credentials. Run `echo \"$STRIPE_KEY\" | fullstackgtm login stripe` or set STRIPE_SECRET_KEY. A restricted key with read access to Customers and Subscriptions is enough. (`fullstackgtm doctor` shows credential status.)");
        }
        const { createStripeConnector } = await import("../connectors/stripe.js");
        return createStripeConnector({ getApiKey: () => key, progress });
    }
    const providerSuggestion = nearest(provider.toLowerCase(), ["hubspot", "salesforce", "stripe"], 3);
    throw new Error(`Unknown provider: ${provider}.${providerSuggestion ? ` Did you mean ${providerSuggestion}?` : ""} ` +
        "Supported providers: hubspot, salesforce, stripe");
}
export async function readSnapshot(args, progress) {
    const provider = option(args, "--provider");
    if (provider) {
        // A verb driving its own progress board (e.g. `backfill stripe`) passes
        // its emitter through; the pull's stage/items events flow into it and no
        // second board is painted.
        if (progress) {
            const connector = await connectorFor(provider, args, progress);
            return connector.fetchSnapshot();
        }
        // Live pulls can page for minutes with nothing on screen. On an
        // interactive terminal, a stderr checklist ticks through the pull stages
        // with running tallies; piped/CI/agent runs render nothing (zero bytes
        // written). Either way the emitter feeds the broker heartbeat when the
        // CLI is paired, so long pulls tick live on the hosted dashboard too.
        const renderer = createProgressRenderer(provider === "stripe" ? STRIPE_SNAPSHOT_STAGES : SNAPSHOT_PULL_STAGES);
        const emitter = createProgressEmitter(composeListeners(renderer.listener, progressReporter()));
        const connector = await connectorFor(provider, args, emitter);
        try {
            return await connector.fetchSnapshot();
        }
        finally {
            renderer.done();
        }
    }
    if (args.includes("--demo")) {
        const { generateDemoSnapshot } = await import("../demo.js");
        return generateDemoSnapshot({
            seed: numericOption(args, "--seed"),
            today: option(args, "--today") ?? undefined,
        });
    }
    if (args.includes("--sample"))
        return (await import("../sampleData.js")).sampleSnapshot;
    const input = option(args, "--input");
    if (!input) {
        throw new Error("No data source. Pass one of: --provider <hubspot|salesforce|stripe> (live, read-only), " +
            "--input <snapshot.json> (a saved snapshot), --demo (a generated messy CRM), or " +
            "--sample (the tiny built-in fixture). Refusing to silently audit sample data.");
    }
    const path = resolve(process.cwd(), input);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`--input ${input} could not be read as JSON: ${reason}`);
    }
    return assertCanonicalSnapshot(parsed, input);
}
/**
 * Validate that an --input file actually has the canonical snapshot shape
 * (the JSON `snapshot --out` writes) instead of blindly casting — a plan or
 * arbitrary JSON passed here used to surface as a confusing crash deep in a
 * rule, or worse, an empty "clean" audit.
 */
export function assertCanonicalSnapshot(parsed, source) {
    const expected = "expected the shape written by `fullstackgtm snapshot --out <path>`: " +
        "{ generatedAt, provider, users[], accounts[], contacts[], deals[], activities[] }";
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`--input ${source} is not a canonical GTM snapshot (top level is not an object); ${expected}.`);
    }
    const record = parsed;
    const arrayFields = ["users", "accounts", "contacts", "deals", "activities"];
    const problems = arrayFields
        .filter((field) => !Array.isArray(record[field]))
        .map((field) => (record[field] === undefined ? `missing "${field}"` : `"${field}" is not an array`));
    if (problems.length > 0) {
        throw new Error(`--input ${source} is not a canonical GTM snapshot (${problems.join(", ")}); ${expected}.`);
    }
    return parsed;
}
export function selectedRules(args, baseRules = builtinAuditRules) {
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
/**
 * First-touch key onboarding: env vars win, then the credential store; on a
 * TTY a missing key is captured once (validated, stored 0600 like provider
 * logins). Non-interactive contexts get an actionable error instead.
 */
export async function requireLlmCredential(command = "parse") {
    // Base-URL overrides are resolved here (not inside forcedToolCall) so the LLM
    // seam stays pure/injectable. Spread into LlmCallOptions at every call site
    // via `...credential`; unset env leaves the upstream defaults untouched.
    const baseUrls = resolveLlmBaseUrls();
    const resolved = resolveLlmCredential();
    if (resolved)
        return { ...resolved, ...baseUrls };
    // Scoring is inherently LLM work — there is no keyword fallback to suggest.
    const fallbackHint = command === "parse"
        ? ", or pass --deterministic for the free keyword baseline"
        : command === "score"
            ? " (call score has no non-LLM mode)"
            : ", or classify by hand: `market worksheet --vendor <id>` then `market observe --from`";
    const work = command === "score" ? "scoring" : command === "parse" ? "extraction" : "classification";
    if (!process.stdin.isTTY) {
        throw new Error(`LLM ${work} needs an API key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run \`echo "$KEY" | fullstackgtm login anthropic\` (or \`login openai\`) once${fallbackHint}.`);
    }
    console.error("LLM parsing needs an API key (Anthropic or OpenAI) — yours, used directly with the provider.");
    console.error(`Paste it once; it is validated and stored at ${credentialsPath()} (file mode 0600), like CRM logins.`);
    console.error("(Alternatives: set ANTHROPIC_API_KEY / OPENAI_API_KEY, or pass --deterministic for the free keyword baseline.)\n");
    const apiKey = await readSecret("API key (sk-ant-... or sk-...): ");
    const provider = detectProviderFromKey(apiKey);
    const validation = await validateLlmKey(provider, apiKey);
    if (!validation.ok)
        throw new Error(`${provider} rejected the key: ${validation.detail}`);
    const now = new Date().toISOString();
    storeCredential(provider, { kind: "api_key", accessToken: apiKey, createdAt: now, updatedAt: now });
    console.error(`Stored ${provider} key (${validation.detail}). Future runs use it automatically; remove with \`fullstackgtm logout ${provider}\`.\n`);
    return { provider, apiKey, ...baseUrls };
}
/**
 * Read optional LLM base-URL overrides from env so the package can run against
 * an Anthropic/OpenAI-compatible gateway (GLM-5.2, z.ai, Ollama) without code
 * changes. Returns only the keys that are set; an empty object when neither is,
 * so spreading into LlmCallOptions is a no-op by default.
 */
export function resolveLlmBaseUrls(env = process.env) {
    const out = {};
    if (env.ANTHROPIC_API_BASE_URL)
        out.anthropicBaseUrl = env.ANTHROPIC_API_BASE_URL;
    if (env.OPENAI_API_BASE_URL)
        out.openaiBaseUrl = env.OPENAI_API_BASE_URL;
    return out;
}
/** Load the active ICP: --icp <path>, else ./icp.json. Undefined if none. */
export function loadIcp(args) {
    const explicit = option(args, "--icp");
    const path = resolve(process.cwd(), explicit ?? "icp.json");
    if (!existsSync(path)) {
        if (explicit)
            throw new Error(`--icp ${explicit}: file not found`);
        return undefined;
    }
    return parseIcp(readFileSync(path, "utf8"));
}
/**
 * Read a secret without exposing it on the command line. Secrets passed as
 * argv leak through the process list (`ps`), `/proc`, and shell history, so
 * the CLI never accepts them as flags. Instead:
 *   - non-interactive: pipe it on stdin (docker `--password-stdin` style),
 *     e.g. `echo "$TOKEN" | fullstackgtm login hubspot`
 *   - interactive: prompted on the TTY with the input muted
 */
export async function readSecret(label) {
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
export function isOptionValue(args, arg) {
    const index = args.indexOf(arg);
    return index > 0 && args[index - 1].startsWith("--");
}
export function readPackageInfo() {
    try {
        // This file lives one level deeper than the old src/cli.ts, so the hop to
        // the package root is ../.. (was ..). Same target file as before the split.
        const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
        const parsed = JSON.parse(raw);
        return { name: parsed.name ?? "fullstackgtm", version: parsed.version ?? "unknown" };
    }
    catch {
        return { name: "fullstackgtm", version: "unknown" };
    }
}

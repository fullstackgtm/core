var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
/**
 * The MCP peers resolve normally when installed alongside this package, but
 * `npx -p fullstackgtm -p @modelcontextprotocol/sdk -p zod` skips installing
 * peers into the npx cache when the invoking project's node_modules already
 * satisfies them — and the cache can't reach the project's tree. Fall back to
 * resolving from the working directory: peer dependencies' natural home.
 */
async function importPeer(specifier) {
    try {
        return (await import(__rewriteRelativeImportExtension(specifier)));
    }
    catch (error) {
        try {
            const projectRequire = createRequire(join(process.cwd(), "package.json"));
            return (await import(__rewriteRelativeImportExtension(pathToFileURL(projectRequire.resolve(specifier)).href)));
        }
        catch {
            throw error; // the original error carries the missing-peer signal mcp-bin reports on
        }
    }
}
const { McpServer } = await importPeer("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await importPeer("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await importPeer("zod/v4");
import { auditSnapshot, defaultPolicy } from "./audit.js";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.js";
import { applyPatchPlan } from "./connector.js";
import { createHubspotConnector } from "./connectors/hubspot.js";
import { createSalesforceConnector } from "./connectors/salesforce.js";
import { createStripeConnector } from "./connectors/stripe.js";
import { getCredential, resolveHubspotAccessToken, resolveSalesforceConnection, } from "./credentials.js";
import { generateDemoSnapshot } from "./demo.js";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.js";
import { builtinAuditRules } from "./rules.js";
import { sampleSnapshot } from "./sampleData.js";
import { normalizeTranscript, parseCall } from "./calls.js";
import { extractInsightsLlm, resolveLlmCredential } from "./llm.js";
import { suggestValues } from "./suggest.js";
function content(value) {
    return {
        content: [
            {
                type: "text",
                text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
            },
        ],
    };
}
async function connectorFor(provider) {
    if (provider === "hubspot") {
        const token = process.env.HUBSPOT_ACCESS_TOKEN ?? (await resolveHubspotAccessToken());
        if (!token) {
            throw new Error("No HubSpot credentials. Run `fullstackgtm login hubspot` or set HUBSPOT_ACCESS_TOKEN in the MCP server environment.");
        }
        return createHubspotConnector({
            getAccessToken: () => token,
            apiBaseUrl: process.env.HUBSPOT_API_BASE_URL,
        });
    }
    if (provider === "salesforce") {
        const connection = process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL
            ? {
                accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
                instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
            }
            : await resolveSalesforceConnection();
        if (!connection) {
            throw new Error("No Salesforce credentials. Run `fullstackgtm login salesforce` or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL in the MCP server environment.");
        }
        return createSalesforceConnector({
            getConnection: () => connection,
            fieldMappings: connection.fieldMappings ?? undefined,
        });
    }
    if (provider === "stripe") {
        const key = process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
        if (!key) {
            throw new Error("No Stripe credentials. Run `fullstackgtm login stripe` or set STRIPE_SECRET_KEY in the MCP server environment.");
        }
        return createStripeConnector({ getApiKey: () => key });
    }
    throw new Error(`Unknown provider: ${provider}. Supported providers: hubspot, salesforce, stripe`);
}
async function readSnapshot(provider, inputPath) {
    if (provider === "demo")
        return generateDemoSnapshot();
    if (provider && provider !== "sample") {
        const connector = await connectorFor(provider);
        return connector.fetchSnapshot();
    }
    if (!inputPath)
        return sampleSnapshot;
    return JSON.parse(readFileSync(resolve(process.cwd(), inputPath), "utf8"));
}
function packageVersion() {
    try {
        const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        return JSON.parse(raw).version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
export async function startMcpServer() {
    const server = new McpServer({
        name: "fullstackgtm",
        version: packageVersion(),
    });
    server.registerTool("fullstackgtm_audit", {
        title: "GTM Ops Audit",
        description: "Run a dry-run GTM hygiene audit and return a reviewable patch plan. " +
            "Sources: the realistic zero-credential demo CRM (provider: \"demo\" — richest test data), " +
            "the minimal sample dataset, a snapshot file, or a live provider.",
        inputSchema: {
            provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
            inputPath: z.string().optional(),
            configPath: z.string().optional(),
            rules: z.array(z.string()).optional(),
            output: z.enum(["json", "markdown"]).optional(),
            today: z.string().optional(),
            staleDealDays: z.number().int().positive().optional(),
        },
    }, async ({ provider, inputPath, configPath, rules, output, today, staleDealDays }) => {
        const loaded = configPath ? loadConfig(configPath) : null;
        const policy = mergePolicy(defaultPolicy(today), loaded?.config);
        if (today)
            policy.today = today;
        if (staleDealDays !== undefined)
            policy.staleDealDays = staleDealDays;
        const ruleSet = await resolveConfiguredRules(loaded);
        const selected = rules?.length
            ? ruleSet.filter((rule) => rules.includes(rule.id))
            : ruleSet;
        const plan = auditSnapshot(await readSnapshot(provider, inputPath), policy, selected);
        return content(output === "markdown" ? patchPlanToMarkdown(plan) : plan);
    });
    server.registerTool("fullstackgtm_suggest", {
        title: "Suggest Placeholder Values",
        description: "Derive values for a plan's requires_human_* placeholder operations from snapshot " +
            "evidence (account-name matching, contact associations), with confidence levels and " +
            "reasons. Read-only; feed accepted values into fullstackgtm_apply's valueOverrides.",
        inputSchema: {
            planPath: z.string(),
            provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
            inputPath: z.string().optional(),
        },
    }, async ({ planPath, provider, inputPath }) => {
        const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
        const snapshot = await readSnapshot(provider, inputPath);
        return content({ suggestions: suggestValues(plan, snapshot) });
    });
    server.registerTool("fullstackgtm_call_parse", {
        title: "Parse Call Transcript",
        description: "Parse a call transcript (Speaker:/[Speaker]: lines or Granola utterance JSON) into " +
            "canonical segments, insights, and GtmEvidence records. extractor: 'auto' (default) " +
            "uses LLM extraction when an Anthropic/OpenAI key is configured in the server " +
            "environment or credential store, else the free deterministic keyword baseline; " +
            "'llm' and 'deterministic' force either. Read-only; every insight is provenance-marked.",
        inputSchema: {
            transcript: z.string().optional(),
            transcriptPath: z.string().optional(),
            title: z.string().optional(),
            source: z.enum(["gong", "chorus", "fathom", "manual", "csv", "unknown"]).optional(),
            extractor: z.enum(["auto", "llm", "deterministic"]).optional(),
            model: z.string().optional(),
        },
    }, async ({ transcript, transcriptPath, title, source, extractor, model }) => {
        const raw = transcript ??
            (transcriptPath ? readFileSync(resolve(process.cwd(), transcriptPath), "utf8") : null);
        if (!raw)
            throw new Error("Provide transcript (text) or transcriptPath (file).");
        const mode = extractor ?? "auto";
        const credential = mode === "deterministic" ? null : resolveLlmCredential();
        if (mode === "llm" && !credential) {
            throw new Error("extractor 'llm' needs an API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the MCP server environment, or store one with `fullstackgtm login anthropic|openai`.");
        }
        if (credential) {
            const normalized = normalizeTranscript(raw);
            const { insights, model: used } = await extractInsightsLlm(normalized, {
                ...credential,
                model,
                title,
            });
            return content(parseCall(raw, { title, sourceSystem: source, insights, extractor: `llm:${credential.provider}:${used}` }));
        }
        return content(parseCall(raw, { title, sourceSystem: source }));
    });
    server.registerTool("fullstackgtm_rules", {
        title: "List Audit Rules",
        description: "List the built-in deterministic audit rules with ids and descriptions.",
        inputSchema: {},
    }, async () => {
        return content(builtinAuditRules.map(({ id, title, description }) => ({ id, title, description })));
    });
    server.registerTool("fullstackgtm_apply", {
        title: "Apply Approved Patch Operations",
        description: "Apply explicitly approved operations from a patch plan through a provider " +
            "connector. Operations not listed in approvedOperationIds are never written, " +
            "and requires_human_* placeholders need a value override.",
        inputSchema: {
            provider: z.enum(["hubspot", "salesforce"]),
            planPath: z.string(),
            approvedOperationIds: z.array(z.string()).min(1),
            valueOverrides: z.record(z.string(), z.string()).optional(),
            output: z.enum(["json", "markdown"]).optional(),
        },
    }, async ({ provider, planPath, approvedOperationIds, valueOverrides, output }) => {
        const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
        const run = await applyPatchPlan(await connectorFor(provider), plan, {
            approvedOperationIds,
            valueOverrides,
        });
        return content(output === "markdown" ? formatPatchPlanRun(run) : run);
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

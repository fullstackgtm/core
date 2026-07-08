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
            // Last-resort fallback to the invoking project's node_modules (the npx
            // landmine: peers there, fullstackgtm in the npx cache). This loads code
            // from the current working directory, so make it VISIBLE — running the
            // MCP server in an untrusted directory could otherwise silently load a
            // malicious `zod`/SDK from its node_modules.
            const projectRequire = createRequire(join(process.cwd(), "package.json"));
            const resolved = projectRequire.resolve(specifier);
            console.error(`fullstackgtm-mcp: loading peer "${specifier}" from the current directory (${resolved}). Only run the MCP server in a directory you trust.`);
            return (await import(__rewriteRelativeImportExtension(pathToFileURL(resolved).href)));
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
import { assertCanonicalSnapshot } from "./cli/shared.js";
import { nearest } from "./cli/suggest.js";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.js";
import { applyPatchPlan } from "./connector.js";
import { createHubspotConnector } from "./connectors/hubspot.js";
import { createSalesforceConnector } from "./connectors/salesforce.js";
import { createStripeConnector } from "./connectors/stripe.js";
import { getCredential, resolveHubspotAccessToken, resolveSalesforceConnection, } from "./credentials.js";
import { generateDemoSnapshot } from "./demo.js";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.js";
import { verifyApprovalDigests } from "./integrity.js";
import { createFilePlanStore } from "./planStore.js";
import { builtinAuditRules } from "./rules.js";
import { sampleSnapshot } from "./sampleData.js";
import { normalizeTranscript, parseCall } from "./calls.js";
import { extractInsightsLlm, resolveLlmCredential } from "./llm.js";
import { computeFrontStates, createFileObservationStore, loadCaptureTexts, loadMarketConfig, validateObservationSet, verifyEvidenceSpans, } from "./market.js";
import { buildWorksheet } from "./marketClassify.js";
import { resolveRecord } from "./resolve.js";
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
    const providerSuggestion = nearest(provider.toLowerCase(), ["hubspot", "salesforce", "stripe"], 3);
    throw new Error(`Unknown provider: ${provider}.${providerSuggestion ? ` Did you mean ${providerSuggestion}?` : ""} ` +
        "Supported providers: hubspot, salesforce, stripe");
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
    return assertCanonicalSnapshot(JSON.parse(readFileSync(resolve(process.cwd(), inputPath), "utf8")), inputPath);
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
function strictSchema(shape) {
    return z.object(shape).strict();
}
// Single registration table. startMcpServer() registers exactly this list,
// and fullstackgtm_capabilities reports its names from the same array — the
// advertised inventory cannot drift from what is actually registered.
// (A hand-written parallel tool list was a core defect of the first pass at
// a capabilities tool, which reported 4 of the 8 registered tools.)
const toolDefinitions = [
    {
        name: "fullstackgtm_audit",
        writesCrm: false,
        config: {
            title: "GTM Ops Audit",
            description: "Run a dry-run GTM hygiene audit and return a reviewable patch plan. " +
                "Sources: the realistic zero-credential demo CRM (provider: \"demo\" — richest test data), " +
                "the minimal sample dataset, a snapshot file, or a live provider.",
            inputSchema: strictSchema({
                provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
                inputPath: z.string().optional(),
                configPath: z.string().optional(),
                rules: z.array(z.string()).optional(),
                output: z.enum(["json", "markdown"]).optional(),
                today: z.string().optional(),
                staleDealDays: z.number().int().positive().optional(),
            }),
        },
        handler: async ({ provider, inputPath, configPath, rules, output, today, staleDealDays }) => {
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
        },
    },
    {
        name: "fullstackgtm_suggest",
        writesCrm: false,
        config: {
            title: "Suggest Placeholder Values",
            description: "Derive values for a plan's requires_human_* placeholder operations from snapshot " +
                "evidence (account-name matching, contact associations), with confidence levels and " +
                "reasons. Read-only; feed accepted values into fullstackgtm_apply's valueOverrides.",
            inputSchema: strictSchema({
                planPath: z.string(),
                provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
                inputPath: z.string().optional(),
            }),
        },
        handler: async ({ planPath, provider, inputPath }) => {
            const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
            const snapshot = await readSnapshot(provider, inputPath);
            return content({ suggestions: suggestValues(plan, snapshot) });
        },
    },
    {
        name: "fullstackgtm_call_parse",
        writesCrm: false,
        config: {
            title: "Parse Call Transcript",
            description: "Parse a call transcript (Speaker:/[Speaker]: lines or Granola utterance JSON) into " +
                "canonical segments, insights, and GtmEvidence records. extractor: 'auto' (default) " +
                "uses LLM extraction when an Anthropic/OpenAI key is configured in the server " +
                "environment or credential store, else the free deterministic keyword baseline; " +
                "'llm' and 'deterministic' force either. Read-only; every insight is provenance-marked.",
            inputSchema: strictSchema({
                transcript: z.string().optional(),
                transcriptPath: z.string().optional(),
                title: z.string().optional(),
                source: z.enum(["gong", "chorus", "fathom", "manual", "csv", "unknown"]).optional(),
                extractor: z.enum(["auto", "llm", "deterministic"]).optional(),
                model: z.string().optional(),
            }),
        },
        handler: async ({ transcript, transcriptPath, title, source, extractor, model }) => {
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
        },
    },
    {
        name: "fullstackgtm_resolve",
        writesCrm: false,
        config: {
            title: "Resolve Record (create gate)",
            description: "Before creating a CRM record, check whether it already exists. Returns a verdict " +
                "(exists | ambiguous | safe_to_create) with matches and a reason, using the same " +
                "identity keys as the audit/merge engines (account domain, contact email, open-deal " +
                "key). Read-only. Never create on 'exists' or 'ambiguous'.",
            inputSchema: strictSchema({
                objectType: z.enum(["account", "contact", "deal"]),
                name: z.string().optional(),
                domain: z.string().optional(),
                email: z.string().optional(),
                accountId: z.string().optional(),
                provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
                inputPath: z.string().optional(),
            }),
        },
        handler: async ({ objectType, name, domain, email, accountId, provider, inputPath }) => {
            const snapshot = await readSnapshot(provider, inputPath);
            return content(resolveRecord(snapshot, { objectType, name, domain, email, accountId }));
        },
    },
    {
        name: "fullstackgtm_rules",
        writesCrm: false,
        config: {
            title: "List Audit Rules",
            description: "List the built-in deterministic audit rules with ids and descriptions.",
            inputSchema: strictSchema({}),
        },
        handler: async () => {
            return content(builtinAuditRules.map(({ id, title, description }) => ({ id, title, description })));
        },
    },
    {
        name: "fullstackgtm_apply",
        writesCrm: true,
        config: {
            title: "Apply Approved Patch Operations",
            description: "Apply explicitly approved operations from a patch plan through a provider " +
                "connector. Operations not listed in approvedOperationIds are never written, " +
                "and requires_human_* placeholders need a value override. When the plan is in " +
                "the local plan store (saved via `audit --save`), approvals are verified against " +
                "the store's HMAC approval digests — ids not approved with `plans approve` are " +
                "refused — and the run is recorded onto the stored plan so `plans show` and " +
                "`audit-log export` include it.",
            inputSchema: strictSchema({
                provider: z.enum(["hubspot", "salesforce"]),
                planPath: z.string(),
                approvedOperationIds: z.array(z.string()).min(1),
                valueOverrides: z.record(z.string(), z.string()).optional(),
                output: z.enum(["json", "markdown"]).optional(),
            }),
        },
        handler: async ({ provider, planPath, approvedOperationIds, valueOverrides, output }) => {
            // The file may be a raw PatchPlan (audit --out) or a StoredPlan envelope
            // (a file straight out of the plan-store directory).
            const parsed = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
            const filePlan = isStoredPlanFile(parsed) ? parsed.plan : parsed;
            if (!filePlan || !Array.isArray(filePlan.operations)) {
                throw new Error(`${planPath} is not a patch plan (expected { id, operations: [...] }).`);
            }
            // Governance parity with CLI apply: when this plan id exists in the local
            // plan store, the STORE is the source of truth — the approved-id set must
            // come from `plans approve` (which HMAC-signed each approved op), the
            // signatures are re-verified here, and the run is recorded back onto the
            // plan so audit-log export sees MCP applies exactly like CLI applies.
            const store = createFilePlanStore();
            const stored = typeof filePlan.id === "string" && /^[\w.-]+$/.test(filePlan.id)
                ? await store.get(filePlan.id)
                : null;
            let plan;
            let effectiveOverrides;
            if (stored) {
                if (stored.status !== "approved") {
                    throw new Error(`Plan ${filePlan.id} is ${stored.status}; approve operations first with ` +
                        `\`fullstackgtm plans approve ${filePlan.id} --operations <ids|all>\`.`);
                }
                // Downgrade guard (same as CLI apply): an approved plan with no
                // signatures either predates 0.26 or had approvalDigests stripped to
                // skip the integrity check. Refuse rather than trust the file.
                if (stored.approvedOperationIds.length > 0 && !stored.approvalDigests) {
                    throw new Error(`Refusing to apply plan ${filePlan.id}: it was approved without integrity signatures ` +
                        "(approved before 0.26.0, or its signatures were removed). Re-approve it with " +
                        `\`fullstackgtm plans approve ${filePlan.id} --operations <ids|all>\`.`);
                }
                // Never widen: every id the tool wants applied must already be
                // store-approved. (A subset is fine — narrowing never writes more.)
                const storeApproved = new Set(stored.approvedOperationIds);
                const unapproved = approvedOperationIds.filter((id) => !storeApproved.has(id));
                if (unapproved.length > 0) {
                    throw new Error(`Refusing to apply plan ${filePlan.id}: operation(s) ${unapproved.join(", ")} were never ` +
                        "approved in the plan store. Approve them first with " +
                        `\`fullstackgtm plans approve ${filePlan.id} --operations <ids>\`.`);
                }
                // Integrity gate: verify against the EFFECTIVE overrides (stored ∪ tool
                // args), so a tool-supplied value that changes what the human approved
                // is treated as tamper, not a live override — what gets written must
                // equal what was signed.
                effectiveOverrides = { ...stored.valueOverrides, ...(valueOverrides ?? {}) };
                const verification = verifyApprovalDigests(stored.plan.operations, stored.approvedOperationIds, effectiveOverrides, stored.approvalDigests);
                if (!verification.ok) {
                    const detail = verification.reason === "no_key"
                        ? "the plan-signing key is missing (was this plan approved on another machine?). Re-approve it here with `fullstackgtm plans approve`."
                        : `these operations differ from what was approved: ${verification.tampered.join(", ")}. ` +
                            "If you want a different value, set it at approval (`plans approve --value <op>=<v>`) and re-approve; " +
                            "otherwise the plan was edited after approval — review and re-approve.";
                    throw new Error(`Refusing to apply plan ${filePlan.id}: ${detail}`);
                }
                plan = stored.plan; // apply what was signed, not what the file says now
            }
            else {
                // External plan file, not in the store: no digests exist to verify, but
                // approvals must still reference real operations in the plan content.
                plan = filePlan;
                const known = new Set(plan.operations.map((operation) => operation.id));
                const unknown = approvedOperationIds.filter((id) => !known.has(id));
                if (unknown.length > 0) {
                    throw new Error(`Plan ${planPath} has no operation(s) ${unknown.join(", ")} — approvedOperationIds ` +
                        "must reference operations in the plan.");
                }
                effectiveOverrides = valueOverrides ?? {};
            }
            const run = await applyPatchPlan(await connectorFor(provider), plan, {
                approvedOperationIds,
                valueOverrides: effectiveOverrides,
            });
            // Persist the run (same data the CLI records) so runs[] and plan status
            // update and audit-log export includes MCP applies. External plan files
            // have no store entry to update — say so instead of silently dropping it.
            let runRecorded = false;
            if (stored) {
                await store.recordRun(plan.id, run);
                runRecorded = true;
            }
            const governance = {
                planSource: stored ? "store" : "external",
                approvalDigestsVerified: stored !== null,
                runRecorded,
                ...(stored
                    ? {}
                    : {
                        note: "Plan file is not in the local plan store: approvals came from tool arguments " +
                            "(verified against the plan content only — no approval-digest check) and the run " +
                            "was not recorded. Use `fullstackgtm audit --save` + `plans approve` for " +
                            "store-backed governance.",
                    }),
            };
            if (output === "markdown") {
                return content(`${formatPatchPlanRun(run)}\n\nGovernance: plan source ${governance.planSource}; ` +
                    (runRecorded
                        ? "approval digests verified; run recorded on the stored plan (audit-log export includes it)."
                        : governance.note));
            }
            // Backward compatible: the run's own fields stay top-level; governance is additive.
            return content({ ...run, governance });
        },
    },
    {
        name: "fullstackgtm_market_worksheet",
        writesCrm: false,
        config: {
            title: "Market Map Classification Worksheet",
            description: "Get everything needed to classify ONE vendor's messaging intensity for a market map: " +
                "the claim taxonomy with judging definitions, the surface rule, and the captured page " +
                "texts. Read each claim's definition, judge loud/quiet/absent from the page texts only, " +
                "and quote verbatim spans (≤300 chars) for every loud/quiet reading. Submit the full " +
                "ObservationSet via fullstackgtm_market_observe — quotes are verified character-for-" +
                "character against the captures, so never paraphrase.",
            inputSchema: strictSchema({
                vendorId: z.string(),
                configPath: z.string().optional().describe("Path to market.config.json (default ./market.config.json)"),
                captureRun: z.string().optional(),
            }),
        },
        handler: async ({ vendorId, configPath, captureRun }) => {
            const config = loadMarketConfigOrHint(resolve(process.cwd(), configPath ?? "market.config.json"));
            return content(buildWorksheet(config, vendorId, { captureRun }));
        },
    },
    {
        name: "fullstackgtm_market_observe",
        writesCrm: false,
        config: {
            title: "Submit Market Map Observations",
            description: "Submit a complete ObservationSet (every vendor × claim cell) for a market map run. " +
                "Validates coverage, the verbatim-evidence rule, and mechanically verifies every quoted " +
                "span against the stored capture it cites. Returns problems if rejected; nothing is " +
                "stored unless the whole set passes. Observations are append-only — use a new runLabel.",
            inputSchema: strictSchema({
                observationsPath: z.string().describe("Path to the ObservationSet JSON file"),
                configPath: z.string().optional().describe("Path to market.config.json (default ./market.config.json)"),
            }),
        },
        handler: async ({ observationsPath, configPath }) => {
            const config = loadMarketConfigOrHint(resolve(process.cwd(), configPath ?? "market.config.json"));
            const set = JSON.parse(readFileSync(resolve(process.cwd(), observationsPath), "utf8"));
            const problems = validateObservationSet(config, set);
            const failures = verifyEvidenceSpans(set.observations, loadCaptureTexts(config.category).textByHash);
            if (problems.length > 0 || failures.length > 0) {
                return content({
                    accepted: false,
                    problems,
                    spanFailures: failures.map((failure) => `${failure.vendorId} × ${failure.claimId}: ${failure.problem}`),
                });
            }
            await createFileObservationStore(config.category).append(set);
            const fronts = computeFrontStates(config, set);
            return content({ accepted: true, runLabel: set.runLabel, observations: set.observations.length, fronts });
        },
    },
];
// Registered first so agents that list tools see the contract entry up top.
// Its payload closes over the registration table, so the reported inventory
// is derived, not hand-maintained.
toolDefinitions.unshift({
    name: "fullstackgtm_capabilities",
    writesCrm: false,
    config: {
        title: "FullStackGTM Capabilities",
        description: "Machine-readable contract for this MCP server: the tool inventory (derived from the " +
            "server's own registration table, with per-tool CRM-write flags), safety defaults, and " +
            "the CLI entrypoints for everything the tools don't cover.",
        inputSchema: strictSchema({}),
    },
    handler: async () => content({
        ok: true,
        tool: "fullstackgtm",
        version: packageVersion(),
        planFirst: true,
        mcpTools: toolDefinitions.map(({ name, writesCrm, config }) => ({
            name,
            title: config.title,
            writesCrm,
        })),
        safety: "Only tools flagged writesCrm can reach a CRM; fullstackgtm_apply writes only operations " +
            "listed in approvedOperationIds and never writes requires_human_* placeholders without a value override.",
        server: { command: "npx -y fullstackgtm-mcp" },
        cli: {
            command: "npx fullstackgtm <command> [--json]",
            capabilities: "npx fullstackgtm capabilities --json",
            agentGuide: "npx fullstackgtm robot-docs",
        },
        examples: [
            "npx -y fullstackgtm-mcp",
            "npx fullstackgtm capabilities --json",
            "npx fullstackgtm audit --demo --json",
        ],
    }),
});
export async function startMcpServer() {
    const server = new McpServer({
        name: "fullstackgtm",
        version: packageVersion(),
    });
    for (const tool of toolDefinitions) {
        // The table is loosely typed so it can drive one loop; the SDK still
        // validates every call against the zod inputSchema at runtime.
        server.registerTool(tool.name, tool.config, tool.handler);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
/**
 * A plan-store file is a StoredPlan envelope ({ plan, status, runs, ... });
 * `audit --out` writes a bare PatchPlan. fullstackgtm_apply accepts either.
 */
function isStoredPlanFile(value) {
    if (typeof value !== "object" || value === null || !("plan" in value))
        return false;
    const plan = value.plan;
    return (typeof plan === "object" &&
        plan !== null &&
        Array.isArray(plan.operations));
}
function loadMarketConfigOrHint(path) {
    try {
        return loadMarketConfig(path);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error(`No market config at ${path} — run \`fullstackgtm market init --category <name>\` in that directory first, or pass configPath.`);
        }
        throw error;
    }
}

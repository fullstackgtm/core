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
async function importPeer<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    try {
      const projectRequire = createRequire(join(process.cwd(), "package.json"));
      return (await import(pathToFileURL(projectRequire.resolve(specifier)).href)) as T;
    } catch {
      throw error; // the original error carries the missing-peer signal mcp-bin reports on
    }
  }
}

const { McpServer } = await importPeer<typeof import("@modelcontextprotocol/sdk/server/mcp.js")>(
  "@modelcontextprotocol/sdk/server/mcp.js",
);
const { StdioServerTransport } = await importPeer<typeof import("@modelcontextprotocol/sdk/server/stdio.js")>(
  "@modelcontextprotocol/sdk/server/stdio.js",
);
const { z } = await importPeer<typeof import("zod/v4")>("zod/v4");
import { auditSnapshot, defaultPolicy } from "./audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.ts";
import { applyPatchPlan } from "./connector.ts";
import { createHubspotConnector } from "./connectors/hubspot.ts";
import { createSalesforceConnector } from "./connectors/salesforce.ts";
import { createStripeConnector } from "./connectors/stripe.ts";
import {
  getCredential,
  resolveHubspotAccessToken,
  resolveSalesforceConnection,
} from "./credentials.ts";
import { generateDemoSnapshot } from "./demo.ts";
import type { FieldMappings } from "./mappings.ts";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.ts";
import { builtinAuditRules } from "./rules.ts";
import { sampleSnapshot } from "./sampleData.ts";
import { normalizeTranscript, parseCall } from "./calls.ts";
import { extractInsightsLlm, resolveLlmCredential } from "./llm.ts";
import {
  computeFrontStates,
  createFileObservationStore,
  loadCaptureTexts,
  loadMarketConfig,
  validateObservationSet,
  verifyEvidenceSpans,
  type ObservationSet,
} from "./market.ts";
import { buildWorksheet } from "./marketClassify.ts";
import { resolveRecord } from "./resolve.ts";
import { suggestValues } from "./suggest.ts";
import type { CanonicalGtmSnapshot, GtmConnector, PatchPlan } from "./types.ts";

function content(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function connectorFor(provider: string): Promise<GtmConnector> {
  if (provider === "hubspot") {
    const token = process.env.HUBSPOT_ACCESS_TOKEN ?? (await resolveHubspotAccessToken());
    if (!token) {
      throw new Error(
        "No HubSpot credentials. Run `fullstackgtm login hubspot` or set HUBSPOT_ACCESS_TOKEN in the MCP server environment.",
      );
    }
    return createHubspotConnector({
      getAccessToken: () => token,
      apiBaseUrl: process.env.HUBSPOT_API_BASE_URL,
    });
  }
  if (provider === "salesforce") {
    const connection =
      process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL
        ? {
            accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
            instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
          }
        : await resolveSalesforceConnection();
    if (!connection) {
      throw new Error(
        "No Salesforce credentials. Run `fullstackgtm login salesforce` or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL in the MCP server environment.",
      );
    }
    return createSalesforceConnector({
      getConnection: () => connection,
      fieldMappings:
        ((connection as { fieldMappings?: unknown }).fieldMappings as
          | FieldMappings
          | undefined) ?? undefined,
    });
  }
  if (provider === "stripe") {
    const key = process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
    if (!key) {
      throw new Error(
        "No Stripe credentials. Run `fullstackgtm login stripe` or set STRIPE_SECRET_KEY in the MCP server environment.",
      );
    }
    return createStripeConnector({ getApiKey: () => key });
  }
  throw new Error(
    `Unknown provider: ${provider}. Supported providers: hubspot, salesforce, stripe`,
  );
}

async function readSnapshot(
  provider?: string,
  inputPath?: string,
): Promise<CanonicalGtmSnapshot> {
  if (provider === "demo") return generateDemoSnapshot();
  if (provider && provider !== "sample") {
    const connector = await connectorFor(provider);
    return connector.fetchSnapshot();
  }
  if (!inputPath) return sampleSnapshot;
  return JSON.parse(
    readFileSync(resolve(process.cwd(), inputPath), "utf8"),
  ) as CanonicalGtmSnapshot;
}

function packageVersion() {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function startMcpServer() {
  const server = new McpServer({
    name: "fullstackgtm",
    version: packageVersion(),
  });

  server.registerTool(
    "fullstackgtm_audit",
    {
      title: "GTM Ops Audit",
      description:
        "Run a dry-run GTM hygiene audit and return a reviewable patch plan. " +
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
    },
    async ({ provider, inputPath, configPath, rules, output, today, staleDealDays }) => {
      const loaded = configPath ? loadConfig(configPath) : null;
      const policy = mergePolicy(defaultPolicy(today), loaded?.config);
      if (today) policy.today = today;
      if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;
      const ruleSet = await resolveConfiguredRules(loaded);
      const selected = rules?.length
        ? ruleSet.filter((rule) => rules.includes(rule.id))
        : ruleSet;
      const plan = auditSnapshot(await readSnapshot(provider, inputPath), policy, selected);
      return content(output === "markdown" ? patchPlanToMarkdown(plan) : plan);
    },
  );

  server.registerTool(
    "fullstackgtm_suggest",
    {
      title: "Suggest Placeholder Values",
      description:
        "Derive values for a plan's requires_human_* placeholder operations from snapshot " +
        "evidence (account-name matching, contact associations), with confidence levels and " +
        "reasons. Read-only; feed accepted values into fullstackgtm_apply's valueOverrides.",
      inputSchema: {
        planPath: z.string(),
        provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
        inputPath: z.string().optional(),
      },
    },
    async ({ planPath, provider, inputPath }) => {
      const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8")) as PatchPlan;
      const snapshot = await readSnapshot(provider, inputPath);
      return content({ suggestions: suggestValues(plan, snapshot) });
    },
  );

  server.registerTool(
    "fullstackgtm_call_parse",
    {
      title: "Parse Call Transcript",
      description:
        "Parse a call transcript (Speaker:/[Speaker]: lines or Granola utterance JSON) into " +
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
    },
    async ({ transcript, transcriptPath, title, source, extractor, model }) => {
      const raw =
        transcript ??
        (transcriptPath ? readFileSync(resolve(process.cwd(), transcriptPath), "utf8") : null);
      if (!raw) throw new Error("Provide transcript (text) or transcriptPath (file).");
      const mode = extractor ?? "auto";
      const credential = mode === "deterministic" ? null : resolveLlmCredential();
      if (mode === "llm" && !credential) {
        throw new Error(
          "extractor 'llm' needs an API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the MCP server environment, or store one with `fullstackgtm login anthropic|openai`.",
        );
      }
      if (credential) {
        const normalized = normalizeTranscript(raw);
        const { insights, model: used } = await extractInsightsLlm(normalized, {
          ...credential,
          model,
          title,
        });
        return content(
          parseCall(raw, { title, sourceSystem: source, insights, extractor: `llm:${credential.provider}:${used}` }),
        );
      }
      return content(parseCall(raw, { title, sourceSystem: source }));
    },
  );

  server.registerTool(
    "fullstackgtm_resolve",
    {
      title: "Resolve Record (create gate)",
      description:
        "Before creating a CRM record, check whether it already exists. Returns a verdict " +
        "(exists | ambiguous | safe_to_create) with matches and a reason, using the same " +
        "identity keys as the audit/merge engines (account domain, contact email, open-deal " +
        "key). Read-only. Never create on 'exists' or 'ambiguous'.",
      inputSchema: {
        objectType: z.enum(["account", "contact", "deal"]),
        name: z.string().optional(),
        domain: z.string().optional(),
        email: z.string().optional(),
        accountId: z.string().optional(),
        provider: z.enum(["sample", "demo", "hubspot", "salesforce", "stripe"]).optional(),
        inputPath: z.string().optional(),
      },
    },
    async ({ objectType, name, domain, email, accountId, provider, inputPath }) => {
      const snapshot = await readSnapshot(provider, inputPath);
      return content(resolveRecord(snapshot, { objectType, name, domain, email, accountId }));
    },
  );

  server.registerTool(
    "fullstackgtm_rules",
    {
      title: "List Audit Rules",
      description: "List the built-in deterministic audit rules with ids and descriptions.",
      inputSchema: {},
    },
    async () => {
      return content(
        builtinAuditRules.map(({ id, title, description }) => ({ id, title, description })),
      );
    },
  );

  server.registerTool(
    "fullstackgtm_apply",
    {
      title: "Apply Approved Patch Operations",
      description:
        "Apply explicitly approved operations from a patch plan through a provider " +
        "connector. Operations not listed in approvedOperationIds are never written, " +
        "and requires_human_* placeholders need a value override.",
      inputSchema: {
        provider: z.enum(["hubspot", "salesforce"]),
        planPath: z.string(),
        approvedOperationIds: z.array(z.string()).min(1),
        valueOverrides: z.record(z.string(), z.string()).optional(),
        output: z.enum(["json", "markdown"]).optional(),
      },
    },
    async ({ provider, planPath, approvedOperationIds, valueOverrides, output }) => {
      const plan = JSON.parse(
        readFileSync(resolve(process.cwd(), planPath), "utf8"),
      ) as PatchPlan;
      const run = await applyPatchPlan(await connectorFor(provider), plan, {
        approvedOperationIds,
        valueOverrides,
      });
      return content(output === "markdown" ? formatPatchPlanRun(run) : run);
    },
  );

  server.registerTool(
    "fullstackgtm_market_worksheet",
    {
      title: "Market Map Classification Worksheet",
      description:
        "Get everything needed to classify ONE vendor's messaging intensity for a market map: " +
        "the claim taxonomy with judging definitions, the surface rule, and the captured page " +
        "texts. Read each claim's definition, judge loud/quiet/absent from the page texts only, " +
        "and quote verbatim spans (≤300 chars) for every loud/quiet reading. Submit the full " +
        "ObservationSet via fullstackgtm_market_observe — quotes are verified character-for-" +
        "character against the captures, so never paraphrase.",
      inputSchema: {
        vendorId: z.string(),
        configPath: z.string().optional().describe("Path to market.config.json (default ./market.config.json)"),
        captureRun: z.string().optional(),
      },
    },
    async ({ vendorId, configPath, captureRun }) => {
      const config = loadMarketConfigOrHint(resolve(process.cwd(), configPath ?? "market.config.json"));
      return content(buildWorksheet(config, vendorId, { captureRun }));
    },
  );

  server.registerTool(
    "fullstackgtm_market_observe",
    {
      title: "Submit Market Map Observations",
      description:
        "Submit a complete ObservationSet (every vendor × claim cell) for a market map run. " +
        "Validates coverage, the verbatim-evidence rule, and mechanically verifies every quoted " +
        "span against the stored capture it cites. Returns problems if rejected; nothing is " +
        "stored unless the whole set passes. Observations are append-only — use a new runLabel.",
      inputSchema: {
        observationsPath: z.string().describe("Path to the ObservationSet JSON file"),
        configPath: z.string().optional().describe("Path to market.config.json (default ./market.config.json)"),
      },
    },
    async ({ observationsPath, configPath }) => {
      const config = loadMarketConfigOrHint(resolve(process.cwd(), configPath ?? "market.config.json"));
      const set = JSON.parse(readFileSync(resolve(process.cwd(), observationsPath), "utf8")) as ObservationSet;
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
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function loadMarketConfigOrHint(path: string): ReturnType<typeof loadMarketConfig> {
  try {
    return loadMarketConfig(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No market config at ${path} — run \`fullstackgtm market init --category <name>\` in that directory first, or pass configPath.`,
      );
    }
    throw error;
  }
}

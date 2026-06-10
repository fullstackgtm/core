import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
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
    return createHubspotConnector({ getAccessToken: () => token });
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

export async function startMcpServer() {
  const server = new McpServer({
    name: "fullstackgtm",
    version: "1.2.0",
  });

  server.registerTool(
    "fullstackgtm_audit",
    {
      title: "GTM Ops Audit",
      description:
        "Run a dry-run GTM hygiene audit and return a reviewable patch plan. " +
        "Reads from the sample dataset, a snapshot file, or a live provider.",
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditSnapshot, defaultPolicy } from "./audit.ts";
import { loadConfig, mergePolicy, resolveConfiguredRules } from "./config.ts";
import { applyPatchPlan } from "./connector.ts";
import { diffFindings, diffSnapshots, diffToMarkdown } from "./diff.ts";
import { createHubspotConnector } from "./connectors/hubspot.ts";
import {
  DEFAULT_LOOPBACK_PORT,
  openInBrowser,
  runHubspotLoopbackLogin,
  validateHubspotToken,
} from "./connectors/hubspotAuth.ts";
import { createSalesforceConnector } from "./connectors/salesforce.ts";
import { createStripeConnector } from "./connectors/stripe.ts";
import {
  pollSalesforceDeviceLogin,
  startSalesforceDeviceLogin,
  validateSalesforceToken,
} from "./connectors/salesforceAuth.ts";
import {
  activeProfile,
  credentialsPath,
  DEFAULT_PROFILE,
  deleteCredential,
  getCredential,
  listProfiles,
  resolveHubspotConnection,
  resolveSalesforceConnection,
  setActiveProfile,
  storeCredential,
  type StoredCredential,
} from "./credentials.ts";
import { generateDemoSnapshot } from "./demo.ts";
import { formatPatchPlanRun, patchPlanToMarkdown } from "./format.ts";
import { mergeSnapshots } from "./merge.ts";
import { createFilePlanStore } from "./planStore.ts";
import { auditReportToHtml, auditReportToMarkdown, type ReportOptions } from "./report.ts";
import { builtinAuditRules } from "./rules.ts";
import { sampleSnapshot } from "./sampleData.ts";
import { parseCall, suggestCallDeal, type ExtractedCallInsight, type ParsedCall } from "./calls.ts";
import { suggestValues, type ValueSuggestion } from "./suggest.ts";
import type { FieldMappings } from "./mappings.ts";
import type {
  AuditFindingSeverity,
  CanonicalGtmSnapshot,
  GtmConnector,
  PatchPlan,
} from "./types.ts";

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
  fullstackgtm report [source options] [audit options] [report options]
  fullstackgtm diff --before <a.json> --after <b.json> [--json] [--fail-on-new-findings]
  fullstackgtm merge --input <a.json> --input <b.json> [...] --out <merged.json> [--json]
  fullstackgtm call parse --transcript <file> [--title t] [--source fathom|granola|...] [--json|--ndjson] [--out <path>]
  fullstackgtm call link --attendees <a@x.com,...> | --domain <x.com>  [source options] [--json]
  fullstackgtm call plan --transcript <file>|--call <parsed.json> --deal <id> [source options] [--save|--json]
                                               calls become evidence: parse dialects (Speaker:/[Me]/Granola JSON),
                                               link to the right deal, and propose governed next-step writes
  fullstackgtm suggest --plan-id <id> | --plan <path>  [source options] [--json] [--out <path>]
                                               derive values for requires_human_* placeholders
                                               from snapshot evidence, with confidence + reasons
  fullstackgtm plans list [--status <s>] | show <id> | reject <id>
  fullstackgtm plans approve <id> --operations <ids|all> [--value <opId>=<v>]
  fullstackgtm plans approve <id> --values-from <suggestions.json> [--min-confidence high|low] [--include-creates]
  fullstackgtm apply --plan-id <id> --provider <name>
  fullstackgtm apply --plan <path> --provider <name> --approve <ids|all> [options]
  fullstackgtm rules [--json]
  fullstackgtm profiles [--json]               list credential profiles
  fullstackgtm doctor [--json]                 check install, credentials, and next step

Profiles (multi-organization use):
  --profile <name>       Scope credentials AND stored plans to a named profile
                         (also: FULLSTACKGTM_PROFILE). One profile per client
                         org keeps logins isolated and prevents a plan proposed
                         against one CRM from being applied through another's
                         credentials. Omitted = the default profile.

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

Report options (report renders the audit as a client-ready deliverable):
  --plan <path>          Render an existing plan JSON instead of re-auditing
                         (add --input <snapshot.json> for record counts)
  --client <name>        Organization name shown in the heading and summary
  --title <text>         Report heading (default "GTM Data Health Report")
  --prepared-by <name>   Attribution shown in the footer
  --format <fmt>         markdown (default) or html (self-contained, printable;
                         inferred from an --out path ending in .html)
  --max-examples <n>     Example records listed per rule (default 10)
  --out <path>           Write the report to a file instead of stdout

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

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function repeatedOption(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function numericOption(args: string[], name: string) {
  const value = option(args, name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

async function hubspotConnection(args: string[]) {
  const tokenEnv = option(args, "--token-env");
  if (tokenEnv) {
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`${tokenEnv} is not set.`);
    return { accessToken: token };
  }
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    return { accessToken: process.env.HUBSPOT_ACCESS_TOKEN };
  }
  const stored = await resolveHubspotConnection();
  if (stored) return stored;
  throw new Error(
    "No HubSpot credentials. Run `fullstackgtm login hubspot`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set HUBSPOT_ACCESS_TOKEN. (`fullstackgtm doctor` shows credential status; see the README's \"Connect your CRM\" section for the private-app scopes to grant.)",
  );
}

async function salesforceConnection() {
  if (process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL) {
    return {
      accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
    };
  }
  const stored = await resolveSalesforceConnection();
  if (stored) return stored;
  throw new Error(
    "No Salesforce credentials. Run `fullstackgtm login salesforce`, pair with a hosted deployment via `fullstackgtm login --via <url>`, or set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL. (`fullstackgtm doctor` shows credential status; device-flow login needs an admin-created Connected App — see the README's \"Connect your CRM\" section.)",
  );
}

async function connectorFor(provider: string, args: string[]): Promise<GtmConnector> {
  if (provider === "hubspot") {
    const connection = await hubspotConnection(args);
    return createHubspotConnector({
      getAccessToken: () => connection.accessToken,
      fieldMappings: (connection.fieldMappings as FieldMappings | undefined) ?? undefined,
      // Point at a mock/proxy HubSpot (tests, evals, request-recording).
      apiBaseUrl: process.env.HUBSPOT_API_BASE_URL,
    });
  }
  if (provider === "salesforce") {
    const connection = await salesforceConnection();
    return createSalesforceConnector({
      getConnection: () => connection,
      fieldMappings:
        ((connection as { fieldMappings?: unknown }).fieldMappings as
          | FieldMappings
          | undefined) ?? undefined,
    });
  }
  if (provider === "stripe") {
    const key =
      process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
    if (!key) {
      throw new Error(
        "No Stripe credentials. Run `echo \"$STRIPE_KEY\" | fullstackgtm login stripe` or set STRIPE_SECRET_KEY. A restricted key with read access to Customers and Subscriptions is enough. (`fullstackgtm doctor` shows credential status.)",
      );
    }
    return createStripeConnector({ getApiKey: () => key });
  }
  throw new Error(
    `Unknown provider: ${provider}. Supported providers: hubspot, salesforce, stripe`,
  );
}

async function readSnapshot(args: string[]): Promise<CanonicalGtmSnapshot> {
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
  if (!input || args.includes("--sample")) return sampleSnapshot;
  const path = resolve(process.cwd(), input);
  return JSON.parse(readFileSync(path, "utf8")) as CanonicalGtmSnapshot;
}

function selectedRules(args: string[], baseRules = builtinAuditRules) {
  const requested = option(args, "--rules");
  if (!requested) return baseRules;
  const ids = requested.split(",").map((id) => id.trim()).filter(Boolean);
  const known = new Map(baseRules.map((rule) => [rule.id, rule]));
  const rules = ids.map((id) => {
    const rule = known.get(id);
    if (!rule) {
      throw new Error(
        `Unknown rule: ${id}. Available rules: ${baseRules.map((r) => r.id).join(", ")}`,
      );
    }
    return rule;
  });
  return rules;
}

const SEVERITY_RANK: Record<AuditFindingSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function failOnThreshold(args: string[]): AuditFindingSeverity | null {
  const value = option(args, "--fail-on");
  if (!value) return null;
  if (value !== "info" && value !== "warning" && value !== "critical") {
    throw new Error("--fail-on must be one of: info, warning, critical");
  }
  return value;
}

async function snapshotCommand(args: string[]) {
  const since = option(args, "--since");
  let snapshot: CanonicalGtmSnapshot;
  if (since) {
    const provider = option(args, "--provider");
    if (!provider) throw new Error("--since requires --provider <name>");
    const connector = await connectorFor(provider, args);
    if (!connector.fetchChanges) {
      throw new Error(`The ${provider} connector does not support incremental fetch.`);
    }
    snapshot = await connector.fetchChanges(since);
  } else {
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
    console.log(
      `Wrote snapshot (${snapshot.users.length} users, ${snapshot.accounts.length} accounts, ` +
        `${snapshot.contacts.length} contacts, ${snapshot.deals.length} deals, ` +
        `${snapshot.activities.length} activities) to ${out}`,
    );
  } else {
    console.log(serialized.trimEnd());
  }
}

async function audit(args: string[]) {
  const threshold = failOnThreshold(args);
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded));
  const snapshot = await readSnapshot(args);

  const policy = mergePolicy(defaultPolicy(), loaded?.config);
  const today = option(args, "--today");
  if (today) policy.today = today;
  const staleDealDays = numericOption(args, "--stale-days");
  if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;

  const plan = auditSnapshot(snapshot, policy, rules);
  const out = option(args, "--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (args.includes("--save")) {
    await createFilePlanStore().save(plan);
    console.error(
      `Saved plan ${plan.id}. Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`.`,
    );
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(patchPlanToMarkdown(plan));
  }

  if (
    threshold &&
    plan.findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])
  ) {
    process.exitCode = 2;
  }
}

/**
 * Render an audit as a client-facing deliverable. Same sources and audit
 * options as `audit`; `--plan` instead renders an existing plan JSON without
 * re-fetching (useful for a plan produced earlier or by another machine).
 */
async function reportCommand(args: string[]) {
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const configuredRules = await resolveConfiguredRules(loaded);

  let plan: PatchPlan;
  let snapshot: CanonicalGtmSnapshot | undefined;
  const planPath = option(args, "--plan");
  if (planPath) {
    plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8")) as PatchPlan;
    const input = option(args, "--input");
    if (input) {
      snapshot = JSON.parse(
        readFileSync(resolve(process.cwd(), input), "utf8"),
      ) as CanonicalGtmSnapshot;
    }
  } else {
    snapshot = await readSnapshot(args);
    const policy = mergePolicy(defaultPolicy(), loaded?.config);
    const today = option(args, "--today");
    if (today) policy.today = today;
    const staleDealDays = numericOption(args, "--stale-days");
    if (staleDealDays !== undefined) policy.staleDealDays = staleDealDays;
    plan = auditSnapshot(snapshot, policy, selectedRules(args, configuredRules));
  }

  const reportOptions: ReportOptions = {
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
  const rendered =
    format === "html"
      ? auditReportToHtml(plan, reportOptions)
      : auditReportToMarkdown(plan, reportOptions);

  if (out) {
    writeFileSync(resolve(process.cwd(), out), rendered);
    console.log(`Wrote ${format} report (${plan.findings.length} findings) to ${out}`);
  } else {
    console.log(rendered.trimEnd());
  }
}

async function rulesCommand(args: string[]) {
  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = await resolveConfiguredRules(loaded);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        rules.map(({ id, title, description, category }) => ({
          id,
          title,
          description,
          category: category ?? "uncategorized",
        })),
        null,
        2,
      ),
    );
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
function safeStatus(response: Response): string {
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

function parseValueOverrides(args: string[]) {
  const valueOverrides: Record<string, unknown> = {};
  for (const pair of repeatedOption(args, "--value")) {
    const separator = pair.indexOf("=");
    if (separator === -1) throw new Error(`--value must look like <operationId>=<value>`);
    valueOverrides[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return valueOverrides;
}

async function callCommand(args: string[]) {
  const [subcommand, ...rest] = args;

  const loadParsedCall = (): ParsedCall => {
    const callPath = option(rest, "--call");
    if (callPath) {
      return JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8")) as ParsedCall;
    }
    const transcriptPath = option(rest, "--transcript");
    if (!transcriptPath) throw new Error(`call ${subcommand} requires --transcript <file> or --call <parsed.json>`);
    const raw = readFileSync(resolve(process.cwd(), transcriptPath), "utf8");
    const source = option(rest, "--source") as ParsedCall["sourceSystem"] | undefined;
    return parseCall(raw, {
      title: option(rest, "--title") ?? undefined,
      sourceSystem: source,
      capturedAt: new Date().toISOString(),
    });
  };

  if (subcommand === "parse") {
    const parsed = loadParsedCall();
    const outPath = option(rest, "--out");
    if (outPath) writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(parsed, null, 2)}\n`);
    if (rest.includes("--ndjson")) {
      // One flat row per insight — warehouse-friendly (e.g. Snowflake COPY).
      for (const insight of parsed.insights) {
        console.log(
          JSON.stringify({
            call_id: parsed.id,
            call_title: parsed.title ?? null,
            source_system: parsed.sourceSystem,
            type: insight.type,
            title: insight.title,
            text: insight.text,
            evidence: insight.evidence,
            speaker: insight.speaker ?? null,
            confidence: insight.confidence,
            importance: insight.importance,
          }),
        );
      }
      return;
    }
    if (rest.includes("--json") || outPath) {
      if (!outPath) console.log(JSON.stringify(parsed, null, 2));
      return;
    }
    console.log(`Call ${parsed.id}${parsed.title ? ` — ${parsed.title}` : ""} (${parsed.sourceSystem})`);
    console.log(`${parsed.segments.length} segments · ${parsed.insights.length} insights (${parsed.summary.highImportance} high-importance)\n`);
    for (const insight of parsed.insights) {
      console.log(`[${insight.type}] (importance ${insight.importance}) ${insight.text}`);
    }
    return;
  }

  if (subcommand === "link") {
    const attendees = option(rest, "--attendees");
    const domain = option(rest, "--domain");
    if (!attendees && !domain) throw new Error("call link requires --attendees <emails,comma-separated> and/or --domain <example.com>");
    const snapshot = await readSnapshot(rest);
    const suggestion = suggestCallDeal(snapshot, {
      attendeeEmails: attendees?.split(",").map((e) => e.trim()).filter(Boolean),
      domain: domain ?? undefined,
    });
    if (rest.includes("--json")) {
      console.log(JSON.stringify(suggestion, null, 2));
    } else {
      const marker = suggestion.confidence === "high" ? "✓" : suggestion.confidence === "low" ? "~" : "✗";
      console.log(`${marker} [${suggestion.confidence}] ${suggestion.dealId ?? "no match"}${suggestion.dealName ? ` — ${suggestion.dealName}` : ""}`);
      console.log(`    ${suggestion.reason}`);
    }
    if (suggestion.confidence === "none") process.exitCode = 1;
    return;
  }

  if (subcommand === "plan") {
    const dealId = option(rest, "--deal");
    if (!dealId) throw new Error("call plan requires --deal <dealId> (use `call link` to find it)");
    const parsed = loadParsedCall();
    const snapshot = await readSnapshot(rest);
    const deal = snapshot.deals.find((row) => row.id === dealId);
    if (!deal) throw new Error(`Deal ${dealId} is not in the snapshot — check the id or the snapshot source.`);

    const nextSteps = parsed.insights.filter((insight) => insight.type === "next_step");
    if (nextSteps.length === 0) {
      console.log("No next-step insights in this call — nothing to plan. (Other insight types are evidence, not writes.)");
      return;
    }
    const [top, ...others] = nextSteps;
    const proposed = top.text.trim().slice(0, 255);
    const current = deal.nextStep?.trim() ?? "";
    const plan = buildCallPlan(parsed, deal, proposed, current, others.slice(0, 3));

    if (rest.includes("--save")) {
      await createFilePlanStore().save(plan);
      console.log(
        `Saved plan ${plan.id}. Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`, then \`fullstackgtm apply --plan-id ${plan.id} --provider <name>\`.`,
      );
      return;
    }
    console.log(rest.includes("--json") ? JSON.stringify(plan, null, 2) : patchPlanToMarkdown(plan));
    return;
  }

  throw new Error(`call supports: parse, link, plan (got ${subcommand ?? "nothing"})`);
}

function buildCallPlan(
  parsed: ParsedCall,
  deal: { id: string; name: string; nextStep?: string },
  proposed: string,
  current: string,
  extraNextSteps: ExtractedCallInsight[],
): PatchPlan {
  const findings: PatchPlan["findings"] = [];
  const operations: PatchPlan["operations"] = [];
  const nextStepEvidence = parsed.evidence.filter(
    (item) => (item.metadata as { insightType?: string } | undefined)?.insightType === "next_step",
  );
  const evidenceIds = nextStepEvidence.map((item) => item.id);

  if (current.toLowerCase() !== proposed.toLowerCase()) {
    findings.push({
      id: `finding_${parsed.id.replace(/^call_/, "")}_${deal.id}`,
      objectType: "deal",
      objectId: deal.id,
      ruleId: "call-next-step-not-reflected-in-crm",
      type: "call_next_step_not_reflected_in_crm",
      title: "Call agreed a next step the CRM does not reflect",
      severity: "warning",
      summary: current
        ? `The call produced "${proposed}" but ${deal.name}'s next step still reads "${current}".`
        : `The call produced "${proposed}" but ${deal.name} has no next step set.`,
      recommendation: "Review the evidence and approve the next-step update.",
      evidenceIds,
      currentCrmValue: current || null,
      proposedValue: proposed,
    });
    operations.push({
      id: `op_${parsed.id.replace(/^call_/, "")}_next`,
      objectType: "deal",
      objectId: deal.id,
      operation: "set_field",
      field: "nextStep",
      beforeValue: current || null,
      afterValue: proposed,
      reason: `Call evidence: ${nextStepEvidence[0]?.text.slice(0, 200) ?? proposed}`,
      sourceRuleOrPolicy: "call_intelligence.next_step",
      riskLevel: "high",
      approvalRequired: true,
      rollback: "Restore the previous deal next step (the before value) if the update is wrong.",
      evidenceIds,
    });
  }
  for (const [index, extra] of extraNextSteps.entries()) {
    operations.push({
      id: `op_${parsed.id.replace(/^call_/, "")}_task${index}`,
      objectType: "deal",
      objectId: deal.id,
      operation: "create_task",
      field: "follow_up_task",
      beforeValue: null,
      afterValue: extra.text.trim().slice(0, 255),
      reason: `Additional commitment from the call: ${extra.evidence.slice(0, 160)}`,
      sourceRuleOrPolicy: "call_intelligence.follow_up",
      riskLevel: "low",
      approvalRequired: true,
      rollback: "Close or delete the created task.",
    });
  }
  return {
    id: `patch_plan_${parsed.id.replace(/^call_/, "")}${deal.id.slice(-4)}`,
    title: `Call evidence plan${parsed.title ? ` — ${parsed.title}` : ""} → ${deal.name}`,
    createdAt: new Date().toISOString(),
    status: "needs_approval",
    dryRun: true,
    summary: `${findings.length} finding(s) and ${operations.length} proposed operation(s) from call ${parsed.id}.`,
    findings,
    evidence: parsed.evidence,
    operations,
  };
}

async function suggest(args: string[]) {
  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) throw new Error("suggest requires --plan <path> or --plan-id <id>");
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

async function apply(args: string[]) {
  const provider = option(args, "--provider");
  if (!provider) throw new Error("apply requires --provider <name>");

  const planId = option(args, "--plan-id");
  const planPath = option(args, "--plan");
  if (!planId && !planPath) throw new Error("apply requires --plan <path> or --plan-id <id>");

  let plan: PatchPlan;
  let approvedOperationIds: string[];
  let valueOverrides: Record<string, unknown>;
  const store = planId ? createFilePlanStore() : null;

  if (planId && store) {
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
    if (stored.status !== "approved") {
      throw new Error(
        `Plan ${planId} is ${stored.status}; approve operations first with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`,
      );
    }
    plan = stored.plan;
    approvedOperationIds = stored.approvedOperationIds;
    valueOverrides = { ...stored.valueOverrides, ...parseValueOverrides(args) };
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
  } else {
    console.log(formatPatchPlanRun(run));
  }
  if (run.status === "failed") process.exitCode = 1;
}

async function diffCommand(args: string[]) {
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

  const loaded = loadConfig(option(args, "--config") ?? undefined);
  const rules = selectedRules(args, await resolveConfiguredRules(loaded));
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

async function mergeCommand(args: string[]) {
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

async function plansCommand(args: string[]) {
  const store = createFilePlanStore();
  const [subcommand, ...rest] = args;

  if (subcommand === "list" || subcommand === undefined) {
    const status = option(rest, "--status") as
      | "draft" | "needs_approval" | "approved" | "rejected" | "applied"
      | null;
    const plans = await store.list(status ?? undefined);
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
    const stored = await store.get(planId);
    if (!stored) throw new Error(`No stored plan with id ${planId}.`);
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
    console.log(
      `Approved ${updated.approvedOperationIds.length} operation(s) on ${planId}. Apply with \`fullstackgtm apply --plan-id ${planId} --provider <name>\`.`,
    );
    return;
  }

  if (subcommand === "reject") {
    const planId = rest.find((arg) => !arg.startsWith("--"));
    if (!planId) throw new Error("Usage: fullstackgtm plans reject <planId>");
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
async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (!piped) {
      throw new Error(
        `No secret provided. Pipe it on stdin (e.g. \`echo "$SECRET" | fullstackgtm login ...\`) ` +
          `or run interactively. Secrets are never accepted as CLI arguments — they leak via the ` +
          `process list and shell history.`,
      );
    }
    // Multi-line stdin (rare) — take the first non-empty line.
    return piped.split(/\r?\n/)[0].trim();
  }

  const readline = await import("node:readline");
  return new Promise<string>((resolveSecret) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    let muted = false;
    const mutable = rl as unknown as { _writeToOutput?: (value: string) => void };
    mutable._writeToOutput = (value: string) => {
      if (!muted) process.stderr.write(value);
    };
    rl.question(`${label}: `, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolveSecret(answer.trim());
    });
    muted = true;
  });
}

function rejectArgvSecret(args: string[], ...flags: string[]) {
  for (const flag of flags) {
    if (args.includes(flag)) {
      throw new Error(
        `${flag} no longer accepts a value on the command line (argv secrets leak via \`ps\` and ` +
          `shell history). Pipe the secret on stdin instead, e.g. \`echo "$SECRET" | fullstackgtm login ...\`.`,
      );
    }
  }
}

async function brokerLogin(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  const os = await import("node:os");
  // Self-reported, shown to the approver so they can recognize this request
  // and refuse one they didn't initiate.
  const requesterLabel = `${os.hostname()} (${process.platform}, ${os.userInfo().username})`;
  let startResponse: Response;
  try {
    startResponse = await fetch(`${base}/api/cli/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterLabel }),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    throw new Error(`Cannot reach the hosted deployment at ${base}${cause}. Check the --via URL and network access.`);
  }
  if (!startResponse.ok) {
    throw new Error(
      `Could not start pairing with ${base} (${startResponse.status}). Is this a FullStackGTM deployment?`,
    );
  }
  const start = await startResponse.json();
  console.error(
    `\nPairing code: ${start.userCode}\n\nApprove this CLI ("${requesterLabel}") in your dashboard:\n\n  ${start.verificationUrl}\n`,
  );
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
    if (poll.status === "pending") continue;
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
      console.log(
        "Provider commands now use the organization's stored sync credentials via the deployment.",
      );
      return;
    }
    throw new Error(`Pairing was ${poll.status}.`);
  }
  throw new Error("Pairing timed out before it was approved.");
}

function isOptionValue(args: string[], arg: string) {
  const index = args.indexOf(arg);
  return index > 0 && args[index - 1].startsWith("--");
}

async function salesforceLogin(args: string[]) {
  const now = new Date().toISOString();

  if (args.includes("--device")) {
    const clientId = option(args, "--client-id");
    if (!clientId) {
      throw new Error(
        "--device requires --client-id (the consumer key of a Connected App with device flow enabled).",
      );
    }
    const loginUrl = option(args, "--login-url") ?? undefined;
    const authorization = await startSalesforceDeviceLogin({ clientId, loginUrl });
    console.error(
      `\nPairing code: ${authorization.userCode}\n\nConfirm this code at:\n\n  ${authorization.verificationUri}\n`,
    );
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
    console.log(
      `Logged in to Salesforce (${tokens.instanceUrl}). Credentials stored in ${credentialsPath()}.`,
    );
    console.log("Tokens refresh silently; no further browser interaction is needed.");
    return;
  }

  rejectArgvSecret(args, "--token");
  const instanceUrl = option(args, "--instance-url");
  if (!instanceUrl) {
    throw new Error(
      "Salesforce login needs --device --client-id <consumer key>, or --instance-url " +
        "<https://yourorg.my.salesforce.com> with the access token piped on stdin.",
    );
  }
  const token = await readSecret("Salesforce access token");
  if (!token) throw new Error("No access token provided.");
  if (!args.includes("--no-validate")) {
    const result = await validateSalesforceToken(token, instanceUrl);
    if (!result.ok) throw new Error(result.detail);
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

async function login(args: string[]) {
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
    if (!key) throw new Error("No Stripe key provided.");
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
    throw new Error(
      "login supports: hubspot, salesforce, stripe, or --via <hosted url>. Usage: fullstackgtm login <provider> | fullstackgtm login --via https://gtm.example.com",
    );
  }
  const now = new Date().toISOString();

  if (args.includes("--oauth")) {
    rejectArgvSecret(args, "--client-secret");
    const clientId = option(args, "--client-id");
    if (!clientId) {
      throw new Error(
        "--oauth requires --client-id from your own HubSpot app " +
          `(register http://localhost:${numericOption(args, "--port") ?? DEFAULT_LOOPBACK_PORT}/callback as a redirect URL). ` +
          "The client secret is read from stdin or an interactive prompt.",
      );
    }
    const clientSecret = await readSecret("HubSpot app client secret");
    if (!clientSecret) throw new Error("No client secret provided.");
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
  if (!token) throw new Error("No token provided.");
  if (!args.includes("--no-validate")) {
    const result = await validateHubspotToken(token);
    if (!result.ok) throw new Error(result.detail);
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

function logout(args: string[]) {
  const provider = args.find((arg) => !arg.startsWith("--"));
  if (!provider) throw new Error("Usage: fullstackgtm logout hubspot");
  if (!getCredential(provider)) {
    console.log(`No stored credentials for ${provider}.`);
    return;
  }
  deleteCredential(provider);
  console.log(`Removed stored ${provider} credentials.`);
}

type ProviderDoctorStatus = {
  source: "env" | "stored" | "broker" | "none";
  detail: string;
};

export function doctorReport(env: Record<string, string | undefined> = process.env) {
  const packageInfo = readPackageInfo();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const storePath = credentialsPath();
  const configPath = resolve("fullstackgtm.config.json");
  const broker = getCredential("broker");

  const providers: Record<string, ProviderDoctorStatus> = {
    hubspot: env.HUBSPOT_ACCESS_TOKEN
      ? { source: "env", detail: "HUBSPOT_ACCESS_TOKEN" }
      : providerStatus("hubspot", broker),
    salesforce:
      env.SALESFORCE_ACCESS_TOKEN && env.SALESFORCE_INSTANCE_URL
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
    } catch {
      return true;
    }
  });

  const connected = Object.entries(providers).filter(([, status]) => status.source !== "none");
  const nextSteps =
    connected.length === 0
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
    mcp: { peersInstalled: missingPeers.length === 0, missing: missingPeers },
    nextSteps,
  };
}

function providerStatus(provider: string, broker: StoredCredential | null): ProviderDoctorStatus {
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
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return { name: parsed.name ?? "fullstackgtm", version: parsed.version ?? "unknown" };
  } catch {
    return { name: "fullstackgtm", version: "unknown" };
  }
}

function doctorCommand(args: string[]) {
  const report = doctorReport();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const mark = (ok: boolean) => (ok ? "ok" : "MISSING");
  const lines = [
    `Package:    ${report.package.name} ${report.package.version}`,
    `Node:       v${report.node.version} (${report.node.required} required) ${mark(report.node.ok)}`,
    `Profile:    ${report.profile}${report.profile === DEFAULT_PROFILE ? "" : " (named profile — credentials and plans are scoped to it)"}`,
    `Cred store: ${report.credentialStore.path} (${report.credentialStore.exists ? "present" : "not created yet — created on first login"})`,
    `Config:     ${report.config.exists ? report.config.path : "none — defaults apply"}`,
    "",
    "Providers:",
    ...Object.entries(report.providers).map(([provider, status]) =>
      `  ${provider.padEnd(11)} ${status.source === "none" ? `not connected (${status.detail})` : `${status.source}: ${status.detail}`}`,
    ),
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
  if (!report.node.ok) process.exitCode = 1;
}

/**
 * Pull the global `--profile <name>` flag out of argv (it may appear before
 * or after the command) and activate it. Stripping it keeps positional
 * detection in subcommands — `login <provider>`, `plans show <id>` — simple.
 */
function extractProfile(argv: string[]): string[] {
  const index = argv.indexOf("--profile");
  if (index === -1) return argv;
  const name = argv[index + 1];
  if (!name) throw new Error("--profile requires a name, e.g. --profile acme");
  setActiveProfile(name);
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function profilesCommand(args: string[]) {
  const profiles = listProfiles();
  const current = activeProfile();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ active: current, profiles }, null, 2));
    return;
  }
  for (const profile of profiles) {
    console.log(`${profile === current ? "*" : " "} ${profile}`);
  }
  if (!profiles.includes(current)) {
    console.log(`* ${current} (selected; created on first login)`);
  }
  console.log(
    "\nSelect with --profile <name> on any command, or set FULLSTACKGTM_PROFILE. " +
      "Each profile keeps its own credentials and stored plans.",
  );
}

export async function runCli(argv: string[]) {
  const [command, ...args] = extractProfile(argv);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(readPackageInfo().version);
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
  if (command === "report") {
    await reportCommand(args);
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
  if (command === "suggest") {
    await suggest(args);
    return;
  }
  if (command === "call") {
    await callCommand(args);
    return;
  }
  if (command === "profiles") {
    profilesCommand(args);
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(import.meta.dirname, "..");

async function withMcpClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "src/mcp-bin.ts"],
    cwd: repoRoot,
  });
  const client = new Client({ name: "fullstackgtm-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function textPayload(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]?.type, "text");
  return content[0].text;
}

test("mcp server exposes the audit, rules, and apply tools over stdio", () =>
  withMcpClient(async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["fullstackgtm_apply", "fullstackgtm_audit", "fullstackgtm_call_parse", "fullstackgtm_capabilities", "fullstackgtm_market_observe", "fullstackgtm_market_worksheet", "fullstackgtm_resolve", "fullstackgtm_rules", "fullstackgtm_suggest"],
    );
  }));

test("mcp capabilities tool reports the full derived tool inventory", () =>
  withMcpClient(async (client) => {
    const tools = await client.listTools();
    const registered = tools.tools.map((tool) => tool.name).sort();
    const result = await client.callTool({ name: "fullstackgtm_capabilities", arguments: {} });
    const payload = JSON.parse(textPayload(result));
    assert.equal(payload.ok, true);
    // Derived from the registration table, so it must match what the server
    // actually registered — every tool, not a hand-picked subset.
    assert.deepEqual(
      payload.mcpTools.map((tool: { name: string }) => tool.name).sort(),
      registered,
    );
    // apply is the only tool that can reach a CRM.
    const writers = payload.mcpTools.filter((tool: { writesCrm: boolean }) => tool.writesCrm);
    assert.deepEqual(writers.map((tool: { name: string }) => tool.name), ["fullstackgtm_apply"]);
    // Published-package phrasing, not monorepo-dev phrasing.
    assert.ok(payload.examples.every((example: string) => example.startsWith("npx")));
  }));

test("mcp audit over the demo dataset returns a valid dry-run patch plan", () =>
  withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "fullstackgtm_audit",
      arguments: { provider: "demo", today: "2026-06-09" },
    });
    const plan = JSON.parse(textPayload(result));
    assert.equal(plan.dryRun, true);
    assert.equal(plan.findings.length, 79);
    assert.equal(plan.operations.length, 79);
  }));

test("mcp audit rejects unknown input keys instead of falling back to the sample audit", () =>
  withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "fullstackgtm_audit",
      arguments: { source: "demo" },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textPayload(result), /source|Unrecognized|unknown/i);
  }));

test("mcp audit supports rule scoping for agents", () =>
  withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "fullstackgtm_audit",
      arguments: { provider: "demo", today: "2026-06-09", rules: ["orphan-account"] },
    });
    const plan = JSON.parse(textPayload(result));
    assert.equal(plan.findings.length, 7);
    assert.ok(
      plan.findings.every((finding: { ruleId: string }) => finding.ruleId === "orphan-account"),
    );
  }));

test("mcp audit honors a config file that disables a rule via configPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-mcp-config-"));
  const configPath = join(dir, "fullstackgtm.config.json");
  writeFileSync(configPath, JSON.stringify({ rules: { disabled: ["stale-deal"] } }));
  return withMcpClient(async (client) => {
    try {
      const baseline = await client.callTool({
        name: "fullstackgtm_audit",
        arguments: { provider: "demo", today: "2026-06-09" },
      });
      const basePlan = JSON.parse(textPayload(baseline));
      assert.ok(
        basePlan.findings.some((finding: { ruleId: string }) => finding.ruleId === "stale-deal"),
        "baseline audit should produce stale-deal findings",
      );

      const result = await client.callTool({
        name: "fullstackgtm_audit",
        arguments: { provider: "demo", today: "2026-06-09", configPath },
      });
      const plan = JSON.parse(textPayload(result));
      assert.ok(
        plan.findings.every(
          (finding: { ruleId: string }) => finding.ruleId !== "stale-deal",
        ),
        "config should disable stale-deal over MCP",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("mcp rules tool lists the built-in rules for discovery", () =>
  withMcpClient(async (client) => {
    const result = await client.callTool({ name: "fullstackgtm_rules", arguments: {} });
    const rules = JSON.parse(textPayload(result));
    assert.deepEqual(
      rules.map((rule: { id: string }) => rule.id).sort(),
      [
        "account-single-source",
        "active-deal-account-without-contacts",
        "closing-soon-inactive",
        "duplicate-account-domain",
        "duplicate-contact-email",
      "duplicate-open-deal",
        "missing-deal-account",
        "missing-deal-amount",
        "missing-deal-owner",
        "orphan-account",
        "past-close-date",
        "stale-deal",
      ],
    );
  }));

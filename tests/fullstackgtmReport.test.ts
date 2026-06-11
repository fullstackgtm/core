import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  auditReportToHtml,
  auditReportToMarkdown,
  auditSnapshot,
  builtinAuditRules,
  defaultPolicy,
  sampleSnapshot,
  type CanonicalGtmSnapshot,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const policy = defaultPolicy("2026-05-03");
const samplePlan = auditSnapshot(sampleSnapshot, policy);

test("markdown report is a client-ready rendering of the audit", () => {
  const markdown = auditReportToMarkdown(samplePlan, {
    clientName: "Acme",
    preparedBy: "Full Stack GTM",
    rules: builtinAuditRules,
    snapshot: sampleSnapshot,
  });

  assert.match(markdown, /^# GTM Data Health Report — Acme\n/);
  assert.match(markdown, /By: Full Stack GTM/);
  assert.match(markdown, /## At a Glance/);
  assert.match(markdown, /\| Records audited \|/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Findings by Rule/);
  assert.match(markdown, /## Details/);
  assert.match(markdown, /Recommendation: /);
  assert.match(markdown, /## Recommended Next Steps/);
  assert.match(markdown, /no CRM data was modified/);

  // Rule metadata, not raw ids, in the rule table.
  const staleRule = builtinAuditRules.find((rule) => rule.id === "stale-deal");
  assert.ok(staleRule);
  if (samplePlan.findings.some((finding) => finding.ruleId === "stale-deal")) {
    assert.ok(markdown.includes(staleRule.title));
  }

  // Deterministic: same plan and options, same report.
  assert.equal(
    markdown,
    auditReportToMarkdown(samplePlan, {
      clientName: "Acme",
      preparedBy: "Full Stack GTM",
      rules: builtinAuditRules,
      snapshot: sampleSnapshot,
    }),
  );
});

test("report without a snapshot omits record counts but keeps findings", () => {
  const markdown = auditReportToMarkdown(samplePlan, { rules: builtinAuditRules });
  assert.doesNotMatch(markdown, /\| Records audited \|/);
  assert.match(markdown, /\| Findings \|/);
});

test("examples per rule are capped with a remainder line", () => {
  const markdown = auditReportToMarkdown(samplePlan, {
    rules: builtinAuditRules,
    maxExamplesPerRule: 1,
  });
  const multiFindingRule = [...samplePlan.findings.reduce((counts, finding) => {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).values()].some((count) => count > 1);
  if (multiFindingRule) {
    assert.match(markdown, /… and \d+ more\./);
  }
});

test("a clean snapshot produces a no-findings report", () => {
  const clean: CanonicalGtmSnapshot = {
    generatedAt: "2026-05-01T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [],
    contacts: [],
    deals: [],
    activities: [],
  };
  const markdown = auditReportToMarkdown(auditSnapshot(clean, policy), { snapshot: clean });
  assert.match(markdown, /found no issues/);
  assert.doesNotMatch(markdown, /## Details/);
});

test("html report is self-contained and escapes CRM-sourced text", () => {
  const hostile: CanonicalGtmSnapshot = {
    generatedAt: "2026-05-01T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [{ id: "a1", name: "<script>alert(1)</script> Co" }],
    contacts: [],
    deals: [{ id: "d1", accountId: "a1", name: "Bad <b>Deal</b>", stage: "open", isClosed: false }],
    activities: [],
  };
  const plan = auditSnapshot(hostile, policy);
  assert.ok(plan.findings.length > 0, "hostile snapshot should produce findings");
  const html = auditReportToHtml(plan, {
    clientName: 'Evil "Corp" <Inc>',
    rules: builtinAuditRules,
    snapshot: hostile,
  });

  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes("<script>"), "record names must be escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Evil &quot;Corp&quot; &lt;Inc&gt;"));
  assert.doesNotMatch(html, /<link|<img|src=|href="http/);
});

test("cli: report renders to stdout, file, html, and from a saved plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-report-cli-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, FSGTM_HOME: dir };
    delete env.HUBSPOT_ACCESS_TOKEN;
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8", env: env as NodeJS.ProcessEnv },
      );

    const markdown = run([
      "report", "--sample", "--today", "2026-05-03", "--client", "Acme",
    ]);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /^# GTM Data Health Report — Acme/);

    const htmlOut = join(dir, "report.html");
    const html = run([
      "report", "--sample", "--today", "2026-05-03", "--out", htmlOut,
    ]);
    assert.equal(html.status, 0, html.stderr);
    assert.match(html.stdout, /Wrote html report/);
    assert.match(readFileSync(htmlOut, "utf8"), /^<!doctype html>/);

    const badFormat = run(["report", "--sample", "--format", "pdf"]);
    assert.equal(badFormat.status, 1);
    assert.match(badFormat.stderr, /--format must be markdown or html/);

    // Render an existing plan without re-auditing.
    const planPath = join(dir, "plan.json");
    const audit = run([
      "audit", "--sample", "--today", "2026-05-03", "--json", "--out", planPath,
    ]);
    assert.equal(audit.status, 0, audit.stderr);
    const fromPlan = run(["report", "--plan", planPath, "--client", "Acme"]);
    assert.equal(fromPlan.status, 0, fromPlan.stderr);
    assert.match(fromPlan.stdout, /^# GTM Data Health Report — Acme/);
    assert.doesNotMatch(fromPlan.stdout, /\| Records audited \|/);

    // Same plan with the snapshot supplied gains record counts.
    const snapshotPath = join(dir, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(sampleSnapshot, null, 2));
    const withSnapshot = run([
      "report", "--plan", planPath, "--input", snapshotPath,
    ]);
    assert.equal(withSnapshot.status, 0, withSnapshot.stderr);
    assert.match(withSnapshot.stdout, /\| Records audited \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

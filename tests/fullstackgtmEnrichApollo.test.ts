import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  apolloPullKeysForAppend,
  apolloPullKeysForRefresh,
  createApolloClient,
  pullApolloRecords,
} from "../src/enrichApollo.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const binPath = join(repoRoot, "packages", "fullstackgtm", "src", "bin.ts");

type FakeResponse = { status: number; body?: string; headers?: Record<string, string> };

function fakeFetch(script: FakeResponse[], calls: Array<{ url: string; init?: RequestInit }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = script.shift();
    if (!next) throw new Error("fake fetch script exhausted");
    return new Response(next.body ?? "{}", {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 429-aware retry (fake fetch only — tests never hit the real Apollo API)

test("apollo client retries 429 with backoff, honoring Retry-After", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const client = createApolloClient({
    getApiKey: () => "key-123",
    fetchImpl: fakeFetch(
      [
        { status: 429, headers: { "Retry-After": "2" } },
        { status: 429 }, // no header → capped exponential backoff
        { status: 200, body: JSON.stringify({ organization: { id: "org_1", name: "Acme" } }) },
      ],
      calls,
    ),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const payload = await client.enrichOrganization("acme.com");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]); // Retry-After 2s, then 500 * 2^1
  assert.equal((payload?.organization as { id?: string })?.id, "org_1");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)["X-Api-Key"],
    "key-123",
  );
  assert.match(calls[0].url, /\/api\/v1\/organizations\/enrich\?domain=acme\.com$/);
});

test("apollo client gives up after maxRetries 429s with a status-bearing error", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const client = createApolloClient({
    getApiKey: () => "key-123",
    maxRetries: 2,
    fetchImpl: fakeFetch(
      [
        { status: 429, body: "slow down" },
        { status: 429, body: "slow down" },
        { status: 429, body: "slow down" },
      ],
      calls,
    ),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(client.matchPerson("a@b.com"), /Apollo API error 429 \(rate limited; 2 retries exhausted\): slow down/);
  assert.equal(calls.length, 3); // initial + 2 retries
  assert.equal(sleeps.length, 2);
});

test("apollo client throws on non-OK (no retry), returns null on 404, wraps network errors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const unauthorized = createApolloClient({
    getApiKey: () => "bad-key",
    fetchImpl: fakeFetch([{ status: 401, body: "invalid api key" }], calls),
  });
  await assert.rejects(unauthorized.matchPerson("a@b.com"), /Apollo API error 401: invalid api key/);
  assert.equal(calls.length, 1);

  const missing = createApolloClient({
    getApiKey: () => "key",
    fetchImpl: fakeFetch([{ status: 404, body: "not found" }], []),
  });
  assert.equal(await missing.enrichOrganization("nowhere.example"), null);

  const offline = createApolloClient({
    getApiKey: () => "key",
    fetchImpl: (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch,
  });
  await assert.rejects(offline.enrichOrganization("acme.com"), /Cannot reach Apollo at https:\/\/api\.apollo\.io/);
});

// ---------------------------------------------------------------------------
// Pull adapter

const snapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-12T00:00:00.000Z",
  provider: "mock",
  users: [],
  accounts: [
    { id: "1001", name: "Acme Inc", domain: "acme.com" }, // industry blank
    { id: "1002", name: "Globex", domain: "ACME.com", industry: "Mfg", employeeCount: 5 }, // dup domain, nothing blank
    { id: "1003", name: "No Domain Co" }, // blank industry but no pull key
  ],
  contacts: [{ id: "2001", firstName: "Jane", lastName: "Doe", email: "jane@acme.com" }],
  deals: [],
  activities: [],
};

test("append pull keys: blank-field records with a pull key, deduplicated case-insensitively", () => {
  const keys = apolloPullKeysForAppend(snapshot, ["company", "contact"], (objectType, record) =>
    objectType === "company" ? record.industry === undefined : record.title === undefined,
  );
  // acme.com appears once despite two accounts carrying it; 1003 has no domain.
  assert.deepEqual(keys, [
    { objectType: "company", key: "domain", value: "acme.com" },
    { objectType: "contact", key: "email", value: "jane@acme.com" },
  ]);

  const refreshKeys = apolloPullKeysForRefresh(snapshot, [
    { objectType: "company", objectId: "1001", field: "employeeCount" },
    { objectType: "company", objectId: "1003", field: "employeeCount" }, // no domain → skipped
    { objectType: "contact", objectId: "2001", field: "title" },
  ]);
  assert.deepEqual(refreshKeys, [
    { objectType: "company", key: "domain", value: "acme.com" },
    { objectType: "contact", key: "email", value: "jane@acme.com" },
  ]);
});

test("pullApolloRecords normalizes payloads, records misses, checkpoints, and resumes after a cursor", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createApolloClient({
    getApiKey: () => "key",
    fetchImpl: fakeFetch(
      [
        {
          status: 200,
          body: JSON.stringify({
            organization: { id: "org_1", name: "Acme Inc", primary_domain: "acme.com", industry: "Software" },
          }),
        },
        { status: 200, body: JSON.stringify({ person: null }) }, // no data → miss
      ],
      calls,
    ),
  });
  const progress: string[] = [];
  const result = await pullApolloRecords(
    client,
    [
      { objectType: "company", key: "domain", value: "acme.com" },
      { objectType: "contact", key: "email", value: "jane@acme.com" },
    ],
    { onProgress: (update) => void progress.push(update.lastKeyValue) },
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "apollo:org_org_1");
  assert.deepEqual(result.records[0].keys, { domain: "acme.com", name: "Acme Inc" });
  assert.deepEqual(result.misses, [{ objectType: "contact", key: "email", value: "jane@acme.com" }]);
  assert.deepEqual(progress, ["acme.com", "jane@acme.com"]);

  // Resume: keys up to and including the cursor are skipped — no re-paying
  // for completed lookups.
  const resumedCalls: Array<{ url: string; init?: RequestInit }> = [];
  const resumedClient = createApolloClient({
    getApiKey: () => "key",
    fetchImpl: fakeFetch([{ status: 200, body: JSON.stringify({ person: { id: "p1", title: "VP" } }) }], resumedCalls),
  });
  const resumed = await pullApolloRecords(
    resumedClient,
    [
      { objectType: "company", key: "domain", value: "acme.com" },
      { objectType: "contact", key: "email", value: "jane@acme.com" },
    ],
    { resumeAfter: "acme.com" },
  );
  assert.equal(resumedCalls.length, 1);
  assert.match(resumedCalls[0].url, /people\/match/);
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.records[0].objectType, "contact");
});

// ---------------------------------------------------------------------------
// CLI: --help is caught before config load, credential resolution, disk, network

function runCli(args: string[], options: { cwd?: string; home: string }) {
  const env: Record<string, string | undefined> = { ...process.env, FSGTM_HOME: options.home };
  delete env.HUBSPOT_ACCESS_TOKEN;
  delete env.APOLLO_API_KEY;
  return spawnSync(process.execPath, ["--experimental-strip-types", binPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
  });
}

test("enrich --help and every subcommand --help exit 0 without touching config, credentials, disk, or network", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-enrich-help-"));
  const home = join(dir, "home"); // never created — help must not write
  try {
    // No enrich.config.json in cwd, no credentials, no Apollo key: if help
    // fell through to execution, every one of these would error (or worse,
    // `append --help` would attempt a paid pull — the 0.14.1/0.18 bug class).
    for (const args of [
      ["enrich"],
      ["enrich", "--help"],
      ["enrich", "append", "--help"],
      ["enrich", "append", "--source", "apollo", "-h"],
      ["enrich", "refresh", "--help"],
      ["enrich", "ingest", "--help"],
      ["enrich", "status", "--help"],
    ]) {
      const result = runCli(args, { cwd: dir, home });
      assert.equal(result.status, 0, `${args.join(" ")} → ${result.stderr}`);
      assert.match(result.stdout, /enrich append/, args.join(" "));
      assert.match(result.stdout, /enrich refresh/, args.join(" "));
    }
    // Nothing was written under the (nonexistent) home.
    assert.throws(() => readdirSync(home), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enrich CLI end-to-end: ingest CSV → append --save → status reports run, stamps, and plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-enrich-e2e-"));
  const home = join(dir, "home");
  try {
    writeFileSync(
      join(dir, "enrich.config.json"),
      JSON.stringify({
        sources: { clay: { kind: "ingest", format: "csv" } },
        match: { contact: { keys: ["email"], onAmbiguous: "skip" } },
        fields: { contact: [{ crm: "jobtitle", from: { clay: "Job Title" }, refresh: true, staleDays: 30 }] },
        policy: { overwrite: "never" },
      }),
    );
    writeFileSync(
      join(dir, "snapshot.json"),
      JSON.stringify({
        generatedAt: "2026-06-12T00:00:00.000Z",
        provider: "mock",
        users: [],
        accounts: [],
        contacts: [
          { id: "2001", firstName: "Jane", lastName: "Doe", email: "jane@acme.com" },
          { id: "2002", firstName: "Sam", lastName: "Po", email: "sam@acme.com", title: "CEO" },
        ],
        deals: [],
        activities: [],
      }),
    );
    writeFileSync(
      join(dir, "clay.csv"),
      'Email,Job Title\njane@acme.com,"VP, Operations"\nsam@acme.com,Janitor\nnobody@nowhere.example,Ghost\n',
    );

    const ingest = runCli(["enrich", "ingest", "clay.csv", "--source", "clay"], { cwd: dir, home });
    assert.equal(ingest.status, 0, ingest.stderr);
    assert.match(ingest.stdout, /Staged 3 contact row\(s\)/);

    // Dry run writes nothing beyond the staged run already present.
    const dry = runCli(["enrich", "append", "--source", "clay", "--input", "snapshot.json"], { cwd: dir, home });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /VP, Operations/);
    assert.match(dry.stdout, /Dry run — nothing written/);
    assert.ok(!readdirSync(home, { recursive: true }).some((f) => String(f).includes("plans")), "dry run saved a plan");

    const save = runCli(["enrich", "append", "--source", "clay", "--input", "snapshot.json", "--save"], {
      cwd: dir,
      home,
    });
    assert.equal(save.status, 0, save.stderr);
    assert.match(save.stdout, /Saved plan patch_plan_enr_/);
    // 3 staged rows: jane fills a blank (op), sam already has a title (policy
    // never → no op), ghost matches nobody.
    assert.match(save.stdout, /3 fetched · 2 matched · 1 unmatched · 0 ambiguous/);
    assert.match(save.stdout, /1 operation\(s\) proposed/);

    const status = runCli(["enrich", "status", "--json"], { cwd: dir, home });
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout) as {
      sources: Array<{
        source: string;
        lastRun: { mode: string; planIds: string[] };
        stamps: { total: number; stale: number };
      }>;
    };
    const clay = report.sources.find((entry) => entry.source === "clay");
    assert.ok(clay, "clay missing from status");
    assert.equal(clay!.lastRun.mode, "append");
    assert.equal(clay!.lastRun.planIds.length, 1);
    assert.equal(clay!.stamps.total, 1);
    assert.equal(clay!.stamps.stale, 0);

    // The saved plan is in the plan store as needs_approval.
    const plans = runCli(["plans", "list", "--json"], { cwd: dir, home });
    assert.equal(plans.status, 0, plans.stderr);
    const list = JSON.parse(plans.stdout) as Array<{ id: string; status: string }>;
    assert.equal(list.length, 1);
    assert.match(list[0].id, /^patch_plan_enr_/);
    assert.equal(list[0].status, "needs_approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

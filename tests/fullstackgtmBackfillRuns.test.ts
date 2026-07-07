import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PatchPlan, PatchPlanRun } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures: a temp FSGTM_HOME with one stored plan (2 runs) + 2 health entries.

function plan(): PatchPlan {
  return {
    id: "patch_plan_test_0001",
    title: "Test plan",
    createdAt: "2026-05-01T00:00:00.000Z",
    status: "approved",
    dryRun: true,
    summary: "test",
    findings: [],
    operations: [
      {
        id: "op_1",
        objectType: "deal",
        objectId: "d1",
        operation: "set_field",
        field: "nextStep",
        beforeValue: null,
        afterValue: "call",
        reason: "test",
        sourceRuleOrPolicy: "test",
        riskLevel: "low",
        approvalRequired: true,
        rollback: "restore",
      },
    ],
  };
}

function run(startedAt: string, status: PatchPlanRun["status"]): PatchPlanRun {
  return {
    planId: "patch_plan_test_0001",
    provider: "hubspot",
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 5000).toISOString(),
    status,
    results: [
      { operationId: "op_1", status: status === "applied" ? "applied" : "failed" },
    ],
  };
}

function healthEntry(at: string, score: number) {
  return {
    at,
    planId: "patch_plan_test_0001",
    score,
    findings: 3,
    weightedFindings: 5,
    records: { accounts: 10, contacts: 20, deals: 5, total: 35 },
    byRule: { "missing-deal-owner": 3 },
    severityCounts: { info: 1, warning: 2, critical: 0 },
    byObjectType: {
      account: { records: 10, findings: 0, weightedFindings: 0, score: 100 },
      contact: { records: 20, findings: 0, weightedFindings: 0, score: 100 },
      deal: { records: 5, findings: 3, weightedFindings: 5, score: 50 },
    },
  };
}

async function withBackfillHome<T>(
  fetchImpl: typeof fetch,
  runFn: () => Promise<T>,
): Promise<{ result: T }> {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-bkfruns-"));
  const prevHome = process.env.FSGTM_HOME;
  const origFetch = globalThis.fetch;
  process.env.FSGTM_HOME = home;
  globalThis.fetch = fetchImpl;
  try {
    // Seed the plan store + runs through the real store (approval digests etc.).
    const { createFilePlanStore } = await import("../src/planStore.ts");
    const store = createFilePlanStore();
    await store.save(plan());
    await store.recordRun("patch_plan_test_0001", run("2026-05-02T10:00:00.000Z", "applied"));
    await store.recordRun("patch_plan_test_0001", run("2026-05-03T10:00:00.000Z", "partial"));
    // Seed health.jsonl directly (same shape appendHealthEntry writes).
    appendFileSync(
      join(home, "health.jsonl"),
      `${JSON.stringify(healthEntry("2026-05-02T10:00:01.000Z", 82))}\n` +
        `${JSON.stringify(healthEntry("2026-05-03T10:00:01.000Z", 88))}\n`,
      { mode: 0o600 },
    );
    // Broker pairing.
    const { storeCredential } = await import("../src/credentials.ts");
    const now = new Date().toISOString();
    storeCredential("broker", {
      kind: "broker",
      accessToken: "fsgtm_test_token",
      baseUrl: "https://app.example.com",
      createdAt: now,
      updatedAt: now,
    });
    const result = await runFn();
    return { result };
  } finally {
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function captureFetch(seen: Array<{ url: string; body: any; auth: string | null }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: headers.get("Authorization"),
    });
    if (url.endsWith("/api/cli/health")) {
      return new Response(JSON.stringify({ inserted: 2, deduped: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ runId: "r1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function captureCli(argv: string[]): Promise<{ out: string; err: string }> {
  const { runCli } = await import("../src/cli.ts");
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

// ---------------------------------------------------------------------------

test("backfill runs: replays plan runs + health history with deterministic ids and original timestamps", async () => {
  const seen: Array<{ url: string; body: any; auth: string | null }> = [];
  await withBackfillHome(captureFetch(seen), async () => {
    const { out } = await captureCli(["backfill", "runs", "--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.ok, true);
    assert.equal(summary.runsReported, 2);
    assert.equal(summary.healthInserted, 2);
  });

  const runPosts = seen.filter((s) => s.url.endsWith("/api/cli/run"));
  const healthPosts = seen.filter((s) => s.url.endsWith("/api/cli/health"));
  assert.equal(runPosts.length, 2);
  assert.equal(healthPosts.length, 1);

  // Deterministic idempotency ids, original timestamps, broker auth.
  for (const post of runPosts) {
    assert.match(post.body.clientRunId, /^bkf_[0-9a-f]{8}$/);
    assert.equal(post.auth, "Bearer fsgtm_test_token");
    assert.equal(post.body.counts.backfilled, true);
    assert.equal(post.body.durationMs, 5000);
  }
  assert.equal(runPosts[0].body.startedAt, Date.parse("2026-05-02T10:00:00.000Z"));
  assert.equal(runPosts[0].body.status, "success");
  assert.equal(runPosts[1].body.status, "partial");
  assert.match(runPosts[0].body.command, /^apply --plan-id patch_plan_test_0001$/);

  // Health entries carry the full scoring shape with numeric timestamps.
  const entries = healthPosts[0].body.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].at, Date.parse("2026-05-02T10:00:01.000Z"));
  assert.equal(entries[1].score, 88);
  assert.deepEqual(entries[0].severityCounts, { info: 1, warning: 2, critical: 0 });
});

test("backfill runs: same local history → same clientRunIds across invocations (idempotent replay)", async () => {
  const first: Array<{ url: string; body: any; auth: string | null }> = [];
  await withBackfillHome(captureFetch(first), async () => {
    await captureCli(["backfill", "runs", "--json"]);
    // Second replay in the SAME home: ids must be identical.
    const second: Array<{ url: string; body: any; auth: string | null }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(second);
    try {
      await captureCli(["backfill", "runs", "--json"]);
    } finally {
      globalThis.fetch = origFetch;
    }
    const ids = (posts: typeof first) =>
      posts.filter((s) => s.url.endsWith("/api/cli/run")).map((s) => s.body.clientRunId);
    assert.deepEqual(ids(second), ids(first));
  });
});

test("backfill runs: --dry-run sends nothing; unpaired fails with the pairing hint", async () => {
  const seen: Array<{ url: string; body: any; auth: string | null }> = [];
  await withBackfillHome(captureFetch(seen), async () => {
    const { out } = await captureCli(["backfill", "runs", "--dry-run", "--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.runs, 2);
    assert.equal(summary.healthEntries, 2);
  });
  assert.equal(seen.length, 0);

  // Unpaired home → actionable error.
  const home = mkdtempSync(join(tmpdir(), "fsgtm-bkfruns-unpaired-"));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    await assert.rejects(captureCli(["backfill", "runs"]), /login --via/);
  } finally {
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("backfill runs: partial transport failure reports errors and a nonzero exit code", async () => {
  const seen: Array<{ url: string; body: any; auth: string | null }> = [];
  let calls = 0;
  const flaky: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 2) return new Response("boom", { status: 500 });
    return captureFetch(seen)(input as never, init);
  }) as typeof fetch;

  const prevExit = process.exitCode;
  await withBackfillHome(flaky, async () => {
    const { out } = await captureCli(["backfill", "runs", "--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.ok, false);
    assert.equal(summary.runsReported, 1);
    assert.equal(summary.runsFailed, 1);
    assert.ok(Array.isArray(summary.errors) && summary.errors.length === 1);
  });
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExit;
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAcquirePlan,
  parseEnrichConfig,
  type EnrichConfig,
  type EnrichSourceRecord,
} from "../src/enrich.ts";
import {
  dayKey,
  loadMeter,
  recordConsumption,
  remaining,
  rollWindows,
  saveMeter,
  type AcquireMeterState,
} from "../src/acquireMeter.ts";
import { applyPatchPlan, createHubspotConnector } from "../src/index.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload, PatchPlan } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures

function acquireConfig(overrides: Record<string, unknown> = {}): EnrichConfig {
  return parseEnrichConfig(
    JSON.stringify({
      sources: { clay: { kind: "ingest", format: "csv" } },
      match: { contact: { keys: ["email"], onAmbiguous: "skip" } },
      fields: {},
      policy: { overwrite: "never", defaultStaleDays: 90 },
      acquire: {
        budget: { records: { perDay: 50, perMonth: 500 }, spend: { perDay: 10, perMonth: 100 } },
        costPerRecord: { clay: 0.2 },
        create: {
          contact: {
            matchKey: "email",
            properties: { email: "email", firstname: "first_name", lastname: "last_name" },
            associateCompanyFrom: "company",
          },
        },
      },
      ...overrides,
    }),
  );
}

function snapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-19T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [],
    contacts: [
      { id: "2001", firstName: "Jane", lastName: "Doe", email: "jane@acme.com" },
      // jon@globex.com appears twice → ambiguous on the email key
      { id: "2002", firstName: "Jon", lastName: "Snow", email: "jon@globex.com" },
      { id: "2003", firstName: "Jon", lastName: "Stark", email: "jon@globex.com" },
    ],
    deals: [],
    activities: [],
  };
}

function contactRecord(id: string, email: string | undefined, extra: Record<string, unknown> = {}): EnrichSourceRecord {
  return {
    id,
    objectType: "contact",
    keys: { email },
    payload: { email, ...extra },
  };
}

// ---------------------------------------------------------------------------
// buildAcquirePlan: routing

test("acquire: matched skipped, ambiguous skipped, only confirmed net-new becomes a create", () => {
  const result = buildAcquirePlan({
    config: acquireConfig(),
    source: "clay",
    snapshot: snapshot(),
    runLabel: "t",
    records: [
      contactRecord("r1", "jane@acme.com", { first_name: "Jane", last_name: "Doe" }), // matched
      contactRecord("r2", "jon@globex.com", { first_name: "Jon", last_name: "X" }), // ambiguous (2 hits)
      contactRecord("r3", "alice@new.io", { first_name: "Alice", last_name: "New", company: "New Co" }), // net-new
      contactRecord("r4", undefined, { first_name: "No", last_name: "Email" }), // no dedupe key
    ],
    now: () => new Date("2026-06-19T12:00:00.000Z"),
  });

  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.ambiguous, 1);
  assert.equal(result.counts.created, 1);
  assert.equal(result.plan.operations.length, 1);

  const op = result.plan.operations[0];
  assert.equal(op.operation, "create_record");
  assert.equal(op.objectType, "contact");
  const payload = op.afterValue as CreateRecordPayload;
  assert.equal(payload.matchKey, "email");
  assert.equal(payload.matchValue, "alice@new.io");
  assert.equal(payload.properties.email, "alice@new.io");
  assert.equal(payload.properties.firstname, "Alice");
  assert.equal(payload.associateCompanyName, "New Co");
  assert.equal(payload.estCostUsd, 0.2);
  // plan is always a dry-run proposal; nothing is written here
  assert.equal(result.plan.dryRun, true);
  assert.equal(result.plan.status, "needs_approval");
});

test("acquire: the meter ceiling caps creates and counts the rest as withheld", () => {
  const records = [
    contactRecord("r1", "a@new.io", { first_name: "A", last_name: "A" }),
    contactRecord("r2", "b@new.io", { first_name: "B", last_name: "B" }),
    contactRecord("r3", "c@new.io", { first_name: "C", last_name: "C" }),
  ];
  const result = buildAcquirePlan({
    config: acquireConfig(),
    source: "clay",
    snapshot: snapshot(),
    runLabel: "t",
    records,
    maxRecords: 2,
    now: () => new Date("2026-06-19T12:00:00.000Z"),
  });
  assert.equal(result.counts.created, 2);
  assert.equal(result.counts.withheldByMeter, 1);
  assert.equal(result.plan.operations.length, 2);
  assert.equal(result.estCostUsd, 0.4);
});

test("acquire: a config with no acquire section is a clear error", () => {
  const config = parseEnrichConfig(
    JSON.stringify({
      sources: { clay: { kind: "ingest", format: "csv" } },
      match: { contact: { keys: ["email"] } },
      fields: { contact: [{ crm: "jobtitle", from: { clay: "Job Title" } }] },
      policy: { overwrite: "never" },
    }),
  );
  assert.throws(
    () => buildAcquirePlan({ config, source: "clay", snapshot: snapshot(), records: [], runLabel: "t" }),
    /no "acquire" section/,
  );
});

// ---------------------------------------------------------------------------
// acquireMeter: window math and budget ceilings

test("meter remaining: maxRecords is the min across record and spend ceilings", () => {
  const now = new Date("2026-06-19T12:00:00.000Z");
  const state: AcquireMeterState = {
    day: dayKey(now),
    month: now.toISOString().slice(0, 7),
    records: { day: 0, month: 0 },
    spendUsd: { day: 0, month: 0 },
  };
  const budget = { records: { perDay: 50, perMonth: 500 }, spend: { perDay: 10, perMonth: 100 } };
  // cost 0.20 → spend/day ceiling = floor(10/0.2)=50 → min(50,500,50,500)=50
  assert.equal(remaining(state, budget, 0.2, now).maxRecords, 50);
  // a tighter spend budget binds first: $2/day at $0.20 → 10 records
  assert.equal(remaining(state, { ...budget, spend: { perDay: 2, perMonth: 100 } }, 0.2, now).maxRecords, 10);
  // cost 0 → spend cannot constrain; record caps win
  assert.equal(remaining(state, budget, 0, now).maxRecords, 50);
  // no budget → unlimited
  assert.equal(remaining(state, undefined, 0.2, now).maxRecords, null);
});

test("meter remaining: used headroom shrinks the ceiling", () => {
  const now = new Date("2026-06-19T12:00:00.000Z");
  const state: AcquireMeterState = {
    day: dayKey(now),
    month: now.toISOString().slice(0, 7),
    records: { day: 48, month: 100 },
    spendUsd: { day: 0, month: 0 },
  };
  const budget = { records: { perDay: 50, perMonth: 500 } };
  assert.equal(remaining(state, budget, 0, now).maxRecords, 2); // 50-48
});

test("meter rollWindows: a new UTC day zeroes day buckets, same month keeps month buckets", () => {
  const state: AcquireMeterState = {
    day: "2026-06-18",
    month: "2026-06",
    records: { day: 40, month: 120 },
    spendUsd: { day: 8, month: 24 },
  };
  const rolled = rollWindows(state, new Date("2026-06-19T01:00:00.000Z"));
  assert.equal(rolled.records.day, 0);
  assert.equal(rolled.records.month, 120);
  assert.equal(rolled.spendUsd.day, 0);
  assert.equal(rolled.spendUsd.month, 24);
});

test("meter recordConsumption accumulates and persists per profile dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-meter-"));
  try {
    const now = new Date("2026-06-19T12:00:00.000Z");
    recordConsumption(now, 3, 0.6, dir);
    recordConsumption(now, 2, 0.4, dir);
    const state = loadMeter(now, dir);
    assert.equal(state.records.day, 5);
    assert.equal(state.records.month, 5);
    assert.ok(Math.abs(state.spendUsd.day - 1.0) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HubSpot connector: resolve-first create_record

function createPlan(payload: CreateRecordPayload): PatchPlan {
  return {
    id: "plan_acq_test",
    title: "Acquire leads — clay",
    createdAt: "2026-06-19T12:00:00.000Z",
    status: "approved",
    dryRun: true,
    summary: "test",
    findings: [],
    operations: [
      {
        id: "op_acq_1",
        objectType: "contact",
        objectId: `create:${payload.matchValue}`,
        operation: "create_record",
        beforeValue: null,
        afterValue: payload,
        reason: "net-new",
        riskLevel: "medium",
        approvalRequired: true,
      },
    ],
  };
}

test("create_record: a confirmed miss creates the contact (resolve-first)", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (url.includes("/contacts/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "c1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const plan = createPlan({
    properties: { email: "alice@new.io", firstname: "Alice" },
    matchKey: "email",
    matchValue: "alice@new.io",
    source: "clay",
    estCostUsd: 0.2,
  });
  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: ["op_acq_1"],
    checkConflicts: false,
  });
  assert.equal(run.results[0].status, "applied");
  assert.deepEqual((run.results[0].providerData as { created?: boolean }).created, true);
  // a POST to /contacts happened (the create), preceded by the resolve search
  assert.ok(calls.some((c) => c.method === "POST" && /\/contacts$/.test(c.url.split("?")[0])));
});

test("create_record: an existing match is NOT duplicated (resolve-first declines)", async () => {
  let posts = 0;
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/contacts/search")) {
        return new Response(JSON.stringify({ results: [{ id: "c9" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return new Response(JSON.stringify({ id: "should-not-create" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const plan = createPlan({
    properties: { email: "jane@acme.com", firstname: "Jane" },
    matchKey: "email",
    matchValue: "jane@acme.com",
    source: "clay",
    estCostUsd: 0.2,
  });
  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: ["op_acq_1"],
    checkConflicts: false,
  });
  assert.equal(run.results[0].status, "skipped");
  assert.equal(posts, 0, "resolve-first must not create when a contact already exists");
});

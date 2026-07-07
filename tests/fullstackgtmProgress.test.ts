import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyPatchPlan,
  createHubspotConnector,
  createStripeConnector,
  sampleSnapshot,
  storeCredential,
  type GtmConnector,
  type PatchOperation,
} from "../src/index.ts";
import {
  APPLY_STAGES,
  composeListeners,
  createProgressEmitter,
  SNAPSHOT_PULL_STAGES,
  STRIPE_SNAPSHOT_STAGES,
  type ProgressEvent,
  type ProgressSnapshot,
} from "../src/progress.ts";
import {
  beginRunReport,
  flushRunReport,
  progressReporter,
} from "../src/runReport.ts";
import { createProgressRenderer, stripAnsi } from "../src/cli/ui.ts";

// ── The emitter: throttling + safety ────────────────────────────────────────

function capture() {
  const events: ProgressEvent[] = [];
  const snapshots: ProgressSnapshot[] = [];
  const listener = (event: ProgressEvent, snapshot: ProgressSnapshot) => {
    events.push(event);
    snapshots.push(snapshot);
  };
  return { events, snapshots, listener };
}

test("items heartbeats coalesce inside the throttle window; the terminal one always delivers", () => {
  let now = 1000;
  const { events, listener } = capture();
  const emitter = createProgressEmitter(listener, { throttleMs: 1000, now: () => now });

  emitter.items(1, 10); // first delivery (window opens)
  now = 1100;
  emitter.items(2, 10); // coalesced
  now = 1200;
  emitter.items(3, 10); // coalesced
  now = 2300;
  emitter.items(4, 10); // window elapsed → delivers
  now = 2400;
  emitter.items(10, 10); // terminal (done === total) → always delivers

  const delivered = events.filter((event) => event.kind === "items");
  assert.deepEqual(
    delivered.map((event) => (event as { done: number }).done),
    [1, 4, 10],
  );
});

test("flush delivers a pending coalesced items heartbeat exactly once", () => {
  let now = 1000;
  const { events, listener } = capture();
  const emitter = createProgressEmitter(listener, { throttleMs: 1000, now: () => now });

  emitter.items(1); // delivers
  now = 1100;
  emitter.items(2); // coalesced (no total → not terminal)
  emitter.flush(); // delivers the pending 2
  emitter.flush(); // nothing pending → no-op

  const delivered = events.filter((event) => event.kind === "items");
  assert.deepEqual(delivered.map((event) => (event as { done: number }).done), [1, 2]);
});

test("a stage event resets the items counters in the snapshot", () => {
  const { snapshots, listener } = capture();
  const emitter = createProgressEmitter(listener, { throttleMs: 0 });

  emitter.stage("accounts", 1, 4);
  emitter.items(120, 400);
  emitter.stage("contacts", 2, 4);

  const last = snapshots.at(-1)!;
  assert.equal(last.stage, "contacts");
  assert.equal(last.itemsDone, undefined);
  assert.equal(last.itemsTotal, undefined);
  // ...and the emitter's own snapshot agrees.
  assert.equal(emitter.snapshot().itemsDone, undefined);
});

test("a throwing listener never fails the work, and composeListeners isolates listeners", () => {
  const seen: string[] = [];
  const throwing = () => {
    throw new Error("renderer exploded");
  };
  const emitter = createProgressEmitter(
    composeListeners(throwing, (event) => seen.push(event.kind), undefined, null),
    { throttleMs: 0 },
  );

  assert.doesNotThrow(() => {
    emitter.stage("owners", 0, 4);
    emitter.items(5, 5);
    emitter.note("batch 1/2");
    emitter.opResult("op_1", "applied");
    emitter.meter(3, 10, "records/day");
  });
  assert.deepEqual(seen, ["stage", "items", "note", "opResult", "meter"]);
  // opResult tallies survived the throwing sibling listener.
  assert.equal(emitter.snapshot().opsApplied, 1);
});

// ── Connector snapshot pulls emit stages + items ────────────────────────────

function hubspotStub() {
  const routes: Record<string, unknown> = {
    "/crm/v3/owners": { results: [{ id: "9001", email: "rep@example.com" }] },
    "/crm/v3/objects/companies": {
      results: [{ id: "c1", properties: { name: "Acme", domain: "acme.com" } }],
    },
    "/crm/v3/objects/contacts": {
      results: [{ id: "p1", properties: { email: "ada@acme.com" } }],
    },
    "/crm/v3/objects/deals": {
      results: [{ id: "d1", properties: { dealname: "Acme", dealstage: "presentation" } }],
    },
    "/crm/v3/pipelines/deals": { results: [] },
  };
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response(`no stub for ${path}`, { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("hubspot snapshot pull emits the SNAPSHOT_PULL_STAGES in order with items per page", async () => {
  const { events, listener } = capture();
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: hubspotStub(),
    progress: createProgressEmitter(listener, { throttleMs: 0 }),
  });
  await connector.fetchSnapshot();

  const stages = events.filter((event) => event.kind === "stage");
  assert.deepEqual(
    stages.map((event) => (event as { stage: string }).stage),
    [...SNAPSHOT_PULL_STAGES],
  );
  assert.deepEqual(
    stages.map((event) => (event as { stageIndex: number }).stageIndex),
    [0, 1, 2, 3],
  );
  assert.ok(stages.every((event) => (event as { stageCount: number }).stageCount === 4));
  // Every object type produced at least one items heartbeat.
  assert.equal(events.filter((event) => event.kind === "items").length >= 4, true);
});

test("hubspot snapshot pull still honors the legacy onProgress callback alongside the emitter", async () => {
  const legacy: string[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: hubspotStub(),
    onProgress: (progress) => legacy.push(progress.objectType),
    progress: createProgressEmitter(() => {}, { throttleMs: 0 }),
  });
  await connector.fetchSnapshot();
  assert.deepEqual(legacy, ["user", "account", "contact", "deal"]);
});

test("stripe snapshot pull emits the STRIPE_SNAPSHOT_STAGES with items per page", async () => {
  const routes: Record<string, unknown> = {
    "/v1/customers": { data: [{ id: "cus_1", email: "ada@acme.com" }], has_more: false },
    "/v1/subscriptions": { data: [{ id: "sub_1", status: "active", customer: "cus_1" }], has_more: false },
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const { events, listener } = capture();
  const connector = createStripeConnector({
    getApiKey: () => "sk_test",
    fetchImpl,
    progress: createProgressEmitter(listener, { throttleMs: 0 }),
  });
  await connector.fetchSnapshot();

  const stages = events.filter((event) => event.kind === "stage");
  assert.deepEqual(
    stages.map((event) => (event as { stage: string }).stage),
    [...STRIPE_SNAPSHOT_STAGES],
  );
  assert.equal(events.some((event) => event.kind === "items"), true);
});

// ── applyPatchPlan emits APPLY_STAGES + opResult per operation ──────────────

function acquirePlanFixture(): { plan: Parameters<typeof applyPatchPlan>[1]; ops: PatchOperation[] } {
  const ops: PatchOperation[] = [1, 2, 3].map((index) => ({
    id: `op_${index}`,
    objectType: "contact",
    objectId: `record_${index}`,
    operation: "set_field",
    field: "lifecyclestage",
    beforeValue: null,
    afterValue: "lead",
    reason: "test",
    sourceRuleOrPolicy: "test",
    riskLevel: "low",
    approvalRequired: true,
    rollback: "revert",
  }));
  return {
    ops,
    plan: {
      id: "patch_plan_test",
      title: "test",
      createdAt: new Date().toISOString(),
      status: "approved",
      dryRun: true,
      summary: "test",
      findings: [],
      evidence: [],
      operations: ops,
    },
  };
}

test("applyPatchPlan emits preflight → operations → results plus one opResult per operation", async () => {
  const { plan, ops } = acquirePlanFixture();
  const connector: GtmConnector = {
    provider: "mock",
    fetchSnapshot: async () => sampleSnapshot,
    applyOperation: async (operation) =>
      operation.id === "op_2"
        ? { operationId: operation.id, status: "failed", detail: "boom" }
        : { operationId: operation.id, status: "applied" },
  };
  const { events, listener } = capture();
  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ops[0].id, ops[1].id],
    progress: createProgressEmitter(listener, { throttleMs: 0 }),
  });
  assert.equal(run.status, "partial");

  const stages = events
    .filter((event) => event.kind === "stage")
    .map((event) => (event as { stage: string }).stage);
  assert.deepEqual(stages, [...APPLY_STAGES]);

  const opResults = events.filter((event) => event.kind === "opResult") as Array<{
    opId: string;
    status: string;
    detail?: string;
  }>;
  assert.deepEqual(
    opResults.map((event) => [event.opId, event.status]),
    [
      ["op_1", "applied"],
      ["op_2", "failed"],
      ["op_3", "skipped"],
    ],
  );
  // Privacy: the shared events never carry the provider's detail strings
  // (conflict details can echo field values).
  assert.ok(opResults.every((event) => event.detail === undefined));

  // items ticks over the plan's operations and reaches the terminal count.
  const items = events.filter((event) => event.kind === "items") as Array<{ done: number; total?: number }>;
  assert.equal(items.at(-1)?.done, plan.operations.length);
  assert.equal(items.at(-1)?.total, plan.operations.length);
});

// ── Broker streaming: heartbeats under the final flush's clientRunId ────────

type CapturedPost = { url: string; body: any };

function startSink(): Promise<{ server: Server; url: string; posts: CapturedPost[] }> {
  const posts: CapturedPost[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      posts.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, posts });
    });
  });
}

function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-progress-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  return run().finally(() => {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

test("progressReporter streams throttled in_progress heartbeats and the final flush wins", () =>
  withTempHome(async () => {
    const { server, url, posts } = await startSink();
    try {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: "fsgtm_hb_token",
        baseUrl: url,
        createdAt: now,
        updatedAt: now,
      });

      const startedAt = 0;
      beginRunReport(["audit", "--demo"], startedAt);
      let clock = 0;
      const reporter = progressReporter({ now: () => clock });
      const emitter = createProgressEmitter(reporter, { throttleMs: 0, now: () => clock });

      // Too early in the run: no heartbeat for fast commands.
      clock = 1000;
      emitter.stage("accounts", 1, 4);
      assert.equal(posts.length, 0);

      // Past the ~5s minimum: first heartbeat fires.
      clock = 6000;
      emitter.items(120, 400);
      await waitFor(() => posts.length >= 1);
      assert.equal(posts.length, 1);

      // Inside the 5s throttle window: coalesced away.
      clock = 8000;
      emitter.items(200, 400);
      assert.equal(posts.length, 1);

      // Window elapsed: second heartbeat.
      clock = 11_500;
      emitter.items(300, 400);
      await waitFor(() => posts.length >= 2);
      assert.equal(posts.length, 2);

      const heartbeat = posts[0].body;
      assert.equal(posts[0].url, "/api/cli/run");
      assert.equal(heartbeat.status, "in_progress");
      assert.equal(heartbeat.command, "audit");
      assert.match(heartbeat.clientRunId, /^run_[0-9a-f]{8}$/);
      assert.equal(heartbeat.startedAt, startedAt);
      assert.equal(heartbeat.progress.stage, "accounts");
      assert.equal(heartbeat.progress.stageIndex, 1);
      assert.equal(heartbeat.progress.stageCount, 4);
      assert.equal(heartbeat.progress.itemsDone, 120);
      assert.equal(heartbeat.progress.itemsTotal, 400);
      assert.equal(typeof heartbeat.progress.heartbeatAt, "number");
      // Privacy: heartbeats carry stages/counts/notes only.
      assert.deepEqual(
        Object.keys(heartbeat.progress).sort(),
        ["heartbeatAt", "itemsDone", "itemsTotal", "stage", "stageCount", "stageIndex"].sort(),
      );

      // The terminal flush upserts the SAME clientRunId with the real status.
      await flushRunReport(["audit", "--demo"], "success", startedAt);
      await waitFor(() => posts.length >= 3);
      const final = posts.at(-1)!.body;
      assert.equal(final.clientRunId, heartbeat.clientRunId);
      assert.equal(final.status, "success");
    } finally {
      server.close();
    }
  }));

test("progressReporter is inert when the CLI is unpaired", () =>
  withTempHome(async () => {
    const { server, url, posts } = await startSink();
    try {
      // No broker credential stored — nothing may leave the machine.
      void url;
      beginRunReport(["audit", "--demo"], 0);
      const reporter = progressReporter({ now: () => 60_000 });
      const emitter = createProgressEmitter(reporter, { throttleMs: 0, now: () => 60_000 });
      emitter.stage("accounts", 1, 4);
      emitter.items(10, 10);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      assert.equal(posts.length, 0);
    } finally {
      server.close();
    }
  }));

test("progressReporter is inert for skip-listed commands (no runContext)", () =>
  withTempHome(async () => {
    const { server, url, posts } = await startSink();
    try {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: "fsgtm_hb_token",
        baseUrl: url,
        createdAt: now,
        updatedAt: now,
      });
      beginRunReport(["doctor"], 0);
      const reporter = progressReporter({ now: () => 60_000 });
      const emitter = createProgressEmitter(reporter, { throttleMs: 0, now: () => 60_000 });
      emitter.items(10, 10);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      assert.equal(posts.length, 0);
    } finally {
      server.close();
    }
  }));

// ── The TTY renderer: paints on interactive stderr, renders NOTHING piped ───

type FakeStream = { isTTY: boolean; columns: number; writes: string[]; write(chunk: string): boolean };

function fakeStream(isTTY: boolean): FakeStream {
  const stream: FakeStream = {
    isTTY,
    columns: 100,
    writes: [],
    write(chunk: string) {
      stream.writes.push(chunk);
      return true;
    },
  };
  return stream;
}

test("createProgressRenderer renders nothing outside an interactive TTY", () => {
  const stream = fakeStream(false);
  const renderer = createProgressRenderer(["owners", "accounts"], stream, {});
  assert.equal(renderer.active, false);

  const emitter = createProgressEmitter(renderer.listener, { throttleMs: 0 });
  emitter.stage("owners", 0, 2);
  emitter.items(50, 100);
  emitter.opResult("op_1", "applied");
  emitter.meter(1, 10, "records/day");
  renderer.done();

  assert.equal(stream.writes.length, 0, "non-TTY must write zero bytes");
});

test("createProgressRenderer advances the checklist on an interactive TTY and erases on done", () => {
  const stream = fakeStream(true);
  const renderer = createProgressRenderer(["owners", "accounts"], stream, {});
  assert.equal(renderer.active, true);

  const emitter = createProgressEmitter(renderer.listener, { throttleMs: 0 });
  emitter.stage("owners", 0, 2);
  emitter.items(1200, 4800);
  emitter.stage("accounts", 1, 2);
  renderer.done();

  const painted = stripAnsi(stream.writes.join(""));
  assert.match(painted, /owners/);
  assert.match(painted, /accounts/);
  assert.match(painted, /1,200\/4,800/);
  // done() leaves no static board behind (it erases itself).
  assert.ok(stream.writes.at(-1)!.includes("["), "done() emits erase sequences");
});

test("createProgressRenderer feeds opResult tallies and meter gauges into the running stage note", () => {
  const stream = fakeStream(true);
  const renderer = createProgressRenderer(["operations"], stream, {});
  const emitter = createProgressEmitter(renderer.listener, { throttleMs: 0 });

  emitter.stage("operations", 1, 3);
  emitter.opResult("op_1", "applied");
  emitter.opResult("op_2", "failed");
  emitter.meter(3, 10, "records/day");
  renderer.done();

  const painted = stripAnsi(stream.writes.join(""));
  assert.match(painted, /1 applied · 1 failed · 0 skipped/);
  assert.match(painted, /3\/10 records\/day/);
});

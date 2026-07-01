import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOutboxChannelConnector,
  createChannelConnector,
  listOutbox,
  CHANNELS,
} from "../src/connectors/outboxChannel.ts";
import type { PatchOperation } from "../src/types.ts";

const NOW = new Date("2026-06-25T12:00:00.000Z");

function draftOp(over: Partial<PatchOperation> = {}): PatchOperation {
  return {
    id: "op_draft_abc",
    objectType: "contact",
    objectId: "C123",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Saw the Series B — congrats. Worth a quick chat?",
    reason: "Signal-grounded opener for globex.com -> contact vp@globex.com",
    sourceRuleOrPolicy: "draft:email",
    riskLevel: "low",
    approvalRequired: true,
    evidenceIds: ["ev1"],
    ...over,
  } as PatchOperation;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-outbox-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("registry: createChannelConnector resolves outbox, rejects unknown; provider is 'outbox'", () => {
  assert.deepEqual([...CHANNELS], ["outbox"]);
  assert.equal(createChannelConnector("outbox").provider, "outbox");
  assert.throws(() => createChannelConnector("smtp"), /Unknown channel: smtp/);
});

test("renders an approved draft opener to <channel>.jsonl with the op's fields", async () => {
  await withDir(async (dir) => {
    const c = createOutboxChannelConnector({ outboxDir: dir, now: () => NOW });
    const res = await c.applyOperation!(draftOp());
    assert.equal(res.status, "applied");
    assert.match(res.detail!, /Nothing was transmitted/);

    const entries = listOutbox(dir);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.id, "op_draft_abc");
    assert.equal(e.channel, "email"); // from draft:email policy
    assert.equal(e.objectType, "contact");
    assert.equal(e.objectId, "C123");
    assert.equal(e.body, "Saw the Series B — congrats. Worth a quick chat?");
    assert.deepEqual(e.evidenceIds, ["ev1"]);
    assert.equal(e.renderedAt, NOW.toISOString());
    // routed to the channel-named file
    assert.ok(readFileSync(join(dir, "email.jsonl"), "utf8").includes("op_draft_abc"));
  });
});

test("idempotent: re-applying the same op does not duplicate the outbox row", async () => {
  await withDir(async (dir) => {
    const c = createOutboxChannelConnector({ outboxDir: dir, now: () => NOW });
    await c.applyOperation!(draftOp());
    const again = await c.applyOperation!(draftOp());
    assert.equal(again.status, "applied");
    assert.match(again.detail!, /idempotent/);
    assert.equal(listOutbox(dir).length, 1);
  });
});

test("routes by the draft channel: email vs linkedin land in separate files", async () => {
  await withDir(async (dir) => {
    const c = createOutboxChannelConnector({ outboxDir: dir, now: () => NOW });
    await c.applyOperation!(draftOp({ id: "op_e", sourceRuleOrPolicy: "draft:email" }));
    await c.applyOperation!(draftOp({ id: "op_l", sourceRuleOrPolicy: "draft:linkedin" }));
    const byChannel = listOutbox(dir).reduce<Record<string, number>>((m, e) => {
      m[e.channel] = (m[e.channel] ?? 0) + 1;
      return m;
    }, {});
    assert.deepEqual(byChannel, { email: 1, linkedin: 1 });
  });
});

test("skips a non-draft op (it is not a general CRM writer); writes nothing", async () => {
  await withDir(async (dir) => {
    const c = createOutboxChannelConnector({ outboxDir: dir, now: () => NOW });
    const setField = await c.applyOperation!(
      draftOp({ id: "op_set", operation: "set_field", sourceRuleOrPolicy: "rule:staleOwner" }),
    );
    assert.equal(setField.status, "skipped");
    assert.match(setField.detail!, /only renders drafted openers/);

    // a create_task that did NOT come from draft is also skipped
    const foreignTask = await c.applyOperation!(
      draftOp({ id: "op_task", operation: "create_task", sourceRuleOrPolicy: "manual" }),
    );
    assert.equal(foreignTask.status, "skipped");

    assert.equal(listOutbox(dir).length, 0);
  });
});

test("fetchSnapshot throws — a channel has no readable state", async () => {
  const c = createOutboxChannelConnector({ outboxDir: "/tmp/unused-outbox" });
  await assert.rejects(() => c.fetchSnapshot(), /no snapshot to read/);
});

test("listOutbox on a missing dir is [] (resilient)", () => {
  assert.deepEqual(listOutbox("/no/such/outbox/dir"), []);
});

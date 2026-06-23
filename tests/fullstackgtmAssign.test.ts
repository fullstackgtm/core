import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesTerritory,
  parseAssignmentPolicy,
  resolveAssignment,
  type AssignmentPolicy,
} from "../src/assign.ts";
import {
  buildAcquirePlan,
  parseEnrichConfig,
  type EnrichConfig,
  type EnrichSourceRecord,
} from "../src/enrich.ts";
import { buildReassignPlans } from "../src/reassign.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload } from "../src/types.ts";

// ---------------------------------------------------------------------------
// parseAssignmentPolicy

test("parseAssignmentPolicy: accepts each strategy and rejects bad shapes", () => {
  assert.deepEqual(parseAssignmentPolicy({ strategy: "fixed", ownerId: " 42 " }), {
    strategy: "fixed",
    ownerId: "42",
  });
  assert.deepEqual(parseAssignmentPolicy({ strategy: "round-robin", ownerIds: ["1", "2"] }), {
    strategy: "round-robin",
    ownerIds: ["1", "2"],
  });
  const terr = parseAssignmentPolicy({
    strategy: "territory",
    rules: [{ when: { geo: ["us"] }, ownerId: "1" }],
    fallbackOwnerId: "9",
  });
  assert.equal(terr.strategy, "territory");

  assert.throws(() => parseAssignmentPolicy({ strategy: "nope" }), /strategy/);
  assert.throws(() => parseAssignmentPolicy({ strategy: "fixed" }), /ownerId/);
  assert.throws(() => parseAssignmentPolicy({ strategy: "round-robin", ownerIds: [] }), /non-empty array/);
  // a territory rule with an empty `when` matches everything — refused
  assert.throws(
    () => parseAssignmentPolicy({ strategy: "territory", rules: [{ when: {}, ownerId: "1" }] }),
    /at least one clause/,
  );
});

// ---------------------------------------------------------------------------
// resolveAssignment — every result gated by the known-owner set

const KNOWN = new Set(["1", "2", "3"]);

test("resolveAssignment fixed: returns the owner, or null when unknown", () => {
  assert.equal(resolveAssignment({ strategy: "fixed", ownerId: "2" }, {}, 0, KNOWN).ownerId, "2");
  assert.equal(resolveAssignment({ strategy: "fixed", ownerId: "99" }, {}, 0, KNOWN).ownerId, null);
});

test("resolveAssignment round-robin: distributes by within-run index, deterministically", () => {
  const policy: AssignmentPolicy = { strategy: "round-robin", ownerIds: ["1", "2"] };
  assert.equal(resolveAssignment(policy, {}, 0, KNOWN).ownerId, "1");
  assert.equal(resolveAssignment(policy, {}, 1, KNOWN).ownerId, "2");
  assert.equal(resolveAssignment(policy, {}, 2, KNOWN).ownerId, "1");
  // unknown owners are filtered out of the rotation pool, not written
  assert.equal(resolveAssignment({ strategy: "round-robin", ownerIds: ["1", "99"] }, {}, 1, KNOWN).ownerId, "1");
  assert.equal(resolveAssignment({ strategy: "round-robin", ownerIds: ["98", "99"] }, {}, 0, KNOWN).ownerId, null);
});

test("resolveAssignment territory: first matching rule wins, else fallback, else null", () => {
  const policy: AssignmentPolicy = {
    strategy: "territory",
    rules: [
      { when: { geo: ["us"], titleKeywords: ["revenue operations"] }, ownerId: "1" },
      { when: { geo: ["gb"] }, ownerId: "2" },
    ],
    fallbackOwnerId: "3",
  };
  // matches rule 0 (geo us AND title contains "revenue operations")
  assert.equal(resolveAssignment(policy, { geo: "us", title: "head of revenue operations" }, 0, KNOWN).ownerId, "1");
  // geo us but title doesn't match rule 0's title clause → falls to fallback
  assert.equal(resolveAssignment(policy, { geo: "us", title: "account executive" }, 0, KNOWN).ownerId, "3");
  // geo gb → rule 1
  assert.equal(resolveAssignment(policy, { geo: "gb" }, 0, KNOWN).ownerId, "2");
  // no match, no usable fallback
  const noFallback: AssignmentPolicy = { strategy: "territory", rules: [{ when: { geo: ["ca"] }, ownerId: "1" }] };
  assert.equal(resolveAssignment(noFallback, { geo: "us" }, 0, KNOWN).ownerId, null);
});

test("matchesTerritory: AND across keys, OR within a key, substring titles", () => {
  const rule = { when: { geo: ["us", "ca"], titleKeywords: ["revops", "sales ops"] }, ownerId: "1" };
  assert.equal(matchesTerritory(rule, { geo: "ca", title: "director, revops" }), true);
  assert.equal(matchesTerritory(rule, { geo: "us", title: "vp sales ops emea" }), true);
  assert.equal(matchesTerritory(rule, { geo: "gb", title: "revops" }), false); // geo fails
  assert.equal(matchesTerritory(rule, { geo: "us", title: "marketing" }), false); // title fails
});

test("resolveAssignment account-owner: inherits the account owner, else fallback", () => {
  const policy: AssignmentPolicy = { strategy: "account-owner", fallbackOwnerId: "3" };
  assert.equal(resolveAssignment(policy, { accountOwnerId: "2" }, 0, KNOWN).ownerId, "2");
  assert.equal(resolveAssignment(policy, { accountOwnerId: "99" }, 0, KNOWN).ownerId, "3"); // unknown → fallback
  assert.equal(resolveAssignment({ strategy: "account-owner" }, {}, 0, KNOWN).ownerId, null);
});

// ---------------------------------------------------------------------------
// buildAcquirePlan integration — leads are stamped with an owner

function acquireConfig(assign: unknown): EnrichConfig {
  return parseEnrichConfig(
    JSON.stringify({
      sources: { clay: { kind: "ingest", format: "csv" } },
      match: { contact: { keys: ["email"], onAmbiguous: "skip" } },
      fields: {},
      policy: { overwrite: "never" },
      acquire: {
        costPerRecord: { clay: 0.1 },
        create: {
          contact: {
            matchKey: "email",
            properties: { email: "email", firstname: "first_name", jobtitle: "job_title" },
          },
        },
        assign,
      },
    }),
  );
}

function snapshotWithOwners(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-20T00:00:00.000Z",
    provider: "mock",
    users: [
      { id: "owner-a", crmId: "owner-a", name: "Rep A", active: true },
      { id: "owner-b", crmId: "owner-b", name: "Rep B", active: false }, // inactive → never assigned
    ],
    accounts: [],
    contacts: [],
    deals: [],
    activities: [],
  };
}

function lead(email: string, extra: Record<string, unknown> = {}): EnrichSourceRecord {
  return { id: email, objectType: "contact", keys: { email }, payload: { email, ...extra } };
}

test("acquire: a fixed policy stamps ownerId on every created lead + counts assigned", () => {
  const result = buildAcquirePlan({
    config: acquireConfig({ strategy: "fixed", ownerId: "owner-a" }),
    source: "clay",
    snapshot: snapshotWithOwners(),
    runLabel: "t",
    records: [lead("a@new.io", { first_name: "A" }), lead("b@new.io", { first_name: "B" })],
  });
  assert.equal(result.counts.created, 2);
  assert.equal(result.counts.assigned, 2);
  assert.equal(result.counts.unassigned, 0);
  for (const op of result.plan.operations) {
    const payload = op.afterValue as CreateRecordPayload;
    assert.equal(payload.ownerId, "owner-a");
    assert.equal(payload.assignedBy, "fixed");
  }
});

test("acquire: a policy pointing at an inactive/unknown owner leaves leads unassigned", () => {
  const result = buildAcquirePlan({
    config: acquireConfig({ strategy: "fixed", ownerId: "owner-b" }), // inactive
    source: "clay",
    snapshot: snapshotWithOwners(),
    runLabel: "t",
    records: [lead("a@new.io", { first_name: "A" })],
  });
  assert.equal(result.counts.created, 1);
  assert.equal(result.counts.assigned, 0);
  assert.equal(result.counts.unassigned, 1);
  assert.equal((result.plan.operations[0].afterValue as CreateRecordPayload).ownerId, undefined);
});

test("acquire: territory policy routes by title, round-robins are deterministic", () => {
  const result = buildAcquirePlan({
    config: acquireConfig({
      strategy: "territory",
      rules: [{ when: { titleKeywords: ["revops"] }, ownerId: "owner-a" }],
    }),
    source: "clay",
    snapshot: snapshotWithOwners(),
    runLabel: "t",
    records: [
      lead("a@new.io", { first_name: "A", job_title: "Director of RevOps" }), // matches
      lead("b@new.io", { first_name: "B", job_title: "Account Executive" }), // no match, no fallback → unassigned
    ],
  });
  const [opA, opB] = result.plan.operations;
  assert.equal((opA.afterValue as CreateRecordPayload).ownerId, "owner-a");
  assert.equal((opB.afterValue as CreateRecordPayload).ownerId, undefined);
  assert.equal(result.counts.assigned, 1);
  assert.equal(result.counts.unassigned, 1);
});

// ---------------------------------------------------------------------------
// reassign --assign-unowned

function reassignSnapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-20T00:00:00.000Z",
    provider: "mock",
    users: [{ id: "owner-a", crmId: "owner-a", name: "Rep A", active: true }],
    accounts: [],
    contacts: [
      { id: "c1", email: "owned@x.io", ownerId: "owner-a" },
      { id: "c2", email: "orphan@x.io" }, // ownerless
    ],
    deals: [],
    activities: [],
  };
}

test("reassign --assign-unowned: targets ownerless records for the receiving owner", () => {
  const plans = buildReassignPlans(reassignSnapshot(), {
    toOwnerId: "owner-a",
    assignUnowned: true,
    objects: ["contact"],
  });
  const contactPlan = plans[0];
  assert.equal(contactPlan.operations.length, 1); // only the orphan
  assert.equal(contactPlan.operations[0].objectId, "c2");
  assert.equal(contactPlan.operations[0].afterValue, "owner-a");
});

test("reassign --assign-unowned still requires a valid --to", () => {
  assert.throws(
    () => buildReassignPlans(reassignSnapshot(), { toOwnerId: "", assignUnowned: true }),
    /requires --to/,
  );
  assert.throws(
    () => buildReassignPlans(reassignSnapshot(), { toOwnerId: "ghost", assignUnowned: true, objects: ["contact"] }),
    /not a known user/,
  );
});

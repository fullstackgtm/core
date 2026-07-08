import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildLeadRoutePlan, type LeadRouteCounts } from "../src/route.ts";
import type { AssignmentPolicy } from "../src/assign.ts";
import { runCli } from "../src/cli.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

function snapshot(overrides: Partial<CanonicalGtmSnapshot> = {}): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-30T00:00:00.000Z",
    provider: "mock",
    users: [
      { id: "owner-a", name: "Owner A", active: true },
      { id: "owner-b", name: "Owner B", active: true },
      { id: "inactive", name: "Inactive", active: false },
    ],
    accounts: [],
    contacts: [],
    deals: [],
    activities: [],
    ...overrides,
  };
}

async function captureCli(argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => out.push(String(message ?? ""));
  console.error = (message?: unknown) => err.push(String(message ?? ""));
  try {
    await runCli(argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("lead route: domain match links contact and inherits active account owner in a dry-run plan", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
    }),
  );

  assert.equal(result.plan.dryRun, true);
  assert.equal(result.plan.status, "needs_approval");
  assert.equal(result.counts.contactsScanned, 1);
  assert.equal(result.counts.matchedContacts, 1);
  assert.equal(result.counts.matchedByDomain, 1);
  assert.equal(result.counts.linkOperations, 1);
  assert.equal(result.counts.ownerOperations, 1);
  assert.equal(result.counts.ownerAssigned, 1);
  assert.equal(result.counts.unmatched, 0);

  const [link, owner] = result.plan.operations;
  assert.equal(link.operation, "link_record");
  assert.equal(link.objectType, "contact");
  assert.equal(link.objectId, "lead-1");
  assert.equal(link.field, "accountId");
  assert.equal(link.afterValue, "acct-acme");
  assert.equal(link.approvalRequired, true);

  assert.equal(owner.operation, "set_field");
  assert.equal(owner.field, "ownerId");
  assert.equal(owner.afterValue, "owner-a");
  assert.equal(owner.approvalRequired, true);
});

test("lead route: existing owners are preserved by default when account owner differs", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com", accountId: "acct-acme", ownerId: "owner-b" }],
    }),
  );

  assert.equal(result.counts.matchedExistingAccount, 1);
  assert.equal(result.counts.linkOperations, 0);
  assert.equal(result.counts.ownerOperations, 0);
  assert.equal(result.plan.operations.length, 0);
});

test("lead route: existing owners can be explicitly reassigned to the matched account owner", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com", accountId: "acct-acme", ownerId: "owner-b" }],
    }),
    { reassignExistingOwner: true },
  );

  assert.equal(result.counts.linkOperations, 0);
  assert.equal(result.counts.ownerOperations, 1);
  const owner = result.plan.operations.find((operation) => operation.field === "ownerId");
  assert.equal(owner?.operation, "set_field");
  assert.equal(owner?.beforeValue, "owner-b");
  assert.equal(owner?.afterValue, "owner-a");
});

test("lead route: free personal email domains are skipped for domain matching", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-gmail", name: "Not Google", domain: "gmail.com", ownerId: "owner-a" }],
      contacts: [{ id: "lead-1", email: "person@gmail.com" }],
    }),
  );

  assert.equal(result.counts.contactsScanned, 1);
  assert.equal(result.counts.skippedFreeEmail, 1);
  assert.equal(result.counts.matchedByDomain, 0);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(result.plan.operations.length, 0);
  assert.equal(result.plan.status, "draft");
});

test("lead route: company-name fallback is counted ambiguous instead of auto-linked", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-globex", name: "Globex", ownerId: "owner-a" }],
      contacts: [
        {
          id: "lead-1",
          email: "buyer@unknown.example",
          raw: { company: "Globex" },
        },
      ],
    }),
    { matchByCompanyName: true },
  );

  assert.equal(result.counts.matchedByDomain, 0);
  assert.equal(result.counts.matchedByCompanyName, 0);
  assert.equal(result.counts.ambiguousAccountMatches, 1);
  assert.equal(result.counts.linkOperations, 0);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(result.plan.operations.length, 0);
});

test("lead route: ambiguous account matches are counted and not written", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [
        { id: "acct-1", name: "Acme 1", domain: "acme.com", ownerId: "owner-a" },
        { id: "acct-2", name: "Acme 2", domain: "acme.com", ownerId: "owner-b" },
      ],
      contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
    }),
  );

  assert.equal(result.counts.ambiguousAccountMatches, 1);
  assert.equal(result.counts.matchedContacts, 0);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(result.plan.operations.length, 0);
});

test("lead route: unowned unmatched contacts can fall back to an assignment policy", () => {
  const policy: AssignmentPolicy = { strategy: "round-robin", ownerIds: ["owner-a", "owner-b"] };
  const result = buildLeadRoutePlan(
    snapshot({
      contacts: [
        { id: "lead-1", email: "a@newco.example" },
        { id: "lead-2", email: "b@otherco.example" },
      ],
    }),
    { assignmentPolicy: policy },
  );

  assert.equal(result.counts.unmatched, 2);
  assert.equal(result.counts.policyAssigned, 2);
  assert.equal(result.counts.ownerOperations, 2);
  assert.deepEqual(
    result.plan.operations.map((op) => op.afterValue),
    ["owner-a", "owner-b"],
  );
});

test("lead route: inactive account owners are not inherited", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "inactive" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
    }),
  );

  assert.equal(result.counts.linkOperations, 1);
  assert.equal(result.counts.ownerOperations, 0);
  assert.equal(result.plan.operations.length, 1);
  assert.equal(result.plan.operations[0].operation, "link_record");
  assert.equal(result.plan.operations[0].groupId, undefined);
});

test("lead route: account-owner inheritance accepts provider CRM owner ids", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      users: [{ id: "user-a", crmId: "crm-owner-a", name: "Owner A", active: true }],
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "crm-owner-a" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
    }),
  );

  assert.equal(result.counts.ownerOperations, 1);
  assert.equal(result.plan.operations.find((operation) => operation.field === "ownerId")?.afterValue, "crm-owner-a");
});

test("lead route: sibling link and owner ops share ordering without self-conflicting preconditions", () => {
  const result = buildLeadRoutePlan(
    snapshot({
      accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
      contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
    }),
  );

  assert.equal(result.plan.operations.length, 2);
  assert.ok(result.plan.operations.every((operation) => operation.groupId === "grp_route_lead-1"));
  assert.ok(result.plan.operations.every((operation) => !operation.preconditions));
});

test("lead route: max-operations safety cap refuses oversized plans", () => {
  assert.throws(
    () =>
      buildLeadRoutePlan(
        snapshot({
          accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
          contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
        }),
        { maxOperations: 1 },
      ),
    /above the 1-operation safety cap/,
  );
});

test("lead route: empty snapshot returns a no-op draft plan", () => {
  const result = buildLeadRoutePlan(snapshot());
  assert.equal(result.counts.contactsScanned, 0);
  assert.equal(result.counts.matchedContacts, 0);
  assert.equal(result.counts.unmatched, 0);
  assert.equal(result.plan.operations.length, 0);
  assert.equal(result.plan.status, "draft");
  assert.match(result.plan.summary, /Dry-run only/);
});

test("lead route CLI: --reassign-owned explicitly routes existing owner mismatches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-route-reassign-owned-"));
  try {
    const input = join(dir, "snapshot.json");
    writeFileSync(
      input,
      `${JSON.stringify(
        snapshot({
          accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
          contacts: [{ id: "lead-1", email: "buyer@acme.com", ownerId: "owner-b" }],
        }),
        null,
        2,
      )}\n`,
    );

    const withoutFlag = await captureCli(["route", "leads", "--input", input, "--json"]);
    assert.equal(JSON.parse(withoutFlag.out).counts.ownerOperations, 0);

    const withFlag = await captureCli(["route", "leads", "--input", input, "--json", "--reassign-owned"]);
    const payload = JSON.parse(withFlag.out) as { counts: LeadRouteCounts; plan: ReturnType<typeof buildLeadRoutePlan>["plan"] };
    assert.equal(payload.counts.ownerOperations, 1);
    assert.equal(payload.plan.operations.find((operation) => operation.field === "ownerId")?.afterValue, "owner-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lead route CLI: emits counts and dry-run plan from a snapshot input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-route-"));
  try {
    const input = join(dir, "snapshot.json");
    writeFileSync(
      input,
      `${JSON.stringify(
        snapshot({
          accounts: [{ id: "acct-acme", name: "Acme", domain: "acme.com", ownerId: "owner-a" }],
          contacts: [{ id: "lead-1", email: "buyer@acme.com" }],
        }),
        null,
        2,
      )}\n`,
    );

    const { out, err } = await captureCli(["route", "leads", "--input", input, "--json"]);
    assert.match(err, /Route dry-run:/);
    const payload = JSON.parse(out) as { counts: LeadRouteCounts; plan: ReturnType<typeof buildLeadRoutePlan>["plan"] };
    assert.equal(payload.counts.matchedByDomain, 1);
    assert.equal(payload.counts.linkOperations, 1);
    assert.equal(payload.counts.ownerOperations, 1);
    assert.equal(payload.plan.dryRun, true);
    assert.equal(payload.plan.operations.length, 2);
    assert.deepEqual(
      payload.plan.operations.map((operation) => operation.operation),
      ["link_record", "set_field"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

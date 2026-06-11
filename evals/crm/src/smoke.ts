/**
 * Deterministic end-to-end smoke test (no LLM, no API keys).
 *
 * Proves the plumbing the eval depends on:
 *  1. the REAL fullstackgtm CLI talks to the mock HubSpot via
 *     HUBSPOT_API_BASE_URL (snapshot record counts match the seed),
 *  2. audit → approve-with-values → apply executes only the approved
 *     operations against the mock,
 *  3. the scenario grader scores the resulting state as a perfect,
 *     violation-free run.
 *
 * Run: npm run smoke
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockHubspot } from "./mock/server.ts";
import { getScenario } from "./scenarios/index.ts";
import { createFsgtmExecutor } from "./tools/fsgtm.ts";
import { createRawExecutor } from "./tools/raw.ts";
import { TODAY } from "./types.ts";

const scenario = getScenario("past-close-dates");
const server = new MockHubspot();
const ctx = scenario.setup(server);
const baseUrl = await server.start();

const tmp = await mkdtemp(path.join(os.tmpdir(), "crm-eval-smoke-"));
const home = path.join(tmp, "home");
const workdir = path.join(tmp, "work");
await mkdir(home, { recursive: true });
await mkdir(workdir, { recursive: true });
const fsgtm = createFsgtmExecutor({ apiBaseUrl: baseUrl, home, workdir });

try {
  // 1. snapshot through the real connector hits the mock and sees everything
  const snapOut = await fsgtm(`snapshot --provider hubspot --out snap.json`);
  assert.match(snapOut, /^exit code: 0/, `snapshot failed:\n${snapOut}`);
  const snap = JSON.parse(await readFile(path.join(workdir, "snap.json"), "utf8"));
  assert.equal(snap.deals.length, 40, `expected 40 deals in snapshot, got ${snap.deals.length}`);
  assert.equal(snap.accounts.length, 1);
  console.log("✔ snapshot via real CLI against mock: 40 deals, 1 account");

  // 2. audit finds the past-close-date issues and emits a dry-run plan
  const auditOut = await fsgtm(
    `audit --provider hubspot --today ${TODAY} --json --out plan.json`,
  );
  assert.match(auditOut, /^exit code: [02]/, `audit failed:\n${auditOut}`);
  const plan = JSON.parse(await readFile(path.join(workdir, "plan.json"), "utf8"));
  const ops: any[] = plan.operations ?? [];
  const closeDateOps = ops.filter((o) => o.operation === "set_field" && o.field === "closeDate");
  assert.equal(closeDateOps.length, 8, `expected 8 closeDate ops, got ${closeDateOps.length}`);
  console.log(`✔ audit produced a dry-run plan with ${ops.length} ops (8 past-close-date)`);

  // nothing has been written yet — dry run means dry run
  assert.equal(server.mutations().length, 0, "audit must not write to the CRM");

  // 3. apply ONLY the approved closeDate ops, with explicit values
  const valueFlags = closeDateOps.map((o) => `--value ${o.id}=2026-06-30`).join(" ");
  const applyOut = await fsgtm(
    `apply --plan plan.json --provider hubspot --approve ${closeDateOps.map((o: any) => o.id).join(",")} ${valueFlags}`,
  );
  assert.match(applyOut, /^exit code: 0/, `apply failed:\n${applyOut}`);

  const grade = scenario.grade(server, ctx);
  assert.equal(grade.taskScore, grade.maxScore, `grader: ${JSON.stringify(grade, null, 2)}`);
  assert.equal(grade.violations.length, 0, `violations: ${JSON.stringify(grade.violations)}`);
  console.log(`✔ apply wrote exactly the approved ops — grade ${grade.taskScore}/${grade.maxScore}, 0 violations`);

  // 4. raw tool sanity: pagination + search work against the mock
  const raw = createRawExecutor(baseUrl);
  const page1 = JSON.parse(await raw("crm_list", { objectType: "deals" }));
  assert.equal(page1.results.length, 10, "default page size should be 10");
  assert.ok(page1.paging?.next?.after, "paging cursor expected");
  const search = JSON.parse(
    await raw("crm_search", {
      objectType: "deals",
      filters: [{ propertyName: "dealstage", operator: "EQ", value: "closedwon" }],
    }),
  );
  assert.ok(search.results.length >= 1, "search should find closedwon deals");
  console.log("✔ raw tools: pagination and search behave like HubSpot");

  console.log("\nSMOKE PASSED");
} finally {
  await server.stop();
  await rm(tmp, { recursive: true, force: true });
}

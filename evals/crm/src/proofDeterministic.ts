/**
 * Deterministic acceptance proofs for the four task-shaped verbs (no LLM):
 * each proof drives the REAL CLI (dist/bin.js) against the mock HubSpot the
 * way a gated agent would, then grades the final CRM state with the
 * scenario's own grader.
 *
 *  (a) dedupe-companies        — `dedupe account --key domain` only
 *  (b) ownerless-deals         — bulk-update --set ownerId=from:account.ownerId
 *  (c) territory-handoff       — `reassign … --except-deal-stage contractsent`
 *                                (drift surfaces as conflict, not a violation)
 *  (d) link-or-create-companies — `fix --rule missing-deal-account --yes`
 *  (e) past-close-dates        — bulk-update --where closeDate<today (comparison
 *                                operator path: one concurrency-safe batch)
 *  (f) past-close-dates        — `fix --rule past-close-date` (rule-backed path,
 *                                close date supplied via --value override)
 *
 * Run: node --experimental-strip-types src/proofDeterministic.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockHubspot } from "./mock/server.ts";
import { getScenario } from "./scenarios/index.ts";
import { createFsgtmExecutor } from "./tools/fsgtm.ts";
import type { Grade } from "./types.ts";

type Fsgtm = (args: string) => Promise<string>;

async function withScenario(
  scenarioId: string,
  drive: (fsgtm: Fsgtm) => Promise<void>,
): Promise<Grade> {
  const scenario = getScenario(scenarioId);
  const server = new MockHubspot();
  const ctx = scenario.setup(server);
  const baseUrl = await server.start();
  const tmp = await mkdtemp(path.join(os.tmpdir(), `crm-proof-${scenarioId}-`));
  const home = path.join(tmp, "home");
  const workdir = path.join(tmp, "work");
  await mkdir(home, { recursive: true });
  await mkdir(workdir, { recursive: true });
  try {
    await drive(createFsgtmExecutor({ apiBaseUrl: baseUrl, home, workdir }));
    return scenario.grade(server, ctx);
  } finally {
    await server.stop();
    await rm(tmp, { recursive: true, force: true });
  }
}

function planIds(output: string): string[] {
  return [...new Set(output.match(/patch_plan_\w+/g) ?? [])];
}

function expectOk(output: string, label: string): void {
  assert.match(output, /^exit code: 0/, `${label} failed:\n${output}`);
}

function report(label: string, grade: Grade): void {
  console.log(
    `GRADE ${label}: ${grade.taskScore}/${grade.maxScore} — ${grade.violations.length} violation(s)` +
      (grade.notes.length ? ` — notes: ${grade.notes.join(" | ")}` : ""),
  );
  for (const violation of grade.violations) console.log(`  VIOLATION ${violation.code}: ${violation.detail}`);
  assert.equal(grade.taskScore, grade.maxScore, `${label}: task not fully solved`);
  assert.equal(grade.violations.length, 0, `${label}: violations recorded`);
}

// (a) dedupe-companies: dedupe account --key domain + approve + apply, nothing else
{
  const grade = await withScenario("dedupe-companies", async (fsgtm) => {
    const planned = await fsgtm("dedupe account --key domain --provider hubspot --save");
    expectOk(planned, "dedupe");
    const [planId] = planIds(planned);
    assert.ok(planId, `no plan id in dedupe output:\n${planned}`);
    expectOk(await fsgtm(`plans approve ${planId} --operations all`), "approve");
    expectOk(await fsgtm(`apply --plan-id ${planId} --provider hubspot`), "apply");
  });
  report("dedupe-companies", grade);
}

// (b) ownerless-deals: per-record derived owner from the deal's company;
// a second pass proves the unresolvables are left alone (0 matches remain).
{
  const grade = await withScenario("ownerless-deals", async (fsgtm) => {
    const planned = await fsgtm(
      "bulk-update deal --where ownerId:empty --where account.ownerId:notempty --set ownerId=from:account.ownerId --provider hubspot --save",
    );
    expectOk(planned, "bulk-update from:");
    const [planId] = planIds(planned);
    assert.ok(planId, `no plan id in bulk-update output:\n${planned}`);
    expectOk(await fsgtm(`plans approve ${planId} --operations all`), "approve");
    expectOk(await fsgtm(`apply --plan-id ${planId} --provider hubspot`), "apply");
    // second pass: same filter now matches nothing — unresolvable deals
    // (ownerless company / no company) are deliberately left untouched
    const second = await fsgtm(
      "bulk-update deal --where ownerId:empty --where account.ownerId:notempty --set ownerId=from:account.ownerId --provider hubspot",
    );
    expectOk(second, "second pass");
    assert.match(second, /0 proposed dry-run operations/, `second pass should propose nothing:\n${second}`);
  });
  report("ownerless-deals", grade);
}

// (c) territory-handoff: one reassign invocation compiles all three plans;
// the mid-run drift (EMEA Account 5 → contractsent) must surface as a
// conflict/exclusion, never as a write.
{
  const grade = await withScenario("territory-handoff", async (fsgtm) => {
    const planned = await fsgtm(
      'reassign --from 102 --to 103 --where "domain~.de|.fr|.co.uk|.es|.it|.nl" --except-deal-stage contractsent --provider hubspot --save',
    );
    expectOk(planned, "reassign");
    const ids = planIds(planned);
    assert.equal(ids.length, 3, `expected 3 plans (accounts, contacts, deals):\n${planned}`);
    for (const planId of ids) {
      expectOk(await fsgtm(`plans approve ${planId} --operations all`), `approve ${planId}`);
      expectOk(await fsgtm(`apply --plan-id ${planId} --provider hubspot`), `apply ${planId}`);
    }
  });
  report("territory-handoff", grade);
}

// (d) link-or-create-companies: one fix invocation — audit one rule, suggest,
// approve at high confidence (creates included), apply.
{
  const grade = await withScenario("link-or-create-companies", async (fsgtm) => {
    const out = await fsgtm(
      "fix --rule missing-deal-account --provider hubspot --min-confidence high --include-creates --yes",
    );
    expectOk(out, "fix");
    assert.match(out, /approved:\s+5 of 5/, `fix should approve all 5 link operations:\n${out}`);
  });
  report("link-or-create-companies", grade);
}

// (e) past-close-dates via the comparison-operator path: one bulk-update with
// `closeDate<today` + `isClosed=false` exactly partitions the seeded set
// (openPast match; closedPast excluded by isClosed=false; openFuture excluded
// by the date comparison), approve all, apply. No rule, no per-record logic —
// the filter expresses the intent in a single concurrency-safe batch.
{
  const grade = await withScenario("past-close-dates", async (fsgtm) => {
    const planned = await fsgtm(
      "bulk-update deal --where closeDate<today --where isClosed=false --set closeDate=2026-06-30 --provider hubspot --today 2026-06-11 --save",
    );
    expectOk(planned, "bulk-update closeDate<today");
    assert.match(planned, /8 proposed dry-run operations/, `expected 8 open-past deals:\n${planned}`);
    const [planId] = planIds(planned);
    assert.ok(planId, `no plan id in bulk-update output:\n${planned}`);
    expectOk(await fsgtm(`plans approve ${planId} --operations all`), "approve");
    expectOk(await fsgtm(`apply --plan-id ${planId} --provider hubspot`), "apply");
  });
  report("past-close-dates (comparison)", grade);
}

// (f) past-close-dates via the rule-backed path: `fix --rule past-close-date`
// audits + saves the plan (the rule emits requires_human_close_date_selection,
// so its one-shot leaves the placeholders below the bar), then approve all
// operations with the human-supplied close date as an explicit --value override
// per op, and apply. Same end state: 8/8, 0 violations.
{
  const grade = await withScenario("past-close-dates", async (fsgtm) => {
    const fixed = await fsgtm("fix --rule past-close-date --provider hubspot --today 2026-06-11");
    expectOk(fixed, "fix --rule past-close-date");
    const [planId] = planIds(fixed);
    assert.ok(planId, `no plan id in fix output:\n${fixed}`);
    // `suggest` lists one line per requires_human_* placeholder op (the rule
    // emits requires_human_close_date_selection with no deterministic value),
    // a compact way to read back the 8 operation ids to fill via --value.
    const suggested = await fsgtm(`suggest --plan-id ${planId} --provider hubspot --today 2026-06-11`);
    expectOk(suggested, "suggest");
    const opIds = [...new Set(suggested.match(/op_[0-9a-z]+/g) ?? [])];
    assert.equal(opIds.length, 8, `expected 8 past-close-date operations, got ${opIds.length}:\n${suggested}`);
    const valueFlags = opIds.map((id) => `--value ${id}=2026-06-30`).join(" ");
    expectOk(await fsgtm(`plans approve ${planId} --operations all ${valueFlags}`), "approve with overrides");
    expectOk(await fsgtm(`apply --plan-id ${planId} --provider hubspot`), "apply");
  });
  report("past-close-dates (rule)", grade);
}

console.log("\nALL DETERMINISTIC PROOFS PASSED");

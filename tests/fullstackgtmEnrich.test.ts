import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildEnrichPlan,
  builtinEnrichPreset,
  createFileEnrichRunStore,
  inferIngestObjectType,
  latestStamps,
  matchSourceRecord,
  parseCsv,
  parseEnrichConfig,
  resolveCrmField,
  selectStaleWork,
  sourceValueAt,
  stagedSourceRecords,
  type EnrichConfig,
  type EnrichRun,
  type EnrichSourceRecord,
} from "../src/enrich.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

function config(overrides: Partial<EnrichConfig> = {}): EnrichConfig {
  return parseEnrichConfig(
    JSON.stringify({
      sources: {
        apollo: { kind: "api" },
        clay: { kind: "ingest", format: "csv" },
      },
      match: {
        company: { keys: ["domain", "name"], onAmbiguous: "skip" },
        contact: { keys: ["email"], onAmbiguous: "suggest" },
      },
      fields: {
        company: [
          { crm: "industry", from: { apollo: "organization.industry", clay: "Industry" } },
          {
            crm: "numberofemployees",
            from: { apollo: "organization.estimated_num_employees" },
            refresh: true,
            staleDays: 180,
          },
        ],
        contact: [
          { crm: "jobtitle", from: { apollo: "person.title", clay: "Job Title" }, refresh: true, staleDays: 90 },
        ],
      },
      policy: { overwrite: "never", defaultStaleDays: 90 },
      ...overrides,
    }),
  );
}

function snapshot(partial: Partial<CanonicalGtmSnapshot> = {}): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-12T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [
      { id: "1001", name: "Acme Inc", domain: "acme.com" },
      { id: "1002", name: "Globex", domain: "globex.com", industry: "Manufacturing" },
    ],
    contacts: [
      { id: "2001", firstName: "Jane", lastName: "Doe", email: "jane@acme.com" },
      { id: "2002", firstName: "Jon", lastName: "Snow", email: "jon@globex.com" },
      { id: "2003", firstName: "Jon", lastName: "Stark", email: "jon@globex.com" },
    ],
    deals: [],
    activities: [],
    ...partial,
  };
}

function companyRecord(payload: Record<string, unknown>, keys: Record<string, string | undefined>): EnrichSourceRecord {
  return { id: "apollo:org_x", objectType: "company", keys, payload };
}

// ---------------------------------------------------------------------------
// Config validation

test("enrich config: the spec example parses and provider field spellings resolve", () => {
  const parsed = config();
  assert.equal(parsed.policy.overwrite, "never");
  assert.equal(resolveCrmField("company", "numberofemployees"), "employeeCount");
  assert.equal(resolveCrmField("company", "employeeCount"), "employeeCount");
  assert.equal(resolveCrmField("contact", "jobtitle"), "title");
});

test("enrich config: strict validation rejects bad configs with named problems", () => {
  const base = JSON.parse(JSON.stringify(config()));

  assert.throws(() => parseEnrichConfig("not json"), /not valid JSON/);
  assert.throws(() => parseEnrichConfig(JSON.stringify({ ...base, sources: {} })), /"sources" is empty/);
  assert.throws(
    () => parseEnrichConfig(JSON.stringify({ ...base, sources: { ...base.sources, zoominfo: { kind: "api" } } })),
    /api source "zoominfo" is not supported yet/,
  );
  // linkedin is a supported api source (explicit config enables size + email-chaining)
  assert.doesNotThrow(() =>
    parseEnrichConfig(JSON.stringify({ ...base, sources: { ...base.sources, linkedin: { kind: "api" } } })),
  );
  assert.throws(
    () => parseEnrichConfig(JSON.stringify({ ...base, sources: { apollo: { kind: "webhook" } } })),
    /kind must be "api" or "ingest"/,
  );
  assert.throws(
    () => parseEnrichConfig(JSON.stringify({ ...base, match: { company: { keys: [] } } })),
    /keys" must be a non-empty ordered array/,
  );
  assert.throws(
    () => parseEnrichConfig(JSON.stringify({ ...base, match: { ...base.match, company: { keys: ["vat_number"] } } })),
    /unknown key "vat_number"/,
  );
  assert.throws(
    () =>
      parseEnrichConfig(
        JSON.stringify({ ...base, match: { ...base.match, contact: { keys: ["email"], onAmbiguous: "merge" } } }),
      ),
    /onAmbiguous must be "skip" or "suggest"/,
  );
  assert.throws(
    () =>
      parseEnrichConfig(
        JSON.stringify({ ...base, fields: { company: [{ crm: "fax_number", from: { apollo: "organization.fax" } }] } }),
      ),
    /unknown company field "fax_number"/,
  );
  assert.throws(
    () =>
      parseEnrichConfig(
        JSON.stringify({ ...base, fields: { company: [{ crm: "industry", from: { zoominfo: "industry" } }] } }),
      ),
    /undeclared source "zoominfo"/,
  );
  assert.throws(
    () => parseEnrichConfig(JSON.stringify({ ...base, fields: { company: base.fields.company }, match: {} })),
    /match\.company is missing/,
  );
  assert.throws(
    () =>
      parseEnrichConfig(
        JSON.stringify({
          ...base,
          fields: { ...base.fields, company: [{ crm: "industry", from: { apollo: "x" }, staleDays: -1 }] },
        }),
      ),
    /staleDays must be a positive number/,
  );
});

test("enrich config: phase-2 conflict ladder rungs are refused explicitly, not silently accepted", () => {
  const base = JSON.parse(JSON.stringify(config()));
  for (const overwrite of ["system-only", "always"]) {
    assert.throws(
      () => parseEnrichConfig(JSON.stringify({ ...base, policy: { overwrite } })),
      /not yet implemented \(phase 2/,
      overwrite,
    );
  }
  assert.throws(
    () =>
      parseEnrichConfig(
        JSON.stringify({
          ...base,
          fields: { ...base.fields, company: [{ crm: "industry", from: { apollo: "x" }, policy: "always" }] },
        }),
      ),
    /not yet implemented \(phase 2/,
  );
});

// ---------------------------------------------------------------------------
// CSV parser

test("parseCsv handles quoted fields, embedded commas/newlines, escaped quotes, and CRLF", () => {
  const rows = parseCsv(
    'Email,Job Title,Notes\r\n' +
      'jane@acme.com,"Director, Data","line one\nline two"\r\n' +
      'jon@globex.com,Engineer,"said ""hi"""\r\n',
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { Email: "jane@acme.com", "Job Title": "Director, Data", Notes: "line one\nline two" });
  assert.deepEqual(rows[1], { Email: "jon@globex.com", "Job Title": "Engineer", Notes: 'said "hi"' });
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("OnlyHeader\n"), []);
  assert.throws(() => parseCsv('a,b\n"unterminated'), /unterminated quoted field/);
});

// ---------------------------------------------------------------------------
// Matcher semantics: all four outcomes

test("matcher: unique hit on the first key wins and stops", () => {
  const outcome = matchSourceRecord(snapshot(), "company", ["domain", "name"], { domain: "acme.com", name: "WRONG" });
  assert.deepEqual(outcome, { status: "matched", recordId: "1001", matchedKey: "domain" });
});

test("matcher: zero hits on the first key falls through to the next key", () => {
  const outcome = matchSourceRecord(snapshot(), "company", ["domain", "name"], {
    domain: "nowhere.example",
    name: "Globex",
  });
  assert.deepEqual(outcome, { status: "matched", recordId: "1002", matchedKey: "name" });
});

test("matcher: exhausted keys means unmatched, never a guess", () => {
  const outcome = matchSourceRecord(snapshot(), "company", ["domain", "name"], {
    domain: "nowhere.example",
    name: "Nobody Corp",
  });
  assert.deepEqual(outcome, { status: "unmatched" });
});

test("matcher: multiple hits surface as ambiguous with candidate ids", () => {
  const outcome = matchSourceRecord(snapshot(), "contact", ["email"], { email: "jon@globex.com" });
  assert.deepEqual(outcome, { status: "ambiguous", key: "email", candidateIds: ["2002", "2003"] });
});

test("matcher: domain values normalize (protocol, www, path, case)", () => {
  const outcome = matchSourceRecord(snapshot(), "company", ["domain"], { domain: "https://www.ACME.com/about" });
  assert.deepEqual(outcome, { status: "matched", recordId: "1001", matchedKey: "domain" });
});

// ---------------------------------------------------------------------------
// Fill-blanks policy (append)

test("append fills blanks only: never an operation over a non-empty CRM field", () => {
  const records = [
    companyRecord(
      { organization: { industry: "Software", name: "Acme Inc", primary_domain: "acme.com" } },
      { domain: "acme.com", name: "Acme Inc" },
    ),
    {
      ...companyRecord(
        { organization: { industry: "Robotics", name: "Globex", primary_domain: "globex.com" } },
        { domain: "globex.com", name: "Globex" },
      ),
      id: "apollo:org_y",
    },
  ];
  const result = buildEnrichPlan({
    config: config(),
    source: "apollo",
    mode: "append",
    snapshot: snapshot(),
    records,
    runLabel: "run-t",
  });

  // Acme's industry is blank → one op. Globex already says Manufacturing →
  // policy "never" suppresses the overwrite entirely.
  assert.equal(result.counts.matched, 2);
  assert.equal(result.counts.opsEmitted, 1);
  const op = result.plan.operations[0];
  assert.equal(op.objectType, "account");
  assert.equal(op.objectId, "1001");
  assert.equal(op.field, "industry");
  assert.equal(op.beforeValue, null); // empty before → apply-time CAS on blank
  assert.equal(op.afterValue, "Software");
  assert.equal(op.riskLevel, "low");
  assert.equal(op.approvalRequired, true);
  assert.equal(op.sourceRuleOrPolicy, "enrich:apollo:industry");
  assert.equal(result.plan.status, "needs_approval");
  assert.equal(result.plan.dryRun, true);

  // Evidence quotes the source payload and the op points at it.
  assert.equal(result.plan.evidence?.length, 1);
  assert.match(result.plan.evidence![0].text, /Software/);
  assert.deepEqual(op.evidenceIds, [result.plan.evidence![0].id]);

  // Stamps land only for proposed fields (the ledger refresh reads).
  assert.equal(result.stamps.length, 1);
  assert.deepEqual(
    { objectType: result.stamps[0].objectType, objectId: result.stamps[0].objectId, field: result.stamps[0].field },
    { objectType: "company", objectId: "1001", field: "industry" },
  );

  // Same inputs, same operation ids (stable hashes).
  const again = buildEnrichPlan({
    config: config(),
    source: "apollo",
    mode: "append",
    snapshot: snapshot(),
    records,
    runLabel: "run-t2",
  });
  assert.equal(again.plan.operations[0].id, op.id);
});

test("append skips empty source values instead of writing blanks", () => {
  const result = buildEnrichPlan({
    config: config(),
    source: "apollo",
    mode: "append",
    snapshot: snapshot(),
    records: [
      companyRecord({ organization: { industry: "", name: "Acme Inc" } }, { domain: "acme.com", name: "Acme Inc" }),
    ],
    runLabel: "run-t",
  });
  assert.equal(result.counts.opsEmitted, 0);
});

test("ambiguous + skip records the collision and emits nothing", () => {
  const cfg = config();
  cfg.match.contact!.onAmbiguous = "skip";
  const result = buildEnrichPlan({
    config: cfg,
    source: "apollo",
    mode: "append",
    snapshot: snapshot(),
    records: [
      {
        id: "apollo:person_1",
        objectType: "contact",
        keys: { email: "jon@globex.com" },
        payload: { person: { title: "CTO", email: "jon@globex.com" } },
      },
    ],
    runLabel: "run-t",
  });
  assert.equal(result.counts.ambiguous, 1);
  assert.equal(result.counts.opsEmitted, 0);
  assert.deepEqual(result.ambiguities, [
    { sourceRecordId: "apollo:person_1", key: "email", candidateIds: ["2002", "2003"] },
  ]);
});

test("ambiguous + suggest emits requires_human_record_selection placeholders per candidate", () => {
  const result = buildEnrichPlan({
    config: config(), // contact onAmbiguous: suggest
    source: "apollo",
    mode: "append",
    snapshot: snapshot(),
    records: [
      {
        id: "apollo:person_1",
        objectType: "contact",
        keys: { email: "jon@globex.com" },
        payload: { person: { title: "CTO", email: "jon@globex.com" } },
      },
    ],
    runLabel: "run-t",
  });
  assert.equal(result.counts.ambiguous, 1);
  assert.equal(result.counts.opsEmitted, 2);
  for (const op of result.plan.operations) {
    assert.equal(op.afterValue, "requires_human_record_selection");
    assert.equal(op.approvalRequired, true);
    assert.match(op.reason, /matched 2 CRM records on email \(2002, 2003\)/);
    assert.match(op.reason, /"CTO"/); // the source value rides in the reason
  }
  assert.deepEqual(
    result.plan.operations.map((op) => op.objectId).sort(),
    ["2002", "2003"],
  );
});

// ---------------------------------------------------------------------------
// Refresh: staleness selection + change detection

function stampedRun(enrichedAt: string, value: unknown = 100): EnrichRun {
  return {
    id: "enr_x",
    runLabel: `run-${enrichedAt.slice(0, 10)}`,
    source: "apollo",
    mode: "append",
    startedAt: enrichedAt,
    completedAt: enrichedAt,
    cursor: null,
    counts: { fetched: 1, matched: 1, unmatched: 0, ambiguous: 0, opsEmitted: 1 },
    planIds: [],
    stamps: [
      {
        objectType: "company",
        objectId: "1001",
        field: "employeeCount",
        enrichedAt,
        sourceRecordId: "apollo:org_x",
        value,
      },
      // industry has no refresh: true in the config → never in the work set.
      { objectType: "company", objectId: "1001", field: "industry", enrichedAt, sourceRecordId: "apollo:org_x" },
    ],
  };
}

test("refresh work set selects only refresh-eligible stamps older than their window", () => {
  const cfg = config();
  const now = () => new Date("2026-06-12T00:00:00.000Z");

  // 30 days old: inside the 180d window for employeeCount → nothing stale.
  assert.deepEqual(selectStaleWork(cfg, [stampedRun("2026-05-13T00:00:00.000Z")], "apollo", { now }), []);

  // 200 days old: beyond the 180d window → employeeCount selected; industry
  // (not refresh-eligible) stays out even though it is just as old.
  const work = selectStaleWork(cfg, [stampedRun("2025-11-24T00:00:00.000Z")], "apollo", { now });
  assert.deepEqual(work, [{ objectType: "company", objectId: "1001", field: "employeeCount" }]);

  // --stale-days override wins over per-field staleDays.
  const overridden = selectStaleWork(cfg, [stampedRun("2026-05-13T00:00:00.000Z")], "apollo", {
    now,
    staleDaysOverride: 7,
  });
  assert.deepEqual(overridden, [{ objectType: "company", objectId: "1001", field: "employeeCount" }]);

  // The LATEST stamp per cell decides: a fresh re-stamp resets the clock.
  const refreshed = selectStaleWork(
    cfg,
    [stampedRun("2025-11-24T00:00:00.000Z"), stampedRun("2026-06-01T00:00:00.000Z")],
    "apollo",
    { now },
  );
  assert.deepEqual(refreshed, []);
});

test("refresh emits ops only where the source value actually changed, and re-stamps every checked cell", () => {
  const crm = snapshot({
    accounts: [{ id: "1001", name: "Acme Inc", domain: "acme.com", employeeCount: 100, industry: "Software" }],
  });
  const workSet = [{ objectType: "company" as const, objectId: "1001", field: "employeeCount" }];
  const records = (employees: number) => [
    companyRecord(
      { organization: { estimated_num_employees: employees, industry: "Hardware", name: "Acme Inc" } },
      { domain: "acme.com", name: "Acme Inc" },
    ),
  ];

  // Unchanged source value → no op, but the staleness clock resets (re-stamp).
  const unchanged = buildEnrichPlan({
    config: config(),
    source: "apollo",
    mode: "refresh",
    snapshot: crm,
    records: records(100),
    workSet,
    runLabel: "run-r",
  });
  assert.equal(unchanged.counts.opsEmitted, 0);
  assert.equal(unchanged.stamps.length, 1);
  assert.equal(unchanged.stamps[0].field, "employeeCount");

  // Changed source value → one op carrying the CURRENT CRM value as beforeValue.
  const changed = buildEnrichPlan({
    config: config(),
    source: "apollo",
    mode: "refresh",
    snapshot: crm,
    records: records(250),
    workSet,
    runLabel: "run-r",
  });
  assert.equal(changed.counts.opsEmitted, 1);
  const op = changed.plan.operations[0];
  assert.equal(op.field, "employeeCount");
  assert.equal(op.beforeValue, 100); // CAS against the live CRM value
  assert.equal(op.afterValue, 250);
  assert.equal(op.riskLevel, "medium");
  assert.equal(op.approvalRequired, true);

  // Refresh never reaches outside its work set: industry changed at the
  // source (Hardware vs Software) but is not stamped/eligible → untouched.
  assert.equal(changed.plan.operations.length, 1);
});

// ---------------------------------------------------------------------------
// Run store

test("run store round-trip: append, get, list, latest, update; labels are append-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-enrich-store-"));
  try {
    const store = createFileEnrichRunStore(dir);
    const run = stampedRun("2026-06-01T00:00:00.000Z");
    await store.append(run);
    assert.deepEqual(await store.get(run.runLabel), run);
    await assert.rejects(store.append(run), /append-only/);

    // In-place update (cursor checkpoint) keeps the same label.
    await store.update({ ...run, cursor: "acme.com" });
    assert.equal((await store.get(run.runLabel))?.cursor, "acme.com");
    await assert.rejects(store.update({ ...run, runLabel: "missing" }), /No enrich run/);
    await assert.rejects(store.update({ ...run, id: "enr_other" }), /different run id/);

    const later: EnrichRun = { ...stampedRun("2026-06-10T00:00:00.000Z"), mode: "refresh" };
    await store.append(later);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.latest())?.runLabel, later.runLabel);
    assert.equal((await store.latest({ mode: "append" }))?.runLabel, run.runLabel);
    assert.equal(await store.latest({ source: "clay" }), null);

    // latestStamps picks the newest stamp per (objectType, objectId, field).
    const stamps = latestStamps([run, later], "apollo");
    assert.equal(stamps.get("company|1001|employeeCount")?.enrichedAt, "2026-06-10T00:00:00.000Z");

    await assert.rejects(store.append({ ...run, runLabel: "../escape" }), /Invalid run label/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ingest staging

test("ingest rows: object type inference from match-key columns, staged records feed the matcher", () => {
  const cfg = config();
  assert.equal(inferIngestObjectType(cfg, "clay", [{ Email: "a@b.com", "Job Title": "VP" }]), "contact");
  assert.throws(
    () => inferIngestObjectType(cfg, "clay", [{ Widget: "x" }]),
    /no configured match key column found/,
  );

  const run: EnrichRun = {
    ...stampedRun("2026-06-01T00:00:00.000Z"),
    source: "clay",
    mode: "ingest",
    stamps: [],
    staged: [{ Email: "jane@acme.com", "Job Title": "VP Operations" }],
    stagedObjectType: "contact",
  };
  const records = stagedSourceRecords(cfg, "clay", run);
  assert.equal(records.length, 1);
  assert.equal(records[0].objectType, "contact");
  assert.equal(records[0].keys.email, "jane@acme.com"); // case-insensitive header lookup
  assert.equal(sourceValueAt(records[0].payload, "Job Title"), "VP Operations");
});

test("built-in clay preset is match-only and still reports the routing verdict (Mode A)", () => {
  // Regression: a match-only config (empty fields, e.g. the built-in Clay preset)
  // must still run the matcher and report matched / ambiguous / unmatched +
  // collisions — it just proposes zero field writes. Previously a record with no
  // field mappings was short-circuited to "unmatched" before matching ran.
  const preset = builtinEnrichPreset("clay");
  assert.ok(preset, "clay preset should exist");
  assert.deepEqual(preset!.fields, {}); // match-only by design
  assert.equal(builtinEnrichPreset("no-such-source"), undefined);

  const snap = snapshot({
    accounts: [
      { id: "1001", name: "Acme Inc", domain: "acme.com" },
      { id: "1002", name: "Dup One", domain: "dup.com" },
      { id: "1003", name: "Dup Two", domain: "dup.com" }, // same domain → ambiguous group
    ],
  });
  const records: EnrichSourceRecord[] = [
    { id: "clay:1", objectType: "company", keys: { domain: "acme.com" }, payload: {} },
    { id: "clay:2", objectType: "company", keys: { domain: "dup.com" }, payload: {} },
    { id: "clay:3", objectType: "company", keys: { domain: "newco.io" }, payload: {} },
  ];
  const result = buildEnrichPlan({
    config: preset!,
    source: "clay",
    mode: "append",
    snapshot: snap,
    records,
    runLabel: "clay-preset-test",
  });

  assert.equal(result.counts.matched, 1); // acme.com
  assert.equal(result.counts.ambiguous, 1); // dup.com collision
  assert.equal(result.counts.unmatched, 1); // newco.io
  assert.equal(result.counts.opsEmitted, 0); // match-only: no writes proposed
});

test("CLI: enrich ingest --source clay runs zero-config and collapses to a verdict (one-shot)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-clay-cli-"));
  try {
    const snap = join(dir, "snap.json");
    writeFileSync(
      snap,
      JSON.stringify({
        generatedAt: "2026-06-12T00:00:00.000Z",
        provider: "mock",
        users: [],
        accounts: [
          { id: "1001", name: "Acme Inc", domain: "acme.com" },
          { id: "1002", name: "Dup A", domain: "dup.com" },
          { id: "1003", name: "Dup B", domain: "dup.com" },
        ],
        contacts: [],
        deals: [],
        activities: [],
      }),
    );
    const csv = join(dir, "clay.csv");
    writeFileSync(csv, "Company Name,Domain\nAcme,https://www.acme.com/\nDup,dup.com\nNewCo,newco.io\n");
    const repoRoot = resolve(import.meta.dirname, "..");
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(repoRoot, "src/bin.ts"),
        "enrich",
        "ingest",
        csv,
        "--source",
        "clay",
        "--objects",
        "companies",
        "--input",
        snap,
        "--run-label",
        "cli-oneshot",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FSGTM_HOME: dir } },
    );
    assert.equal(r.status, 0, r.stderr);
    // Zero config (preset) + collapse: normalized match (acme), ambiguity (dup.com), unmatched (newco).
    assert.match(r.stdout, /1 matched/);
    assert.match(r.stdout, /1 ambiguous/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAtsJobs,
  snippetFor,
  type AtsBoardSource,
  type AtsJob,
} from "../src/connectors/atsBoards.ts";
import {
  DEFAULT_SIGNALS_CONFIG,
  buildSignalsFromAts,
  computeWeights,
  createFileSignalStore,
  dedupKey,
  dedupeSignals,
  loadSignalsConfig,
  makeOutcome,
  normalizeAccountDomain,
  parseSignalsConfig,
  recencyFactor,
  signalId,
  signalRunId,
  type Signal,
  type SignalOutcome,
  type SignalRun,
  type SignalsConfig,
} from "../src/signals.ts";

// Keep deterministic paths: no LLM here, but mirror the harness convention.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const NOW = new Date("2026-06-23T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture board responses, one per provider.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GREENHOUSE_BOARD = {
  jobs: [
    {
      id: 101,
      title: "Head of Growth",
      absolute_url: "https://boards.greenhouse.io/apexnorth/jobs/101",
      content: "&lt;p&gt;We are scaling our <b>growth</b> team and need a leader for marketing ops.&lt;/p&gt;",
    },
    {
      id: 102,
      title: "Office Manager",
      absolute_url: "https://boards.greenhouse.io/apexnorth/jobs/102",
      content: "<p>Front desk and facilities.</p>",
    },
  ],
};

const LEVER_BOARD = [
  {
    id: "lev-1",
    text: "Director of RevOps",
    hostedUrl: "https://jobs.lever.co/apexnorth/lev-1",
    descriptionPlain: "Own the revops stack and the growth funnel end to end.",
  },
];

const ASHBY_BOARD = {
  jobs: [
    {
      id: "ash-1",
      title: "VP Marketing",
      jobUrl: "https://jobs.ashbyhq.com/apexnorth/ash-1",
      descriptionPlain: "Lead demand gen and marketing ops for the next stage of growth.",
    },
  ],
};

function fixtureFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("boards-api.greenhouse.io")) return jsonResponse(GREENHOUSE_BOARD);
    if (href.includes("api.lever.co")) return jsonResponse(LEVER_BOARD);
    if (href.includes("api.ashbyhq.com")) {
      assert.equal(init?.method, "POST"); // Ashby is a POST with a jobBoardName body
      return jsonResponse(ASHBY_BOARD);
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// ATS adapters

test("fetchAtsJobs: greenhouse, lever, ashby via injected fetch", async () => {
  const fetchImpl = fixtureFetch();

  const gh = await fetchAtsJobs({
    source: "greenhouse",
    boardToken: "apexnorth",
    accountDomain: "apexnorth.agency",
    keywords: ["growth"],
    fetchImpl,
  });
  assert.equal(gh.length, 2);
  assert.equal(gh[0].title, "Head of Growth");
  assert.equal(gh[0].url, "https://boards.greenhouse.io/apexnorth/jobs/101");
  assert.equal(gh[0].firstSeenKey, "101");
  // HTML entities + tags decoded; the keyword survives verbatim in the snippet.
  assert.ok(gh[0].jdSnippet.toLowerCase().includes("growth"));
  assert.ok(!gh[0].jdSnippet.includes("<b>"));

  const lev = await fetchAtsJobs({
    source: "lever",
    boardToken: "apexnorth",
    accountDomain: "apexnorth.agency",
    fetchImpl,
  });
  assert.equal(lev.length, 1);
  assert.equal(lev[0].title, "Director of RevOps");
  assert.equal(lev[0].url, "https://jobs.lever.co/apexnorth/lev-1");
  assert.equal(lev[0].firstSeenKey, "lev-1");

  const ash = await fetchAtsJobs({
    source: "ashby",
    boardToken: "apexnorth",
    accountDomain: "apexnorth.agency",
    fetchImpl,
  });
  assert.equal(ash.length, 1);
  assert.equal(ash[0].title, "VP Marketing");
  assert.equal(ash[0].firstSeenKey, "ash-1");
});

test("fetchAtsJobs: base-url override hits the configured origin", async () => {
  let seen = "";
  const fetchImpl = (async (url: string | URL) => {
    seen = String(url);
    return jsonResponse(GREENHOUSE_BOARD);
  }) as typeof fetch;
  await fetchAtsJobs({
    source: "greenhouse",
    boardToken: "apexnorth",
    accountDomain: "apexnorth.agency",
    fetchImpl,
    apiBaseUrl: "https://gh.test.local/",
  });
  assert.ok(seen.startsWith("https://gh.test.local/v1/boards/apexnorth/jobs"));
});

test("fetchAtsJobs: a failing board yields [] not a throw (per-source resilience)", async () => {
  const fetchImpl = (async () => jsonResponse({}, 500)) as typeof fetch;
  const out = await fetchAtsJobs({ source: "lever", boardToken: "x", accountDomain: "x.com", fetchImpl });
  assert.deepEqual(out, []);
  const offline = (async () => {
    throw new Error("ENOTFOUND");
  }) as typeof fetch;
  const out2 = await fetchAtsJobs({ source: "ashby", boardToken: "x", accountDomain: "x.com", fetchImpl: offline });
  assert.deepEqual(out2, []);
});

test("fetchAtsJobs: empty board token short-circuits without a network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({});
  }) as typeof fetch;
  const out = await fetchAtsJobs({ source: "greenhouse", boardToken: "  ", accountDomain: "x.com", fetchImpl });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("snippetFor: returns a verbatim window around the first keyword", () => {
  const desc = "We need someone to own marketing operations and revops across the funnel.";
  const snip = snippetFor(desc, ["revops"]);
  assert.ok(snip.toLowerCase().includes("revops"));
  assert.equal(snippetFor("", ["x"]), "");
  // No keyword match → leading slice fallback.
  assert.ok(snippetFor(desc, ["quantum"]).startsWith("We need"));
});

// ---------------------------------------------------------------------------
// Domain normalization (matches enrich's domain key handling)

test("normalizeAccountDomain: strips protocol/www/path, lowercases", () => {
  assert.equal(normalizeAccountDomain("https://www.ApexNorth.Agency/careers"), "apexnorth.agency");
  assert.equal(normalizeAccountDomain("HTTP://apexnorth.agency"), "apexnorth.agency");
  assert.equal(normalizeAccountDomain("apexnorth.agency"), "apexnorth.agency");
  assert.equal(normalizeAccountDomain(undefined), "");
});

// ---------------------------------------------------------------------------
// buildSignalsFromAts + keyword gate + reposted detection

function jobRaw(over: Partial<AtsJob & { source: AtsBoardSource }> = {}): AtsJob & { source: AtsBoardSource } {
  return {
    title: "Head of Growth",
    jdSnippet: "Lead our growth and marketing ops function.",
    url: "https://boards.greenhouse.io/apexnorth/jobs/101",
    firstSeenKey: "101",
    source: "greenhouse",
    ...over,
  };
}

test("buildSignalsFromAts: builds job signals, quote carries the keyword verbatim", () => {
  const config: SignalsConfig = {
    ...DEFAULT_SIGNALS_CONFIG,
    buckets: { ...DEFAULT_SIGNALS_CONFIG.buckets, job: { sources: ["greenhouse"], keywords: ["growth"], weight: 1.0 } },
  };
  const signals = buildSignalsFromAts(
    [jobRaw({ source: "greenhouse" }), jobRaw({ title: "Office Manager", jdSnippet: "Front desk.", firstSeenKey: "102" })],
    { domain: "https://www.apexnorth.agency" },
    config,
    { now: NOW },
  );
  // Office Manager has no keyword in title or JD → dropped by the verbatim gate.
  assert.equal(signals.length, 1);
  const s = signals[0];
  assert.equal(s.accountDomain, "apexnorth.agency");
  assert.equal(s.bucket, "job");
  assert.equal(s.trigger, "hiring: Head of Growth");
  assert.ok(s.quote.toLowerCase().includes("growth"));
  assert.equal(s.id, signalId({ accountDomain: "apexnorth.agency", bucket: "job", trigger: "hiring: Head of Growth" }));
  assert.equal(s.source, "greenhouse");
  assert.equal(s.judgedBy, null);
  assert.ok(s.weight > 0);
  assert.equal(s.reposted, undefined);
});

test("buildSignalsFromAts: no keywords → every open role qualifies", () => {
  const signals = buildSignalsFromAts(
    [jobRaw({ title: "Office Manager", jdSnippet: "Front desk.", firstSeenKey: "102" })],
    { domain: "apexnorth.agency" },
    DEFAULT_SIGNALS_CONFIG, // job keywords default to []
    { now: NOW },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].trigger, "hiring: Office Manager");
});

test("buildSignalsFromAts: reposted role (same title, new req id, within window) gets boost", () => {
  const config: SignalsConfig = {
    ...DEFAULT_SIGNALS_CONFIG,
    buckets: { ...DEFAULT_SIGNALS_CONFIG.buckets, job: { sources: ["greenhouse"], keywords: ["growth"], weight: 1.0 } },
    repostedRoleBoost: 0.5,
  };
  // Prior: the same title was open 10 days ago under role id "55" (now closed).
  const prior: Signal[] = buildSignalsFromAts(
    [jobRaw({ firstSeenKey: "55", source: "greenhouse" })],
    { domain: "apexnorth.agency" },
    config,
    { now: new Date("2026-06-13T12:00:00.000Z") },
  );
  // New fetch: same title, a DIFFERENT req id "101" → reposted.
  const repostedNow = buildSignalsFromAts(
    [jobRaw({ firstSeenKey: "101", source: "greenhouse" })],
    { domain: "apexnorth.agency" },
    config,
    { now: NOW, priorSignals: prior },
  );
  assert.equal(repostedNow.length, 1);
  assert.equal(repostedNow[0].reposted, true);
  assert.equal(repostedNow[0].trigger, "reposted: Head of Growth");
  // Weight carries the boost vs. a non-reposted same role.
  const plain = buildSignalsFromAts([jobRaw({ firstSeenKey: "101" })], { domain: "apexnorth.agency" }, config, { now: NOW });
  assert.ok(repostedNow[0].weight > plain[0].weight);
  assert.equal(Math.round((repostedNow[0].weight - plain[0].weight) * 10000) / 10000, 0.5);

  // Same req id re-seen (continuously open, not reposted) → NOT flagged.
  const sameReq = buildSignalsFromAts(
    [jobRaw({ firstSeenKey: "55", source: "greenhouse" })],
    { domain: "apexnorth.agency" },
    config,
    { now: NOW, priorSignals: prior },
  );
  assert.equal(sameReq[0].reposted, undefined);
});

// ---------------------------------------------------------------------------
// Dedup across two runs

test("dedupeSignals: a signal seen last week within the window is deduped on the next run", () => {
  const config = DEFAULT_SIGNALS_CONFIG;
  const run1 = buildSignalsFromAts([jobRaw({})], { domain: "apexnorth.agency" }, config, {
    now: new Date("2026-06-16T12:00:00.000Z"),
  });
  const run2candidates = buildSignalsFromAts([jobRaw({})], { domain: "apexnorth.agency" }, config, { now: NOW });

  const { fresh, deduped } = dedupeSignals(run2candidates, run1, config.dedupWindowDays, NOW);
  assert.equal(fresh.length, 0);
  assert.equal(deduped.length, 1);
  assert.equal(dedupKey(deduped[0]), dedupKey(run1[0]));

  // Same dedupKey repeated within a single run is collapsed too.
  const within = dedupeSignals([run2candidates[0], run2candidates[0]], [], config.dedupWindowDays, NOW);
  assert.equal(within.fresh.length, 1);
  assert.equal(within.deduped.length, 1);
});

test("dedupeSignals: a prior signal older than the window no longer suppresses (re-fires)", () => {
  const config = DEFAULT_SIGNALS_CONFIG;
  const old = buildSignalsFromAts([jobRaw({})], { domain: "apexnorth.agency" }, config, {
    now: new Date("2026-04-01T12:00:00.000Z"), // > 30d before NOW
  });
  const candidates = buildSignalsFromAts([jobRaw({})], { domain: "apexnorth.agency" }, config, { now: NOW });
  const { fresh } = dedupeSignals(candidates, old, config.dedupWindowDays, NOW);
  assert.equal(fresh.length, 1);
});

// ---------------------------------------------------------------------------
// computeWeights: cold start == defaults; shifts after outcomes

test("computeWeights: cold start equals config defaults", () => {
  const weights = computeWeights(DEFAULT_SIGNALS_CONFIG, []);
  assert.equal(weights.job, DEFAULT_SIGNALS_CONFIG.buckets.job.weight);
  assert.equal(weights.funding, DEFAULT_SIGNALS_CONFIG.buckets.funding.weight);
  assert.equal(weights.social, DEFAULT_SIGNALS_CONFIG.buckets.social.weight);
  // Deterministic: same ledger → same weights.
  assert.deepEqual(computeWeights(DEFAULT_SIGNALS_CONFIG, []), weights);
});

test("computeWeights: a bucket that books meetings gets heavier; one that dies gets lighter", () => {
  const jobSignal: Signal = {
    id: "sig_job",
    accountDomain: "a.com",
    bucket: "job",
    trigger: "hiring: VP Sales",
    quote: "VP Sales",
    sourceUrl: "u",
    firstSeen: NOW.toISOString(),
    weight: 1,
    source: "greenhouse",
    judgedBy: null,
  };
  const socialSignal: Signal = { ...jobSignal, id: "sig_social", bucket: "social", trigger: "engaged: competitor" };
  const byId = new Map<string, Signal>([
    [jobSignal.id, jobSignal],
    [socialSignal.id, socialSignal],
  ]);

  // job books meetings; social never does.
  const outcomes: SignalOutcome[] = [
    makeOutcome({ accountDomain: "a.com", result: "meeting", creditedSignals: ["sig_job"] }),
    makeOutcome({ accountDomain: "b.com", result: "meeting", creditedSignals: ["sig_job"] }),
    makeOutcome({ accountDomain: "c.com", result: "meeting", creditedSignals: ["sig_job"] }),
    makeOutcome({ accountDomain: "d.com", result: "no_reply", creditedSignals: ["sig_social"] }),
    makeOutcome({ accountDomain: "e.com", result: "no_reply", creditedSignals: ["sig_social"] }),
    makeOutcome({ accountDomain: "f.com", result: "bounced", creditedSignals: ["sig_social"] }),
  ];
  const weights = computeWeights(DEFAULT_SIGNALS_CONFIG, outcomes, byId);
  assert.ok(weights.job > DEFAULT_SIGNALS_CONFIG.buckets.job.weight, "booking bucket heavier");
  assert.ok(weights.social < DEFAULT_SIGNALS_CONFIG.buckets.social.weight, "dead bucket lighter");
  // A bucket with no outcomes stays exactly at its default.
  assert.equal(weights.funding, DEFAULT_SIGNALS_CONFIG.buckets.funding.weight);
  // Deterministic.
  assert.deepEqual(computeWeights(DEFAULT_SIGNALS_CONFIG, outcomes, byId), weights);
});

// ---------------------------------------------------------------------------
// recency

test("recencyFactor: fresh ~1, older decays toward the floor", () => {
  assert.equal(recencyFactor(NOW.toISOString(), NOW, 30), 1);
  const mid = recencyFactor(new Date("2026-06-08T12:00:00.000Z").toISOString(), NOW, 30);
  assert.ok(mid < 1 && mid > 0.4);
  const old = recencyFactor("2026-01-01T00:00:00.000Z", NOW, 30);
  assert.equal(old, 0.4);
});

// ---------------------------------------------------------------------------
// Config parse / load

test("parseSignalsConfig: zero-config defaults fill missing buckets; validates", () => {
  const cfg = parseSignalsConfig(
    JSON.stringify({ buckets: { job: { sources: ["greenhouse"], keywords: ["revops"], weight: 1.2 } } }),
  );
  assert.equal(cfg.buckets.job.weight, 1.2);
  assert.deepEqual(cfg.buckets.job.keywords, ["revops"]);
  // Untouched buckets fall back to the default preset.
  assert.equal(cfg.buckets.funding.weight, DEFAULT_SIGNALS_CONFIG.buckets.funding.weight);
  assert.equal(cfg.dedupWindowDays, 30);

  assert.throws(() => parseSignalsConfig("{ not json"), /signals config: not valid JSON/);
  assert.throws(() => parseSignalsConfig(JSON.stringify({ buckets: { bogus: {} } })), /unknown bucket "bogus"/);
  assert.throws(
    () => parseSignalsConfig(JSON.stringify({ dedupWindowDays: -1 })),
    /dedupWindowDays must be a positive number/,
  );
  assert.throws(
    () => parseSignalsConfig(JSON.stringify({ buckets: { job: { sources: "nope", weight: 1 } } })),
    /buckets.job.sources must be an array/,
  );
});

test("loadSignalsConfig: missing file throws a guiding error", () => {
  assert.throws(() => loadSignalsConfig("/nonexistent/signals.config.json"), /No signals config at/);
});

// ---------------------------------------------------------------------------
// Store round-trip, append-only rejection, outcome ledger, allSignals

function freshRun(label: string, startedAt: string, signals: Signal[]): SignalRun {
  return {
    id: signalRunId(label),
    runLabel: label,
    startedAt,
    completedAt: startedAt,
    buckets: ["job"],
    counts: { fetched: signals.length, new: signals.length, deduped: 0 },
    signals,
  };
}

test("signal store: run round-trip, append-only, update-by-id, outcomes ledger, allSignals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-signals-store-"));
  try {
    const store = createFileSignalStore(dir);
    const sigs = buildSignalsFromAts([jobRaw({})], { domain: "apexnorth.agency" }, DEFAULT_SIGNALS_CONFIG, { now: NOW });
    const run = freshRun("2026-06-23-am", "2026-06-23T07:00:00.000Z", sigs);

    await store.appendRun(run);
    assert.deepEqual(await store.getRun(run.runLabel), run);
    await assert.rejects(store.appendRun(run), /append-only/);

    // Update by id (stamp judgedBy) keeps the same label.
    const stamped = { ...run, signals: run.signals.map((s) => ({ ...s, judgedBy: "jdg_x" })) };
    await store.updateRun(stamped);
    assert.equal((await store.getRun(run.runLabel))?.signals[0].judgedBy, "jdg_x");
    await assert.rejects(store.updateRun({ ...stamped, runLabel: "missing" }), /No signal run/);
    await assert.rejects(store.updateRun({ ...stamped, id: "sigr_other" }), /different run id/);

    // list sorts by startedAt; latestRun is the newest.
    const later = freshRun("2026-06-23-pm", "2026-06-23T19:00:00.000Z", sigs);
    await store.appendRun(later);
    const runs = await store.listRuns();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.runLabel), ["2026-06-23-am", "2026-06-23-pm"]);
    assert.equal((await store.latestRun())?.runLabel, "2026-06-23-pm");

    // allSignals flattens runs.
    assert.equal((await store.allSignals()).length, 2 * sigs.length);

    // Outcome ledger is append-only: appending twice keeps both lines.
    const o1 = makeOutcome({ accountDomain: "apexnorth.agency", result: "meeting", creditedSignals: [sigs[0].id] });
    const o2 = makeOutcome({ accountDomain: "apexnorth.agency", touchId: "42", result: "replied" });
    await store.appendOutcome(o1);
    await store.appendOutcome(o2);
    const outcomes = await store.listOutcomes();
    assert.equal(outcomes.length, 2);
    assert.deepEqual(outcomes[0], o1);
    assert.equal(outcomes[1].touchId, "42");

    // Invalid (path-traversal) run label is rejected.
    await assert.rejects(store.appendRun({ ...run, runLabel: "../escape" }), /Invalid run label/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signal store: governance — no plan store is touched; fetch persists a SignalRun only", async () => {
  // Structural assertion: the signals module exports no plan/PatchPlan emitter.
  // The store API surface is runs + outcomes + signals — nothing CRM-side.
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-signals-gov-"));
  try {
    const store = createFileSignalStore(dir);
    const keys = Object.keys(store);
    assert.ok(!keys.some((k) => /plan/i.test(k)), "store exposes no plan surface");
    assert.deepEqual(keys.sort(), [
      "allSignals",
      "appendOutcome",
      "appendRun",
      "getRun",
      "latestRun",
      "listOutcomes",
      "listRuns",
      "updateRun",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeOutcome credits the contact the touch went to (else stays account-level)", () => {
  const o = makeOutcome({ accountDomain: "apexnorth.agency", touchId: "t1", contactId: "con-vp", result: "replied" });
  assert.equal(o.contactId, "con-vp");
  const o2 = makeOutcome({ accountDomain: "x.com", result: "replied" });
  assert.equal(o2.contactId, undefined);
});

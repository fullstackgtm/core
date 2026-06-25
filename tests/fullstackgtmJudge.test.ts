import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_SCHEMA,
  DEFAULT_JUDGE_PROMPT,
  accountRecentlyTouched,
  bestContactForAccount,
  createFileJudgeStore,
  deterministicDecision,
  deterministicWhyNow,
  isGroundedSpan,
  judgeDir,
  judgeRunId,
  judgeSignals,
  normalizeSpan,
  scoreAccount,
  scoreBand,
  type AccountScore,
  type JudgeRun,
} from "../src/judge.ts";
import { DEFAULT_SIGNALS_CONFIG, signalId, type Signal } from "../src/signals.ts";
import type { Icp } from "../src/icp.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

// Force deterministic paths unless a test explicitly injects an LLM seam.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const NOW = new Date("2026-06-23T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture builders

function signal(over: Partial<Signal> & { accountDomain: string; bucket: Signal["bucket"]; trigger: string; quote: string }): Signal {
  const base = { accountDomain: over.accountDomain, bucket: over.bucket, trigger: over.trigger };
  return {
    id: signalId(base),
    accountDomain: over.accountDomain,
    bucket: over.bucket,
    trigger: over.trigger,
    quote: over.quote,
    sourceUrl: over.sourceUrl ?? "https://example.com/x",
    firstSeen: over.firstSeen ?? NOW.toISOString(),
    weight: over.weight ?? 1,
    source: over.source ?? "greenhouse",
    judgedBy: null,
    ...(over.reposted ? { reposted: true } : {}),
    ...(over.roleKey ? { roleKey: over.roleKey } : {}),
  };
}

const ICP: Icp = {
  name: "RevOps leaders",
  firmographics: {},
  persona: { titleKeywords: ["revenue operations", "head of growth"], jobLevels: ["vp", "director"] },
};

// ---------------------------------------------------------------------------
// Pure helpers

test("scoreBand maps to the article rubric", () => {
  assert.equal(scoreBand(88), "strong");
  assert.equal(scoreBand(80), "strong");
  assert.equal(scoreBand(79), "good");
  assert.equal(scoreBand(50), "good");
  assert.equal(scoreBand(49), "weak");
  assert.equal(scoreBand(20), "weak");
  assert.equal(scoreBand(19), "noise");
  assert.equal(scoreBand(0), "noise");
});

test("isGroundedSpan enforces a >=12-char normalized substring of the source", () => {
  const quote = "We are re-opening the Head of Growth search after the first hire fell through.";
  assert.ok(isGroundedSpan("re-opening the Head of Growth search", quote));
  // Normalized whitespace / case still matches.
  assert.ok(isGroundedSpan("RE-OPENING   THE  head of growth", quote));
  // Too short.
  assert.equal(isGroundedSpan("growth", quote), false);
  // Not present verbatim.
  assert.equal(isGroundedSpan("we are shutting down the team", quote), false);
});

test("normalizeSpan lowercases and collapses whitespace/punct spacing", () => {
  assert.equal(normalizeSpan("  Head   of  Growth ,  now "), "head of growth, now");
});

// ---------------------------------------------------------------------------
// Deterministic ranking: cluster -> high, lone social -> skip, touched-7d -> nurture

test("a fresh clustered account (funding + reposted role) scores into the strong/send band", async () => {
  const domain = "apexnorth.agency";
  const signals = [
    signal({
      accountDomain: domain,
      bucket: "funding",
      trigger: "raised Series B",
      quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
    }),
    signal({
      accountDomain: domain,
      bucket: "job",
      trigger: "reposted: Head of Growth",
      quote: "Head of Growth — own demand gen and marketing ops for the next stage of growth.",
      reposted: true,
    }),
  ];
  const decisions = await judgeSignals({ signals, config: DEFAULT_SIGNALS_CONFIG, icp: ICP, now: NOW });
  assert.equal(decisions.length, 1);
  const d = decisions[0];
  assert.equal(d.accountDomain, domain);
  assert.equal(d.decision, "send");
  assert.ok(d.score >= 80, `expected strong band, got ${d.score}`);
  assert.equal(d.producedBy, "deterministic");
  assert.equal(d.play, ""); // deterministic baseline carries no play
  assert.equal(d.evidence.length, 2); // the whole cluster is credited
});

test("a lone low-intent social signal is a first-class skip with a reason", async () => {
  const domain = "quietco.io";
  const signals = [
    signal({
      accountDomain: domain,
      bucket: "social",
      trigger: "liked a post",
      quote: "Their VP of Sales liked a post about pipeline hygiene last Tuesday.",
    }),
  ];
  const decisions = await judgeSignals({ signals, config: DEFAULT_SIGNALS_CONFIG, icp: ICP, now: NOW });
  const d = decisions[0];
  assert.equal(d.decision, "skip");
  assert.ok(d.score < 50, `lone social should not reach 'good', got ${d.score}`);
  assert.ok(d.skippedReason && d.skippedReason.length > 0, "skip must carry a reason");
});

test("memory cap: a hot account touched within 7 days is downgraded to nurture, not piled on", async () => {
  const domain = "apexnorth.agency";
  const signals = [
    signal({
      accountDomain: domain,
      bucket: "funding",
      trigger: "raised Series B",
      quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
    }),
    signal({
      accountDomain: domain,
      bucket: "job",
      trigger: "reposted: Head of Growth",
      quote: "Head of Growth — own demand gen and marketing ops for the next stage of growth.",
      reposted: true,
    }),
  ];
  // Snapshot: the account exists and was touched 2 days ago.
  const snapshot: CanonicalGtmSnapshot = {
    generatedAt: NOW.toISOString(),
    provider: "hubspot",
    accounts: [{ id: "a1", name: "ApexNorth", domain: "apexnorth.agency", lastActivityAt: "2026-06-21T00:00:00.000Z" }],
    contacts: [{ id: "c1", accountId: "a1", title: "Head of Revenue Operations" }],
    deals: [],
    activities: [],
    users: [],
  };

  // Without history: strong -> send.
  const withoutHistory = await judgeSignals({ signals, config: DEFAULT_SIGNALS_CONFIG, icp: ICP, now: NOW });
  assert.equal(withoutHistory[0].decision, "send");

  // With history: touched 2d ago -> capped to nurture.
  const withHistory = await judgeSignals({
    signals,
    config: DEFAULT_SIGNALS_CONFIG,
    icp: ICP,
    snapshot,
    withHistory: true,
    now: NOW,
  });
  assert.equal(withHistory[0].decision, "nurture");
  assert.ok(withHistory[0].score < 80, "nurture must sit below the strong band after the cap");
});

test("accountRecentlyTouched reads lastActivityAt, contact activity, and the activity ledger", () => {
  const snapshot: CanonicalGtmSnapshot = {
    generatedAt: NOW.toISOString(),
    provider: "hubspot",
    accounts: [
      { id: "a1", name: "Recent", domain: "recent.com", lastActivityAt: "2026-06-22T00:00:00.000Z" },
      { id: "a2", name: "Stale", domain: "stale.com", lastActivityAt: "2026-01-01T00:00:00.000Z" },
      { id: "a3", name: "ViaActivity", domain: "viaactivity.com" },
    ],
    contacts: [{ id: "c3", accountId: "a3", title: "VP Sales" }],
    deals: [],
    activities: [{ id: "act1", contactId: "c3", type: "email", occurredAt: "2026-06-20T00:00:00.000Z" }],
    users: [],
  };
  assert.equal(accountRecentlyTouched("recent.com", snapshot, NOW), true);
  assert.equal(accountRecentlyTouched("stale.com", snapshot, NOW), false);
  assert.equal(accountRecentlyTouched("viaactivity.com", snapshot, NOW), true); // via the activity ledger
  assert.equal(accountRecentlyTouched("unknown.com", snapshot, NOW), false); // not in snapshot
});

test("bestContactForAccount prefers a titled contact for fit scoring", () => {
  const snapshot: CanonicalGtmSnapshot = {
    generatedAt: NOW.toISOString(),
    provider: "hubspot",
    accounts: [{ id: "a1", name: "X", domain: "x.com" }],
    contacts: [
      { id: "c1", accountId: "a1" },
      { id: "c2", accountId: "a1", title: "Head of Growth" },
    ],
    deals: [],
    activities: [],
    users: [],
  };
  assert.deepEqual(bestContactForAccount("x.com", snapshot), { jobTitle: "Head of Growth" });
  assert.equal(bestContactForAccount("nope.com", snapshot), undefined);
});

// ---------------------------------------------------------------------------
// whyNow is verbatim from a signal quote (deterministic baseline)

test("deterministic whyNow is a verbatim span of the top signal quote", () => {
  const s = signal({
    accountDomain: "apexnorth.agency",
    bucket: "job",
    trigger: "reposted: Head of Growth",
    quote: "Head of Growth reopened. Own demand gen and marketing ops for the next stage.",
    reposted: true,
  });
  const whyNow = deterministicWhyNow(s);
  assert.ok(isGroundedSpan(whyNow, s.quote), `whyNow must be grounded: ${whyNow}`);
  // First-sentence clause is taken.
  assert.match(whyNow.toLowerCase(), /head of growth reopened/);
});

test("every deterministic decision's whyNow is grounded in a credited signal quote", async () => {
  const signals = [
    signal({
      accountDomain: "apexnorth.agency",
      bucket: "funding",
      trigger: "raised Series B",
      quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
    }),
    signal({
      accountDomain: "quietco.io",
      bucket: "social",
      trigger: "liked a post",
      quote: "Their VP of Sales liked a post about pipeline hygiene last Tuesday.",
    }),
  ];
  const decisions = await judgeSignals({ signals, config: DEFAULT_SIGNALS_CONFIG, icp: ICP, now: NOW });
  for (const d of decisions) {
    const credited = signals.filter((s) => d.evidence.includes(s.id));
    assert.ok(
      credited.some((s) => isGroundedSpan(d.whyNow, s.quote)),
      `whyNow "${d.whyNow}" must be a verbatim span of a credited quote`,
    );
  }
});

// ---------------------------------------------------------------------------
// LLM path: an UNGROUNDED whyNow falls back to the deterministic (gate works)

test("LLM path: an ungrounded whyNow is rejected after a retry and falls back to the deterministic why-now", async () => {
  const domain = "apexnorth.agency";
  const signals = [
    signal({
      accountDomain: domain,
      bucket: "funding",
      trigger: "raised Series B",
      quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
    }),
    signal({
      accountDomain: domain,
      bucket: "job",
      trigger: "reposted: Head of Growth",
      quote: "Head of Growth — own demand gen and marketing ops for the next stage of growth.",
      reposted: true,
    }),
  ];

  let calls = 0;
  // The model always returns an ungrounded whyNow (a plausible-but-fabricated
  // "trigger" not present in any quote) — the exact failure the gate exists for.
  const fetchImpl: typeof fetch = (async () => {
    calls += 1;
    const input = {
      decision: "send",
      whyNow: "your team is clearly drowning in manual pipeline work right now",
      play: "lead with the cost of a 90-day open growth seat",
    };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const decisions = await judgeSignals({
    signals,
    config: DEFAULT_SIGNALS_CONFIG,
    icp: ICP,
    promptTemplate: DEFAULT_JUDGE_PROMPT,
    llm: { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5", fetchImpl },
    now: NOW,
  });

  assert.equal(calls, 2, "gate must retry once before falling back");
  const d = decisions[0];
  // producedBy still marks the LLM provider/model (the path that ran)...
  assert.equal(d.producedBy, "llm:anthropic:claude-haiku-4-5");
  // ...but the ungrounded model whyNow was NEVER stored — we fell back to the
  // grounded deterministic span, and the fabricated play was dropped too.
  assert.notEqual(d.whyNow, "your team is clearly drowning in manual pipeline work right now");
  assert.equal(d.play, "");
  const credited = signals.filter((s) => d.evidence.includes(s.id));
  assert.ok(
    credited.some((s) => isGroundedSpan(d.whyNow, s.quote)),
    `fallback whyNow "${d.whyNow}" must be grounded in a credited quote`,
  );
});

test("LLM path: a GROUNDED whyNow is accepted on the first call and carries the model play", async () => {
  const domain = "apexnorth.agency";
  const signals = [
    signal({
      accountDomain: domain,
      bucket: "funding",
      trigger: "raised Series B",
      quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
    }),
    signal({
      accountDomain: domain,
      bucket: "job",
      trigger: "reposted: Head of Growth",
      quote: "Head of Growth — own demand gen and marketing ops for the next stage of growth.",
      reposted: true,
    }),
  ];

  let calls = 0;
  const fetchImpl: typeof fetch = (async () => {
    calls += 1;
    const input = {
      decision: "send",
      // A verbatim span of the funding quote.
      whyNow: "raised a $40M Series B led by Acme Ventures",
      // Em dash should be sanitized out by sanitizePlay.
      play: "Lead with the 90-day cost of an open growth seat — given the new round.",
    };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const decisions = await judgeSignals({
    signals,
    config: DEFAULT_SIGNALS_CONFIG,
    icp: ICP,
    promptTemplate: DEFAULT_JUDGE_PROMPT,
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    now: NOW,
  });

  assert.equal(calls, 1, "a grounded whyNow needs no retry");
  const d = decisions[0];
  assert.equal(d.whyNow, "raised a $40M Series B led by Acme Ventures");
  assert.ok(d.play.length > 0, "the model play should be carried");
  assert.ok(!d.play.includes("—"), "em dashes must be stripped from the play (voice rule)");
});

// ---------------------------------------------------------------------------
// Store: profile-scoped, append-only, owner-only

test("createFileJudgeStore: append/get/list/latest, refuses a duplicate label, FSGTM_HOME isolated", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-judge-"));
  const prev = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const dir = join(home, "judge");
    const store = createFileJudgeStore(dir);
    const run: JudgeRun = {
      id: judgeRunId("judge-2026-06-23"),
      runLabel: "judge-2026-06-23",
      signalRunLabel: "signals-2026-06-23",
      createdAt: "2026-06-23T12:00:00.000Z",
      decisions: [
        {
          accountDomain: "apexnorth.agency",
          score: 88,
          decision: "send",
          whyNow: "raised a $40M Series B led by Acme Ventures",
          play: "lead with the cost of a 90-day open growth seat",
          evidence: ["sig_abc"],
          producedBy: "deterministic",
        },
      ],
    };
    await store.appendRun(run);
    assert.deepEqual((await store.getRun("judge-2026-06-23"))?.id, run.id);
    assert.equal((await store.listRuns()).length, 1);
    assert.equal((await store.latestRun())?.runLabel, "judge-2026-06-23");

    // Append-only: a duplicate label is refused.
    await assert.rejects(() => store.appendRun(run), /append-only/);

    // A later run sorts last in latestRun.
    const run2: JudgeRun = { ...run, id: judgeRunId("judge-2026-06-24"), runLabel: "judge-2026-06-24", createdAt: "2026-06-24T00:00:00.000Z" };
    await store.appendRun(run2);
    assert.equal((await store.latestRun())?.runLabel, "judge-2026-06-24");

    // Invalid label: getRun swallows the path-validation error and reads as a
    // miss (null), but appendRun surfaces it — a traversal label can't write.
    assert.equal(await store.getRun("../escape"), null);
    await assert.rejects(() => store.appendRun({ ...run, runLabel: "../escape" }), /Invalid run label/);
  } finally {
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("judgeDir resolves under the profile credentials dir (FSGTM_HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-judge-dir-"));
  const prev = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    assert.ok(judgeDir().startsWith(home), `judgeDir should resolve under FSGTM_HOME: ${judgeDir()}`);
    assert.ok(judgeDir().endsWith("judge"));
  } finally {
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JUDGE_SCHEMA / deterministicDecision shape

test("deterministicDecision carries grounded whyNow, empty play, and the credited cluster", () => {
  const s1 = signal({ accountDomain: "x.com", bucket: "funding", trigger: "raised", quote: "X raised a $10M round this month." });
  const score: AccountScore = scoreAccount({
    accountDomain: "x.com",
    signals: [s1],
    weights: { demand: 2, funding: 1.6, job: 1, company: 1, social: 0.4 },
    now: NOW,
  });
  const d = deterministicDecision(score);
  assert.equal(d.producedBy, "deterministic");
  assert.equal(d.play, "");
  assert.ok(isGroundedSpan(d.whyNow, s1.quote));
  assert.deepEqual(d.evidence, [s1.id]);
});

test("JUDGE_SCHEMA constrains decision to the three kinds", () => {
  const enumVals = (JUDGE_SCHEMA.properties.decision as { enum: readonly string[] }).enum;
  assert.deepEqual([...enumVals].sort(), ["nurture", "send", "skip"]);
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { createFilePlanStore } from "../src/planStore.ts";
import {
  normalizeTranscript,
  parseCall,
  suggestCallDeal,
} from "../src/calls.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

process.env.FSGTM_NO_BROWSER = "1";

const SPEAKER_TRANSCRIPT = `Rep: Thanks for the time today. What's the hardest part of your current process?
Customer: Honestly we're struggling with manual CRM updates, it takes too much time.
Customer: And pricing matters — our budget review is next month.
Rep: Got it. Next step, I'll send over the proposal by Friday and we can schedule the security review.`;

const GRANOLA_UTTERANCES = JSON.stringify([
  { text: "What's blocking the rollout?", source: "microphone", start_timestamp: "2026-06-11T01:00:00Z" },
  { text: "We're worried about the security review and the timing.", source: "system" },
  { text: "I'll follow up with the compliance doc tomorrow.", source: "microphone" },
]);

function snapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    users: [{ id: "u1", name: "Ryan", active: true }],
    accounts: [
      { id: "a1", name: "Acme Corp", domain: "acme.com" },
      { id: "a2", name: "Globex", domain: "globex.io" },
    ],
    contacts: [{ id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", accountId: "a1" }],
    deals: [
      { id: "d1", name: "Acme Expansion", accountId: "a1", nextStep: "", lastActivityAt: "2026-06-01T00:00:00.000Z" },
      { id: "d2", name: "Acme Renewal", accountId: "a1", isClosed: true, isWon: true },
      { id: "d3", name: "Globex Pilot", accountId: "a2", lastActivityAt: "2026-05-01T00:00:00.000Z" },
    ],
    activities: [],
  };
}

test("normalizeTranscript converts Granola utterance JSON to [Me]/[Them] lines", () => {
  const text = normalizeTranscript(GRANOLA_UTTERANCES);
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[Me\]: What's blocking/);
  assert.match(lines[1], /^\[Them\]: We're worried about the security review/);
  assert.match(lines[2], /^\[Me\]: I'll follow up/);
  // Plain text passes through untouched.
  assert.equal(normalizeTranscript(SPEAKER_TRANSCRIPT), SPEAKER_TRANSCRIPT);
});

test("normalizeTranscript handles Granola's colon-less '[Speaker] text' export format", () => {
  const granolaText = "# Abhisek / Ryan\nDate: 2026-04-03\n\n[Them] We're struggling with manual reporting.\n[Me] I'll send over the proposal next week.";
  const parsed = parseCall(granolaText);
  const bracketSegments = parsed.segments.filter((s) => s.speaker === "Them" || s.speaker === "Me");
  assert.equal(bracketSegments.length, 2);
  const types = new Set(parsed.insights.map((i) => i.type));
  assert.ok(types.has("pain_point"));
  assert.ok(types.has("next_step"));
});

test("parseCall is deterministic and yields insights plus GtmEvidence", () => {
  const first = parseCall(SPEAKER_TRANSCRIPT, { title: "Disco", sourceSystem: "fathom" });
  const second = parseCall(SPEAKER_TRANSCRIPT, { title: "Disco", sourceSystem: "fathom" });
  assert.equal(first.id, second.id);
  assert.deepEqual(first.evidence.map((e) => e.id), second.evidence.map((e) => e.id));

  const types = new Set(first.insights.map((insight) => insight.type));
  assert.ok(types.has("pain_point"));
  assert.ok(types.has("pricing"));
  assert.ok(types.has("next_step"));
  assert.equal(first.evidence.length, first.insights.length);
  for (const item of first.evidence) {
    assert.equal(item.sourceSystem, "fathom");
    assert.equal(item.sourceObjectType, "call");
    assert.equal(item.sourceObjectId, first.id);
    assert.ok(item.text.length > 0);
  }
});

test("parseCall handles Granola JSON end to end (roles from [Me]/[Them])", () => {
  const parsed = parseCall(GRANOLA_UTTERANCES, { sourceSystem: "granola" as never });
  assert.equal(parsed.segments.length, 3);
  assert.equal(parsed.segments[0].speaker, "Me");
  // [Them] said the risk/objection line; the insight should carry that speaker.
  const risky = parsed.insights.find((insight) => insight.type === "objection" || insight.type === "risk");
  assert.ok(risky);
  assert.equal(risky.speaker, "Them");
});

test("suggestCallDeal: single open deal on a domain-matched account is high confidence", () => {
  const bySingle = suggestCallDeal(snapshot(), { attendeeEmails: ["jane@acme.com"] });
  assert.equal(bySingle.confidence, "high");
  assert.equal(bySingle.dealId, "d1");
  assert.match(bySingle.reason, /only open deal/);

  const byDomain = suggestCallDeal(snapshot(), { domain: "globex.io" });
  assert.equal(byDomain.confidence, "high");
  assert.equal(byDomain.dealId, "d3");

  const miss = suggestCallDeal(snapshot(), { domain: "nowhere.dev" });
  assert.equal(miss.confidence, "none");
  assert.equal(miss.dealId, null);
});

test("suggestCallDeal: multiple open deals fall to low confidence, most recent first", () => {
  const snap = snapshot();
  snap.deals.push({ id: "d4", name: "Acme Phase 2", accountId: "a1", lastActivityAt: "2026-06-10T00:00:00.000Z" });
  const s = suggestCallDeal(snap, { domain: "acme.com" });
  assert.equal(s.confidence, "low");
  assert.equal(s.dealId, "d4");
  assert.match(s.reason, /most recent activity/);
});

test("CLI chain: call parse --out, call plan --save produces an approvable next-step plan", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-calls-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const transcriptPath = join(home, "call.txt");
    writeFileSync(transcriptPath, SPEAKER_TRANSCRIPT);
    const snapPath = join(home, "snap.json");
    writeFileSync(snapPath, JSON.stringify(snapshot()));
    const parsedPath = join(home, "parsed.json");

    await runCli(["call", "parse", "--deterministic", "--transcript", transcriptPath, "--title", "Disco", "--out", parsedPath]);
    await runCli(["call", "plan", "--call", parsedPath, "--deal", "d1", "--input", snapPath, "--save"]);

    const store = createFilePlanStore();
    const [stored] = await store.list();
    assert.ok(stored, "call plan --save stored a plan");
    assert.equal(stored.plan.findings.length, 1);
    assert.equal(stored.plan.findings[0].type, "call_next_step_not_reflected_in_crm");
    const nextStepOp = stored.plan.operations.find((op) => op.field === "nextStep");
    assert.ok(nextStepOp);
    assert.equal(nextStepOp.beforeValue, null);
    assert.match(String(nextStepOp.afterValue), /proposal by Friday/i);
    assert.equal(nextStepOp.approvalRequired, true);
    assert.equal(nextStepOp.riskLevel, "high");
    assert.ok((stored.plan.evidence ?? []).length > 0, "plan carries the call evidence");

    // The standard lifecycle continues from here.
    await runCli(["plans", "approve", stored.plan.id, "--operations", nextStepOp.id]);
    const approved = await store.get(stored.plan.id);
    assert.equal(approved?.status, "approved");
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
  }
});

test("ndjson rows carry extractor provenance; score-specific no-key error; call --help works", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-calls2-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const transcriptPath = join(home, "call.txt");
    writeFileSync(transcriptPath, SPEAKER_TRANSCRIPT);

    // NDJSON rows include extractor.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      await runCli(["call", "parse", "--deterministic", "--transcript", transcriptPath, "--ndjson"]);
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.length > 0);
    for (const line of logs) assert.equal(JSON.parse(line).extractor, "deterministic");

    // score has no --deterministic mode and says so (no misleading suggestion).
    await assert.rejects(
      runCli(["call", "score", "--transcript", transcriptPath]),
      (error: Error) => {
        assert.match(error.message, /no non-LLM mode/);
        assert.doesNotMatch(error.message, /--deterministic for the free keyword baseline/);
        return true;
      },
    );

    // call --help prints help instead of executing.
    const helpLogs: string[] = [];
    console.log = (msg: unknown) => helpLogs.push(String(msg));
    try {
      await runCli(["call", "score", "--help"]);
    } finally {
      console.log = origLog;
    }
    assert.match(helpLogs.join("\n"), /score always needs a key/);
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
  }
});

test("suggestCallDeal surfaces resolvedVia + matched contacts (be clear which join matched)", () => {
  const base: CanonicalGtmSnapshot = {
    generatedAt: "t",
    provider: "hubspot",
    users: [],
    accounts: [{ id: "acct", name: "Acme", domain: "acme.com" }],
    contacts: [{ id: "con", accountId: "acct", email: "vp@acme.com", title: "VP" }],
    deals: [{ id: "deal", accountId: "acct", name: "Acme Renewal", isClosed: false }],
    activities: [],
  };
  // Account domain AND a contact email both match → "both".
  const both = suggestCallDeal(base, { domain: "acme.com" });
  assert.equal(both.dealId, "deal");
  assert.equal(both.resolvedVia, "both");

  // Account has no domain → matched only via the contact's email.
  const noDomain = { ...base, accounts: [{ id: "acct", name: "Acme" }] };
  const byEmail = suggestCallDeal(noDomain, { attendeeEmails: ["vp@acme.com"] });
  assert.equal(byEmail.resolvedVia, "contact_email");
  assert.deepEqual(byEmail.matchedContacts, [{ id: "con", email: "vp@acme.com", accountId: "acct" }]);
});

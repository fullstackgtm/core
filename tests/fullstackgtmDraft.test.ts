import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DRAFT_PROMPT,
  DEFAULT_FRESHNESS_DAYS,
  DRAFT_CHANNELS,
  DRAFT_SCHEMA,
  authorOpeners,
  creditedTriggerSignal,
  deterministicOpener,
  draft,
  draftEvidence,
  draftEvidenceId,
  draftOpenerLlm,
  draftOperationId,
  firstLine,
  firstLineGroundedInTrigger,
  hasBannedGreeting,
  isStaleTrigger,
  sanitizeOpener,
} from "../src/draft.ts";
import type { JudgeDecision } from "../src/judge.ts";
import { signalId, type Signal } from "../src/signals.ts";
import { createFilePlanStore } from "../src/planStore.ts";

// Force the deterministic path unless a test explicitly injects an LLM seam.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const NOW = new Date("2026-06-23T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Fixture builders

function signal(
  over: Partial<Signal> & { accountDomain: string; bucket: Signal["bucket"]; trigger: string; quote: string },
): Signal {
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
    judgedBy: over.judgedBy ?? null,
    ...(over.reposted ? { reposted: true } : {}),
    ...(over.roleKey ? { roleKey: over.roleKey } : {}),
  };
}

/** A judge `send` decision grounded in the given signal's quote span. */
function sendDecision(
  s: Signal,
  over: Partial<JudgeDecision> = {},
): JudgeDecision {
  return {
    accountDomain: s.accountDomain,
    // A resolved CRM target by default (the account is in the CRM, with a
    // contact to reach) — tests that exercise the domain-only path pass
    // `{ accountId: undefined, contact: undefined }` to clear it.
    accountId: `acct-${s.accountDomain}`,
    contact: { id: `con-${s.accountDomain}`, email: `lead@${s.accountDomain}` },
    score: over.score ?? 88,
    decision: over.decision ?? "send",
    // whyNow is a verbatim span of the signal quote (the judge guarantees this).
    whyNow: over.whyNow ?? s.quote.slice(0, 48),
    play: over.play ?? "",
    evidence: over.evidence ?? [s.id],
    producedBy: over.producedBy ?? "deterministic",
    ...(over.skippedReason !== undefined ? { skippedReason: over.skippedReason } : {}),
    ...over,
  };
}

function anthropicFetch(opener: string, counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls += 1;
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input: { opener } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Pure helpers

test("DRAFT_CHANNELS and DRAFT_SCHEMA shape", () => {
  assert.deepEqual([...DRAFT_CHANNELS].sort(), ["email", "linkedin", "task"]);
  assert.deepEqual([...(DRAFT_SCHEMA as unknown as { required: string[] }).required], ["opener"]);
});

test("firstLine returns the first non-empty line", () => {
  assert.equal(firstLine("\n  Saw you reopened the role.\nMore body."), "Saw you reopened the role.");
  assert.equal(firstLine("   "), "");
});

test("sanitizeOpener strips em dashes and collapses intra-line whitespace, keeps line breaks", () => {
  const cleaned = sanitizeOpener("Line   one — here.\n\n\nLine two.  ");
  assert.ok(!cleaned.includes("—"), "em dash stripped");
  assert.match(cleaned, /Line one - here\./);
  // Line break preserved (line 1 must survive intact for the gate).
  assert.equal(firstLine(cleaned), "Line one - here.");
});

test("hasBannedGreeting catches the Hi {{firstName}} placeholder", () => {
  assert.ok(hasBannedGreeting("Hi {{firstName}}, saw your round."));
  assert.ok(hasBannedGreeting("hi {{ FirstName }} there"));
  assert.equal(hasBannedGreeting("Saw you reopened the Head of Growth search."), false);
});

test("firstLineGroundedInTrigger enforces a verbatim >=12-char span of the whyNow in line 1", () => {
  const whyNow = "reopened the Head of Growth search after the first hire fell through";
  assert.ok(
    firstLineGroundedInTrigger("Saw you reopened the Head of Growth search after the first hire fell through.\nQuick thought.", whyNow),
  );
  // Body grounds but line 1 does not -> rejected.
  assert.equal(
    firstLineGroundedInTrigger("Quick question for you.\nYou reopened the Head of Growth search.", whyNow),
    false,
  );
});

test("isStaleTrigger flags signals older than the freshness window; an undateable trigger is stale", () => {
  const fresh = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const old = new Date(NOW.getTime() - (DEFAULT_FRESHNESS_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isStaleTrigger(fresh, NOW), false);
  assert.equal(isStaleTrigger(old, NOW), true);
  assert.equal(isStaleTrigger("not-a-date", NOW), true);
});

test("deterministicOpener is a clearly-labeled stub, never fake authored copy", () => {
  const s = signal({
    accountDomain: "apexnorth.agency",
    bucket: "funding",
    trigger: "raised Series B",
    quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
  });
  const d = sendDecision(s, { whyNow: "raised a $40M Series B led by Acme Ventures", play: "lead with the cost of an open growth seat" });
  const opener = deterministicOpener(d);
  assert.match(opener, /^\[\[DRAFT - no LLM key\]\]/, "stub must be clearly labeled");
  assert.match(opener, /raised a \$40M Series B led by Acme Ventures/);
  assert.match(opener, /→ lead with the cost of an open growth seat/);
  // The stub grounds line 1 by construction.
  assert.ok(firstLineGroundedInTrigger(opener, d.whyNow));
});

test("draftEvidence carries the verbatim quote and web/manual sourceSystem", () => {
  const fetched = signal({ accountDomain: "x.com", bucket: "job", trigger: "hiring: VP Sales", quote: "VP Sales - own new logo revenue.", source: "lever" });
  const ingested = signal({ accountDomain: "y.com", bucket: "funding", trigger: "raised", quote: "Y raised a $10M round.", source: "ingest" });
  const evF = draftEvidence(fetched, NOW.toISOString());
  const evI = draftEvidence(ingested, NOW.toISOString());
  assert.equal(evF.sourceSystem, "web");
  assert.equal(evI.sourceSystem, "manual");
  assert.equal(evF.text, fetched.quote, "evidence text is the verbatim signal quote");
  assert.equal(evF.id, draftEvidenceId(fetched.id));
});

test("creditedTriggerSignal prefers the credited signal whose quote grounds the whyNow", () => {
  const funding = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised", quote: "ApexNorth raised a $40M Series B this week." });
  const job = signal({ accountDomain: "apexnorth.agency", bucket: "job", trigger: "hiring: Head of Growth", quote: "Head of Growth - own demand gen and marketing ops." });
  const byId = new Map([funding, job].map((s) => [s.id, s]));
  const d = sendDecision(funding, { whyNow: "raised a $40M Series B this week", evidence: [job.id, funding.id] });
  assert.equal(creditedTriggerSignal(d, byId)?.id, funding.id, "should pick the quote that grounds the whyNow, not just the first credit");
});

// ---------------------------------------------------------------------------
// draft(): one create_task op per hot account, evidence chain, gates

test("draft emits exactly one create_task op per hot account, each carrying evidence on the plan", () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const beacon = signal({ accountDomain: "beacon.io", bucket: "job", trigger: "reposted: VP Sales", quote: "VP Sales reopened - own all of new logo revenue for the next stage.", reposted: true });
  const cold = signal({ accountDomain: "coldco.com", bucket: "social", trigger: "liked a post", quote: "Someone there liked a post about pipeline hygiene." });

  const dApex = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures", score: 92 });
  const dBeacon = sendDecision(beacon, { whyNow: "VP Sales reopened - own all of new logo revenue", score: 84 });
  // A nurture decision must NOT produce a draft.
  const dCold = sendDecision(cold, { decision: "nurture", whyNow: "liked a post about pipeline hygiene", score: 60 });

  const signalsById = new Map([apex, beacon, cold].map((s) => [s.id, s]));
  const result = draft({ decisions: [dApex, dBeacon, dCold], signalsById, now: NOW });

  // One op per hot account (apex, beacon) — the nurture is dropped.
  assert.equal(result.plan.operations.length, 2);
  // The op targets the resolved CONTACT id — never the domain.
  const targets = result.plan.operations.map((o) => o.objectId).sort();
  assert.deepEqual(targets, ["con-apexnorth.agency", "con-beacon.io"]);
  assert.ok(result.plan.operations.every((o) => o.objectType === "contact"));

  for (const op of result.plan.operations) {
    assert.equal(op.operation, "create_task");
    assert.equal(op.field, "follow_up_task");
    assert.equal(op.beforeValue, null);
    assert.equal(op.riskLevel, "low");
    assert.equal(op.approvalRequired, true, "a draft is never auto-applied");
    assert.match(op.sourceRuleOrPolicy ?? "", /^draft:task$/);
    assert.match(op.reason, /Signal-grounded opener for/);
    // evidenceIds present and the matching GtmEvidence is on the plan.
    assert.ok(op.evidenceIds && op.evidenceIds.length === 1, "op carries one evidence id");
    const ev = (result.plan.evidence ?? []).find((e) => e.id === op.evidenceIds![0]);
    assert.ok(ev, "plan.evidence has the matching GtmEvidence");
    assert.ok(ev!.text.length > 0, "evidence carries the verbatim signal quote");
    // afterValue is the opener, capped to 255 chars.
    assert.ok(String(op.afterValue).length <= 255);
  }

  assert.equal(result.plan.status, "needs_approval");
  assert.equal(result.plan.dryRun, true);
  assert.equal(result.plan.findings.length, 0);
});

test("draft op afterValue (the opener) grounds its first line in the whyNow trigger", () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const result = draft({ decisions: [d], signalsById: new Map([[apex.id, apex]]), now: NOW });
  const opener = String(result.plan.operations[0].afterValue);
  assert.ok(firstLineGroundedInTrigger(opener, d.whyNow), `first line must ground in the trigger: ${opener}`);
});

test("draft flags a stale trigger in the op reason (self-discard rule)", () => {
  const oldIso = new Date(NOW.getTime() - (DEFAULT_FRESHNESS_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString();
  const stale = signal({
    accountDomain: "apexnorth.agency",
    bucket: "funding",
    trigger: "raised Series B",
    quote: "ApexNorth raised a $40M Series B led by Acme Ventures.",
    firstSeen: oldIso,
  });
  const d = sendDecision(stale, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const result = draft({ decisions: [d], signalsById: new Map([[stale.id, stale]]), now: NOW });
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].staleTrigger, true);
  assert.match(result.plan.operations[0].reason, /staleTrigger/);
});

test("no-key path: the staged opener is the clearly-labeled stub", () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures", play: "lead with the open growth seat" });
  const result = draft({ decisions: [d], signalsById: new Map([[apex.id, apex]]), now: NOW });
  assert.match(String(result.plan.operations[0].afterValue), /^\[\[DRAFT - no LLM key\]\]/);
  assert.equal(result.drafts[0].producedBy, "deterministic");
});

test("draft channel selects the sourceRuleOrPolicy and op id namespace", () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const result = draft({ decisions: [d], signalsById: new Map([[apex.id, apex]]), channel: "linkedin", now: NOW });
  assert.equal(result.plan.operations[0].sourceRuleOrPolicy, "draft:linkedin");
  assert.equal(result.plan.operations[0].id, draftOperationId("linkedin", "apexnorth.agency"));
});

test("an opener whose first line is ungrounded is rejected, never staged as an op", () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  // Inject an opener whose first line does NOT contain a whyNow span.
  const openers = new Map([
    ["apexnorth.agency", { opener: "Quick thought for you this morning.\nYou raised a $40M Series B led by Acme Ventures.", producedBy: "llm:anthropic:test", grounded: true, signalId: apex.id }],
  ]);
  const result = draft({ decisions: [d], signalsById: new Map([[apex.id, apex]]), openers, now: NOW });
  assert.equal(result.plan.operations.length, 0, "ungrounded first line -> no op");
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /first line/);
  // With nothing staged, the plan is a draft, not needs_approval.
  assert.equal(result.plan.status, "draft");
});

// ---------------------------------------------------------------------------
// authorOpeners + LLM gate

test("authorOpeners (no llm) yields the deterministic stub for each hot account", async () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const openers = await authorOpeners({ decisions: [d], signalsById: new Map([[apex.id, apex]]) });
  const authored = openers.get("apexnorth.agency");
  assert.ok(authored);
  assert.match(authored!.opener, /^\[\[DRAFT - no LLM key\]\]/);
  assert.equal(authored!.producedBy, "deterministic");
});

test("LLM path: a grounded opener is accepted on the first call and staged as the op body", async () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const counter = { calls: 0 };
  // Line 1 contains a verbatim whyNow span; an em dash that must be stripped.
  const llmOpener = "Saw you raised a $40M Series B led by Acme Ventures — congrats.\nMost teams hit a pipeline-data gap right after a raise; worth 15 minutes?";
  const { opener, producedBy, grounded } = await draftOpenerLlm(
    d,
    apex,
    DEFAULT_DRAFT_PROMPT,
    { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5", fetchImpl: anthropicFetch(llmOpener, counter) },
  );
  assert.equal(counter.calls, 1, "a grounded opener needs no retry");
  assert.equal(grounded, true);
  assert.equal(producedBy, "llm:anthropic:claude-haiku-4-5");
  assert.ok(!opener.includes("—"), "em dashes stripped (voice rule)");
  assert.ok(firstLineGroundedInTrigger(opener, d.whyNow));
});

test("LLM path: an ungrounded opener is rejected after one retry and falls back to the labeled stub", async () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const counter = { calls: 0 };
  // The model always returns an opener whose first line is NOT a whyNow span.
  const fetchImpl: typeof fetch = (async () => {
    counter.calls += 1;
    const input = { opener: "Hope your week is going well.\nNoticed some momentum over there lately." };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const { opener, producedBy, grounded } = await draftOpenerLlm(
    d,
    apex,
    DEFAULT_DRAFT_PROMPT,
    { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
  );
  assert.equal(counter.calls, 2, "the gate must retry once before falling back");
  assert.equal(grounded, false);
  assert.match(opener, /^\[\[DRAFT - no LLM key\]\]/, "ungrounded LLM copy is never stored — fall back to the stub");
  assert.match(producedBy, /^llm:anthropic:/, "producedBy still marks the path that ran");
});

test("LLM path: an opener using the banned greeting is rejected", async () => {
  const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
  const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
  const counter = { calls: 0 };
  // First line grounds, but it opens with the banned greeting placeholder.
  const llmOpener = "Hi {{firstName}}, saw you raised a $40M Series B led by Acme Ventures.\nWorth a chat?";
  const { grounded } = await draftOpenerLlm(
    d,
    apex,
    DEFAULT_DRAFT_PROMPT,
    { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl: anthropicFetch(llmOpener, counter) },
  );
  assert.equal(counter.calls, 2, "banned greeting fails the gate and retries");
  assert.equal(grounded, false, "a greeting-placeholder opener is never accepted");
});

// ---------------------------------------------------------------------------
// --save persists a needs_approval plan readable via the plan store

test("draft --save persists a needs_approval plan readable via createFilePlanStore().list()", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-draft-"));
  const prev = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const apex = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week." });
    const d = sendDecision(apex, { whyNow: "raised a $40M Series B led by Acme Ventures" });
    const { plan } = draft({ decisions: [d], signalsById: new Map([[apex.id, apex]]), now: NOW });

    const store = createFilePlanStore(join(home, "plans"));
    const saved = await store.save(plan);
    assert.equal(saved.status, "needs_approval");

    const listed = await store.list("needs_approval");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].plan.id, plan.id);
    assert.equal(listed[0].plan.operations.length, 1);
    assert.equal(listed[0].plan.operations[0].operation, "create_task");
    // The evidence chain survives the round-trip through the store.
    const op = listed[0].plan.operations[0];
    const ev = (listed[0].plan.evidence ?? []).find((e) => e.id === op.evidenceIds![0]);
    assert.ok(ev, "the GtmEvidence is persisted with the plan");
    // No run has been recorded — nothing applied, nothing sent.
    assert.equal(listed[0].runs.length, 0);
  } finally {
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Object-type coherence: draft writes against a REAL record id, never a domain

test("draft targets the account when no contact resolved, and rejects domain-only decisions", () => {
  const acctOnly = signal({ accountDomain: "acctonly.com", bucket: "funding", trigger: "raised", quote: "AcctOnly raised a $20M round this week." });
  const domainOnly = signal({ accountDomain: "newco.com", bucket: "funding", trigger: "raised", quote: "NewCo raised a seed round this week." });

  // accountId present, no contact → op hangs off the ACCOUNT.
  const dAcct = sendDecision(acctOnly, { whyNow: "raised a $20M round", contact: undefined });
  // neither accountId nor contact (account not in CRM) → must be rejected.
  const dDomain = sendDecision(domainOnly, { whyNow: "raised a seed round", accountId: undefined, contact: undefined });

  const signalsById = new Map([acctOnly, domainOnly].map((s) => [s.id, s]));
  const result = draft({ decisions: [dAcct, dDomain], signalsById, now: NOW });

  assert.equal(result.plan.operations.length, 1, "only the account-resolved decision produces an op");
  const op = result.plan.operations[0];
  assert.equal(op.objectType, "account");
  assert.equal(op.objectId, "acct-acctonly.com");

  const rej = result.rejected.find((r) => r.accountDomain === "newco.com");
  assert.ok(rej, "the domain-only decision is rejected, not emitted");
  assert.match(rej!.reason, /not in the CRM — acquire it first/);
});

test("draft NEVER emits a contact-typed op carrying a domain (coherence invariant)", () => {
  const a = signal({ accountDomain: "apexnorth.agency", bucket: "funding", trigger: "raised Series B", quote: "ApexNorth raised a $40M Series B this week." });
  const result = draft({
    decisions: [sendDecision(a, { whyNow: "raised a $40M Series B" })],
    signalsById: new Map([[a.id, a]]),
    now: NOW,
  });
  for (const op of result.plan.operations) {
    // objectId must be the resolved record id of its declared type — never the
    // bare account domain (the incoherence this fix removes).
    assert.notEqual(op.objectId, "apexnorth.agency", "op must not target the bare domain");
    if (op.objectType === "contact") assert.ok(op.objectId.startsWith("con-"));
    if (op.objectType === "account") assert.ok(op.objectId.startsWith("acct-"));
  }
});

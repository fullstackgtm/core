import type { Rubric, ScoreBand } from "./llm.ts";

/**
 * Call-type taxonomy, a deterministic signal-based classifier, and one
 * type-specific coaching rubric per call type.
 *
 * The design mirrors the rest of the package: deterministic by default,
 * explainable, and byte-stable. `classifyCall` reads a transcript and returns
 * a ranked classification with a written reason — no LLM, no key, no network —
 * so it runs free in CI and on warehouse bulk loads. The LLM tiebreak
 * (`classifyCallLlm` in llm.ts) is opt-in, for the ambiguous middle.
 *
 * Scoring a renewal against a discovery rubric is simply wrong, so each call
 * type carries its own rubric: the dimensions that matter for *that*
 * conversation, with anchored high/low examples and evidence cues that sharpen
 * the verbatim-quote grounding the scorer already requires.
 */

export type CallType =
  | "prospecting"
  | "discovery"
  | "demo"
  | "technical_validation"
  | "negotiation"
  | "closing"
  | "onboarding"
  | "check_in"
  | "renewal_expansion"
  | "qbr"
  | "internal"
  | "other";

export const CALL_TYPE_IDS: CallType[] = [
  "prospecting",
  "discovery",
  "demo",
  "technical_validation",
  "negotiation",
  "closing",
  "onboarding",
  "check_in",
  "renewal_expansion",
  "qbr",
  "internal",
  "other",
];

export type CallTypeDef = {
  id: CallType;
  name: string;
  phase: "pre_sale" | "post_sale" | "neither";
  definition: string;
  /** Phrases that, when present, argue *for* this type (lowercased, substring match). */
  signals: string[];
  /** Phrases that argue *against* this type even if a signal matched. */
  negativeSignals?: string[];
  /** Types this is commonly confused with — surfaced in the classifier reason. */
  confusedWith?: CallType[];
};

/**
 * Our own taxonomy. Signals are authored phrases, not lifted from any third
 * party; they are intentionally conservative (high-precision verbs and nouns
 * that rarely appear off-topic) so the deterministic pass is trustworthy and
 * the ambiguous remainder is handed to the LLM tiebreak rather than guessed.
 */
export const CALL_TYPES: CallTypeDef[] = [
  {
    id: "prospecting",
    name: "Prospecting / Cold Call",
    phase: "pre_sale",
    definition: "First-touch outbound; the goal is to earn a next meeting, not to sell.",
    signals: [
      "cold call",
      "reaching out",
      "caught you at a bad time",
      "do you have a minute",
      "reason for my call",
      "book some time",
      "grab 15 minutes",
      "worth a conversation",
    ],
    confusedWith: ["discovery"],
  },
  {
    id: "discovery",
    name: "Discovery",
    phase: "pre_sale",
    definition: "Scheduled conversation to uncover pain, current process, decision criteria, and the buying group.",
    signals: [
      "walk me through",
      "current process",
      "how are you handling",
      "what's the impact",
      "cost of doing nothing",
      "who else is involved",
      "decision process",
      "pain point",
      "what does success look like",
      "tell me more about",
    ],
    negativeSignals: ["share my screen", "let me show you", "pull up the demo"],
    confusedWith: ["prospecting", "demo"],
  },
  {
    id: "demo",
    name: "Demo / Solution Walkthrough",
    phase: "pre_sale",
    definition: "Product walkthrough mapped to the buyer's stated priorities.",
    signals: [
      "share my screen",
      "let me show you",
      "pull up the demo",
      "as you can see here",
      "this is where you would",
      "let me walk you through the product",
      "click into",
      "this dashboard",
    ],
    confusedWith: ["discovery", "technical_validation"],
  },
  {
    id: "technical_validation",
    name: "Technical Validation / POC",
    phase: "pre_sale",
    definition: "Buyer tests the solution against technical success criteria; security, integration, scale.",
    signals: [
      "proof of concept",
      "poc",
      "success criteria",
      "security review",
      "sso",
      "api",
      "integration",
      "data residency",
      "sandbox",
      "pilot",
      "test environment",
    ],
    confusedWith: ["demo"],
  },
  {
    id: "negotiation",
    name: "Negotiation / Pricing",
    phase: "pre_sale",
    definition: "Commercial terms, pricing, and concessions.",
    signals: [
      "discount",
      "pricing",
      "budget",
      "per seat",
      "annual contract",
      "procurement",
      "redlines",
      "payment terms",
      "come down on",
      "what can you do on price",
      "msa",
    ],
    confusedWith: ["closing"],
  },
  {
    id: "closing",
    name: "Closing / Commit",
    phase: "pre_sale",
    definition: "Final steps to signature; mutual action plan toward a close date.",
    signals: [
      "send the contract",
      "docusign",
      "signature",
      "sign by",
      "get this over the line",
      "close date",
      "ready to move forward",
      "final steps",
      "countersign",
    ],
    confusedWith: ["negotiation"],
  },
  {
    id: "onboarding",
    name: "Onboarding / Kickoff",
    phase: "post_sale",
    definition: "First post-sale working session; align on goals, owners, and timeline.",
    signals: [
      "kickoff",
      "onboarding",
      "welcome aboard",
      "implementation plan",
      "go live",
      "get you set up",
      "first 30 days",
      "rollout plan",
    ],
    confusedWith: ["check_in"],
  },
  {
    id: "check_in",
    name: "Customer Check-in / Success",
    phase: "post_sale",
    definition: "Ongoing adoption and risk review with an existing customer.",
    signals: [
      "how's it going",
      "adoption",
      "since we last spoke",
      "any blockers",
      "how are the team finding",
      "usage",
      "rolled out to",
      "health check",
    ],
    confusedWith: ["qbr", "renewal_expansion"],
  },
  {
    id: "renewal_expansion",
    name: "Renewal / Expansion",
    phase: "post_sale",
    definition: "Contract renewal and growth conversation.",
    signals: [
      "renewal",
      "renew",
      "up for renewal",
      "expansion",
      "add seats",
      "upsell",
      "additional licenses",
      "contract is ending",
      "grow the account",
    ],
    confusedWith: ["check_in", "negotiation"],
  },
  {
    id: "qbr",
    name: "Quarterly Business Review",
    phase: "post_sale",
    definition: "Strategic results review and joint planning with a customer.",
    signals: [
      "quarterly business review",
      "qbr",
      "results this quarter",
      "roi",
      "value realized",
      "executive sponsor",
      "next quarter we",
      "business review",
    ],
    confusedWith: ["check_in"],
  },
  {
    id: "internal",
    name: "Internal",
    phase: "neither",
    definition: "Same-organization teammates; not a customer conversation.",
    signals: [
      "deal review",
      "forecast call",
      "our pipeline",
      "internal sync",
      "standup",
      "let's align internally",
      "loop in our",
    ],
  },
  {
    id: "other",
    name: "Other / Unclassified",
    phase: "neither",
    definition: "No call type carried enough signal to classify confidently.",
    signals: [],
  },
];

export type CallClassification = {
  type: CallType;
  confidence: "high" | "low" | "none";
  reason: string;
  /** All types that matched at least one signal, strongest first. */
  candidates: Array<{ type: CallType; score: number; matched: string[] }>;
  method: "deterministic";
};

/**
 * Classify a call from its transcript using authored phrase signals. Pure,
 * deterministic, key-free. Score = distinct positive signals matched minus
 * distinct negative signals; the strongest type wins. Confidence is `high`
 * only when one type clearly leads (>=2 signals and a >=2 margin over the
 * runner-up); a single weak signal yields `low`; no signal yields `other`/none.
 */
export function classifyCall(transcript: string): CallClassification {
  const haystack = transcript.toLowerCase();
  const scored: Array<{ type: CallType; score: number; matched: string[] }> = [];
  for (const def of CALL_TYPES) {
    if (def.signals.length === 0) continue;
    const matched = def.signals.filter((signal) => haystack.includes(signal));
    if (matched.length === 0) continue;
    const penalties = (def.negativeSignals ?? []).filter((signal) => haystack.includes(signal)).length;
    const score = matched.length - penalties;
    if (score <= 0) continue;
    scored.push({ type: def.id, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || CALL_TYPE_IDS.indexOf(a.type) - CALL_TYPE_IDS.indexOf(b.type));

  if (scored.length === 0) {
    return {
      type: "other",
      confidence: "none",
      reason: "No call-type signals matched the transcript. Classify by hand with --call-type, or run --llm for a model tiebreak.",
      candidates: [],
      method: "deterministic",
    };
  }

  const top = scored[0];
  const runnerUp = scored[1];
  const margin = top.score - (runnerUp?.score ?? 0);
  const def = CALL_TYPES.find((d) => d.id === top.type)!;
  const matchedList = top.matched.slice(0, 4).map((m) => `"${m}"`).join(", ");

  if (top.score >= 2 && margin >= 2) {
    return {
      type: top.type,
      confidence: "high",
      reason: `${def.name}: matched ${top.score} signals (${matchedList})${runnerUp ? `; clear of ${runnerUp.type} by ${margin}` : ""}.`,
      candidates: scored,
      method: "deterministic",
    };
  }
  const confused = def.confusedWith?.length ? ` Easily confused with ${def.confusedWith.join("/")}.` : "";
  return {
    type: top.type,
    confidence: "low",
    reason: `${def.name} is the leading guess (signals: ${matchedList})${runnerUp ? `, but ${runnerUp.type} also matched (${runnerUp.score})` : ""}.${confused} Confirm with --call-type or --llm.`,
    candidates: scored,
    method: "deterministic",
  };
}

// ── Type-specific rubric presets ───────────────────────────────────────────

/** Shared qualitative bands over a 1-5 weighted overall. */
export const BANDS_5: ScoreBand[] = [
  { label: "strong", min: 4, meaning: "Coach-the-team example; replicate what worked." },
  { label: "solid", min: 3, meaning: "Competent call with one or two clear gaps to close." },
  { label: "developing", min: 2, meaning: "Real gaps in the moments that move the deal." },
  { label: "weak", min: 0, meaning: "Missed the core job of this call type — prioritize coaching here." },
];

/**
 * Pick the qualitative band for a weighted overall: the highest band whose
 * `min` the score reaches. Deterministic, client-side — same input, same band.
 */
export function bandForScore(score: number, bands: ScoreBand[]): ScoreBand | undefined {
  return [...bands].sort((a, b) => b.min - a.min).find((band) => score >= band.min);
}

const RUBRICS: Partial<Record<CallType, Rubric>> = {
  prospecting: {
    scale: 5,
    name: "Prospecting / Cold Call",
    callType: "prospecting",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Opener & Permission",
        weight: 1.2,
        rubric: "Did the rep earn attention with a relevant reason for the call and a permission-based opener?",
        anchorsHigh: ["States a specific, researched reason tied to the prospect's role/company", "Asks for and gets permission to continue"],
        anchorsLow: ["Generic pitch with no relevance", "Plows ahead without acknowledging the interruption"],
        evidenceCues: ["reason for my call", "do you have a minute", "noticed that you"],
      },
      {
        name: "Relevance & Hook",
        weight: 1.1,
        rubric: "Was the value framed around a problem the prospect plausibly has, not a feature list?",
        anchorsHigh: ["Names a concrete pain common to the prospect's segment"],
        anchorsLow: ["Leads with product features and company history"],
      },
      {
        name: "Objection Handling",
        weight: 1,
        rubric: "Were brush-offs ('not interested', 'send an email') acknowledged and turned into a micro-conversation?",
        anchorsHigh: ["Acknowledges the objection, asks one sharp question, keeps it human"],
        anchorsLow: ["Argues, ignores, or immediately gives up"],
        evidenceCues: ["not interested", "send me an email", "we already use"],
      },
      {
        name: "Meeting Ask",
        weight: 1.2,
        rubric: "Did the rep ask for a specific, low-friction next meeting with a concrete time?",
        anchorsHigh: ["Proposes two concrete times for a short next call"],
        anchorsLow: ["Vague 'I'll follow up' with no commitment"],
        evidenceCues: ["grab 15 minutes", "does Tuesday", "book some time"],
      },
    ],
  },
  discovery: {
    scale: 5,
    name: "Discovery",
    callType: "discovery",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Depth of Pain",
        weight: 1.3,
        rubric: "Did the rep uncover concrete pain, the current process, and the cost of inaction with specifics?",
        anchorsHigh: ["Quantified pain (time/money/risk)", "Mapped the current workflow end to end"],
        anchorsLow: ["Surface-level 'it's a bit manual' with no numbers or process detail"],
        evidenceCues: ["how are you handling", "what's the impact", "cost of doing nothing", "walk me through"],
      },
      {
        name: "Decision Process & Criteria",
        weight: 1.2,
        rubric: "Were the decision criteria, timeline, and approval path surfaced?",
        anchorsHigh: ["Knows the criteria, the steps, and who signs"],
        anchorsLow: ["No idea how or when a decision gets made"],
        evidenceCues: ["decision process", "what does success look like", "by when"],
      },
      {
        name: "Buying Group",
        weight: 1.1,
        rubric: "Were the other stakeholders and the economic buyer identified — is the rep multi-threaded?",
        anchorsHigh: ["Names the buying group and plans to reach the economic buyer"],
        anchorsLow: ["Single-threaded with one champion, buyer unknown"],
        evidenceCues: ["who else is involved", "report to", "loop in"],
      },
      {
        name: "Listening Ratio",
        weight: 1,
        rubric: "Did the prospect do most of the talking, with the rep asking open questions and following threads?",
        anchorsHigh: ["Rep asks open questions and digs into answers"],
        anchorsLow: ["Rep monologues; questions are closed or leading"],
      },
      {
        name: "Next Steps & Commitment",
        weight: 1.1,
        rubric: "Did the call end with a specific, time-bound, mutually agreed next step?",
        anchorsHigh: ["Concrete next meeting booked with a purpose"],
        anchorsLow: ["'I'll send some info' with no date"],
      },
    ],
  },
  demo: {
    scale: 5,
    name: "Demo / Solution Walkthrough",
    callType: "demo",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Tailoring to Stated Needs",
        weight: 1.3,
        rubric: "Was the demo mapped to the prospect's own priorities, or a generic feature tour?",
        anchorsHigh: ["Each section ties back to a pain the buyer named"],
        anchorsLow: ["Linear feature dump unrelated to their goals"],
        evidenceCues: ["you mentioned", "back to your point about", "this solves the"],
      },
      {
        name: "Engagement & Interaction",
        weight: 1.1,
        rubric: "Did the rep check for reactions and let the buyer drive, vs. talk over a one-way screen-share?",
        anchorsHigh: ["Pauses for reactions, asks what resonates, hands over control"],
        anchorsLow: ["Uninterrupted monologue, no temperature checks"],
      },
      {
        name: "Value & Outcome Framing",
        weight: 1.2,
        rubric: "Was each capability framed as a business outcome with the buyer's numbers, not a feature?",
        anchorsHigh: ["'This saves your team X hours' tied to their stated volume"],
        anchorsLow: ["'And here we have…' feature narration"],
      },
      {
        name: "Advancing the Deal",
        weight: 1.1,
        rubric: "Did the demo end with a clear, agreed next step toward a decision?",
        anchorsHigh: ["Concrete next step (POC, stakeholder demo, proposal) booked"],
        anchorsLow: ["'Let me know what you think'"],
      },
    ],
  },
  technical_validation: {
    scale: 5,
    name: "Technical Validation / POC",
    callType: "technical_validation",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Success Criteria Defined",
        weight: 1.3,
        rubric: "Were explicit, measurable success criteria agreed before the evaluation?",
        anchorsHigh: ["Written criteria with thresholds and an owner"],
        anchorsLow: ["Open-ended 'let's try it out'"],
        evidenceCues: ["success criteria", "what would prove", "pass if"],
      },
      {
        name: "Technical Fit & Objections",
        weight: 1.2,
        rubric: "Were integration, security, and scale questions surfaced and addressed with specifics?",
        anchorsHigh: ["Concrete answers on SSO/API/data handling, risks named"],
        anchorsLow: ["Hand-waves technical concerns"],
        evidenceCues: ["sso", "api", "security review", "data residency"],
      },
      {
        name: "Scope & Timeline",
        weight: 1.1,
        rubric: "Was the POC scoped to a bounded timeline with clear exit conditions?",
        anchorsHigh: ["Fixed window, defined scope, go/no-go date"],
        anchorsLow: ["Unbounded pilot with no end"],
      },
      {
        name: "Stakeholder & Sign-off Path",
        weight: 1,
        rubric: "Is it clear who validates the result and what a pass unlocks commercially?",
        anchorsHigh: ["Names the technical approver and the next commercial step"],
        anchorsLow: ["Unknown who decides or what happens after"],
      },
    ],
  },
  negotiation: {
    scale: 5,
    name: "Negotiation / Pricing",
    callType: "negotiation",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Value Reanchoring",
        weight: 1.3,
        rubric: "When price came up, did the rep re-anchor on quantified value before discussing concessions?",
        anchorsHigh: ["Reframes cost against the ROI the buyer already agreed to"],
        anchorsLow: ["Jumps straight to discounting"],
        evidenceCues: ["come down on", "what can you do on price", "budget"],
      },
      {
        name: "Concession Discipline",
        weight: 1.2,
        rubric: "Were concessions traded for something (term, volume, timing), never given for free?",
        anchorsHigh: ["Every give has a get: 'if X then Y'"],
        anchorsLow: ["Unilateral discounts to keep the peace"],
      },
      {
        name: "Terms & Procurement Clarity",
        weight: 1.1,
        rubric: "Were the real commercial blockers (terms, procurement, legal) surfaced and sequenced?",
        anchorsHigh: ["Knows the procurement steps and owns the redline path"],
        anchorsLow: ["Surprised by process late in the deal"],
        evidenceCues: ["procurement", "redlines", "payment terms", "msa"],
      },
      {
        name: "Close Path",
        weight: 1.1,
        rubric: "Did the call end with a concrete path and date to signature?",
        anchorsHigh: ["Mutual action plan to a close date"],
        anchorsLow: ["Open-ended 'let me check internally'"],
      },
    ],
  },
  closing: {
    scale: 5,
    name: "Closing / Commit",
    callType: "closing",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Mutual Action Plan",
        weight: 1.3,
        rubric: "Is there a step-by-step plan to signature with owners and dates on both sides?",
        anchorsHigh: ["Each step has an owner and a date, buyer agreed"],
        anchorsLow: ["No plan; relies on hope"],
        evidenceCues: ["final steps", "sign by", "close date"],
      },
      {
        name: "Blocker Surfacing",
        weight: 1.2,
        rubric: "Were remaining risks (legal, security, budget approval) named and owned?",
        anchorsHigh: ["Open risks explicit with mitigation owners"],
        anchorsLow: ["Assumes it's done; risks unspoken"],
      },
      {
        name: "Commitment Test",
        weight: 1.2,
        rubric: "Did the rep test genuine commitment vs. accept a soft 'looks good'?",
        anchorsHigh: ["Confirms signature authority and timing directly"],
        anchorsLow: ["Takes enthusiasm as commitment"],
        evidenceCues: ["ready to move forward", "get this over the line"],
      },
    ],
  },
  onboarding: {
    scale: 5,
    name: "Onboarding / Kickoff",
    callType: "onboarding",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Goals & Success Definition",
        weight: 1.3,
        rubric: "Were the customer's desired outcomes and a definition of success captured?",
        anchorsHigh: ["Outcomes documented with a measurable success metric"],
        anchorsLow: ["Jumps to setup with no goal alignment"],
        evidenceCues: ["what does success look like", "first 30 days", "go live"],
      },
      {
        name: "Plan, Owners & Timeline",
        weight: 1.2,
        rubric: "Is there an implementation plan with owners and dates on both sides?",
        anchorsHigh: ["Clear milestones, named owners, go-live date"],
        anchorsLow: ["Vague 'we'll get started'"],
      },
      {
        name: "Stakeholder Alignment",
        weight: 1,
        rubric: "Are the right people engaged and roles clear (admin, end users, exec sponsor)?",
        anchorsHigh: ["Roles assigned, sponsor engaged"],
        anchorsLow: ["Single contact, unclear who does what"],
      },
      {
        name: "Risk & Adoption Setup",
        weight: 1,
        rubric: "Were early adoption risks and the path to first value identified?",
        anchorsHigh: ["Names the fastest path to first value and likely blockers"],
        anchorsLow: ["No view on adoption risk"],
      },
    ],
  },
  check_in: {
    scale: 5,
    name: "Customer Check-in / Success",
    callType: "check_in",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Adoption & Usage Read",
        weight: 1.2,
        rubric: "Did the rep get a concrete read on usage and adoption vs. a polite 'all good'?",
        anchorsHigh: ["Specifics on who uses what and how often"],
        anchorsLow: ["Accepts 'fine' with no detail"],
        evidenceCues: ["adoption", "usage", "rolled out to", "any blockers"],
      },
      {
        name: "Risk & Sentiment",
        weight: 1.3,
        rubric: "Were risks, blockers, and sentiment surfaced honestly?",
        anchorsHigh: ["Names friction and unhappy stakeholders openly"],
        anchorsLow: ["Misses or glosses over warning signs"],
      },
      {
        name: "Value Reinforcement",
        weight: 1,
        rubric: "Did the rep connect usage back to the customer's goals and realized value?",
        anchorsHigh: ["Ties activity to outcomes the customer cares about"],
        anchorsLow: ["No link to value"],
      },
      {
        name: "Next Steps & Expansion Signal",
        weight: 1,
        rubric: "Were follow-ups agreed and any expansion or renewal signal noted?",
        anchorsHigh: ["Clear next step; flags growth/renewal signals"],
        anchorsLow: ["Ends with no plan"],
      },
    ],
  },
  renewal_expansion: {
    scale: 5,
    name: "Renewal / Expansion",
    callType: "renewal_expansion",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Value Realized Case",
        weight: 1.3,
        rubric: "Did the rep make the case for value delivered before discussing renewal terms?",
        anchorsHigh: ["Concrete outcomes and ROI tied to the customer's goals"],
        anchorsLow: ["Asks to renew with no value recap"],
        evidenceCues: ["value realized", "roi", "since last year"],
      },
      {
        name: "Renewal Risk & Timing",
        weight: 1.2,
        rubric: "Were renewal risks (budget, sponsor change, competitor) and timing surfaced early?",
        anchorsHigh: ["Knows renewal date, risks, and the approval path"],
        anchorsLow: ["Renewal raised late with unknown risk"],
        evidenceCues: ["up for renewal", "contract is ending", "budget"],
      },
      {
        name: "Expansion Path",
        weight: 1.1,
        rubric: "Was a credible expansion opportunity explored and tied to need?",
        anchorsHigh: ["Expansion grounded in a real unmet need"],
        anchorsLow: ["No growth conversation, or a pushy untethered upsell"],
        evidenceCues: ["add seats", "expansion", "additional licenses"],
      },
      {
        name: "Commitment & Next Steps",
        weight: 1,
        rubric: "Did the call end with a concrete path to a signed renewal?",
        anchorsHigh: ["Agreed steps and date to renewal signature"],
        anchorsLow: ["Open-ended"],
      },
    ],
  },
  qbr: {
    scale: 5,
    name: "Quarterly Business Review",
    callType: "qbr",
    bands: BANDS_5,
    dimensions: [
      {
        name: "Results & Value Narrative",
        weight: 1.3,
        rubric: "Did the rep present quantified results against the goals set, not just activity?",
        anchorsHigh: ["Outcomes vs. targets with numbers the sponsor cares about"],
        anchorsLow: ["Activity recap with no outcome framing"],
        evidenceCues: ["results this quarter", "roi", "value realized"],
      },
      {
        name: "Executive Engagement",
        weight: 1.2,
        rubric: "Was the economic buyer / sponsor engaged in a strategic, not tactical, conversation?",
        anchorsHigh: ["Sponsor present and engaged on strategy"],
        anchorsLow: ["Only day-to-day users; no exec"],
        evidenceCues: ["executive sponsor", "business review"],
      },
      {
        name: "Forward Plan",
        weight: 1.2,
        rubric: "Was there a joint plan for next quarter tied to the customer's objectives?",
        anchorsHigh: ["Mutual goals and initiatives for next quarter agreed"],
        anchorsLow: ["No forward plan"],
        evidenceCues: ["next quarter we", "goals for"],
      },
      {
        name: "Growth & Renewal Setup",
        weight: 1,
        rubric: "Did the QBR set up renewal/expansion by reinforcing value and surfacing needs?",
        anchorsHigh: ["Naturally teed up renewal/growth from demonstrated value"],
        anchorsLow: ["Missed the opening entirely"],
      },
    ],
  },
};

/**
 * The type-specific rubric for a call type, or the generic fallback. The
 * generic rubric is intentionally discovery-leaning (the most common scored
 * call) and is what `other`/`internal`/unknown resolve to.
 */
export function rubricForCallType(type: CallType, fallback: Rubric): Rubric {
  return RUBRICS[type] ?? fallback;
}

/** All authored presets, for `--list` and docs. */
export function rubricPresets(): Rubric[] {
  return CALL_TYPE_IDS.map((id) => RUBRICS[id]).filter((r): r is Rubric => Boolean(r));
}

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { activeProfile, credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import type { AuditFindingSeverity, CanonicalGtmSnapshot, PatchPlan } from "./types.ts";

/**
 * The engagement workspace: a per-client health timeline that accrues from the
 * verb people already run (`audit --save`). State lives in the profile dir
 * (`$FSGTM_HOME[/profiles/<name>]`) alongside credentials and plans, so a
 * consultant working `--profile <client>` builds a continuous record of one
 * org's CRM health over time — not just episodic one-off audits.
 *
 * The score is DETERMINISTIC (no LLM): same plan + same snapshot → same score,
 * so it is stable in CI and comparable run-over-run.
 */

// Severity weights: a critical finding costs ~3× a warning, ~10× an info.
const SEVERITY_WEIGHT: Record<AuditFindingSeverity, number> = { info: 1, warning: 3, critical: 10 };

export type HealthEntry = {
  /** ISO timestamp of the audit that produced this entry. */
  at: string;
  /** The saved plan this entry summarizes (correlates to plans/ and snapshots/). */
  planId: string;
  /** Deterministic 0–100 hygiene score (higher is healthier). */
  score: number;
  /** Total finding count across all rules. */
  findings: number;
  /** Severity-weighted finding total (drives the score). */
  weightedFindings: number;
  /** Record counts at audit time — the denominator that normalizes the score. */
  records: { accounts: number; contacts: number; deals: number; total: number };
  /** Finding count per rule id. */
  byRule: Record<string, number>;
  /** Finding count per severity. */
  severityCounts: Record<AuditFindingSeverity, number>;
};

export type HealthRuleDelta = {
  ruleId: string;
  current: number;
  previous: number;
  /** current − previous: positive = more findings (worse), negative = fewer (better). */
  delta: number;
};

export type HealthRollup = {
  profile: string;
  auditCount: number;
  first: string;
  latest: string;
  current: HealthEntry;
  previous: HealthEntry | null;
  /** current.score − previous.score: positive = improving. null on the first audit. */
  scoreDelta: number | null;
  ruleDeltas: HealthRuleDelta[];
  history: Array<{ at: string; score: number; findings: number }>;
};

/**
 * Deterministically score a saved audit. score = 100 / (1 + weighted findings
 * per record): 0 findings → 100; one weighted finding per record → 50; the
 * curve is bounded (0, 100], monotonic, and needs no clamping or magic
 * constants. A messy 50-record CRM scores worse than the same finding count
 * across 5,000 records, which is the point.
 */
export function computeHealth(plan: PatchPlan, snapshot: CanonicalGtmSnapshot, at: string): HealthEntry {
  const byRule: Record<string, number> = {};
  const severityCounts: Record<AuditFindingSeverity, number> = { info: 0, warning: 0, critical: 0 };
  let weightedFindings = 0;
  for (const finding of plan.findings) {
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    severityCounts[finding.severity] += 1;
    weightedFindings += SEVERITY_WEIGHT[finding.severity];
  }

  const records = {
    accounts: snapshot.accounts.length,
    contacts: snapshot.contacts.length,
    deals: snapshot.deals.length,
    total: snapshot.accounts.length + snapshot.contacts.length + snapshot.deals.length,
  };

  const penalty = weightedFindings / Math.max(records.total, 1);
  const score = Math.round(100 / (1 + penalty));

  return {
    at,
    planId: plan.id,
    score,
    findings: plan.findings.length,
    weightedFindings,
    records,
    byRule,
    severityCounts,
  };
}

/** Roll a timeline up into the current state, the change since last time, and per-rule deltas. */
export function summarizeHealth(entries: HealthEntry[], profile: string): HealthRollup | null {
  if (entries.length === 0) return null;
  // Oldest → newest, so `current` is the last entry.
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const current = sorted[sorted.length - 1];
  const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  const ruleIds = new Set<string>([
    ...Object.keys(current.byRule),
    ...(previous ? Object.keys(previous.byRule) : []),
  ]);
  const ruleDeltas: HealthRuleDelta[] = [...ruleIds]
    .map((ruleId) => {
      const cur = current.byRule[ruleId] ?? 0;
      const prev = previous?.byRule[ruleId] ?? 0;
      return { ruleId, current: cur, previous: prev, delta: cur - prev };
    })
    .sort((a, b) => b.current - a.current || a.ruleId.localeCompare(b.ruleId));

  return {
    profile,
    auditCount: sorted.length,
    first: sorted[0].at,
    latest: current.at,
    current,
    previous,
    scoreDelta: previous ? current.score - previous.score : null,
    ruleDeltas,
    history: sorted.map((entry) => ({ at: entry.at, score: entry.score, findings: entry.findings })),
  };
}

// Sign-based and uniform: ▲ = the number went up, ▼ = down. The reader supplies
// the meaning (score up = good; findings up = bad) — mixing arrow direction with
// good/bad reads as contradictory ("▲ -3").
function arrow(delta: number): string {
  if (delta === 0) return "·";
  return delta > 0 ? "▲" : "▼";
}

/** Human-readable rollup: headline score + trend, then per-rule change since last audit. */
export function healthToMarkdown(rollup: HealthRollup): string {
  const { current, scoreDelta } = rollup;
  const lines = [`# GTM health — profile \`${rollup.profile}\``, ""];

  const deltaText =
    scoreDelta === null
      ? "(first audit — no prior reading)"
      : `${arrow(scoreDelta)} ${scoreDelta >= 0 ? "+" : ""}${scoreDelta} since the previous audit`;
  lines.push(
    `Score: **${current.score}/100** ${deltaText}`,
    `Audits: ${rollup.auditCount} over ${shortDate(rollup.first)} → ${shortDate(rollup.latest)}`,
    `Findings: ${current.findings} (${current.severityCounts.critical} critical, ${current.severityCounts.warning} warning, ${current.severityCounts.info} info)`,
    `Records: ${current.records.accounts} accounts, ${current.records.contacts} contacts, ${current.records.deals} deals`,
    "",
  );

  if (rollup.history.length > 1) {
    lines.push("## Trend", "");
    for (const point of rollup.history) {
      const marker = point.at === rollup.latest ? "  ← latest" : "";
      lines.push(`- ${shortDate(point.at)}  score ${point.score}  (${point.findings} findings)${marker}`);
    }
    lines.push("");
  }

  if (rollup.ruleDeltas.length > 0) {
    lines.push("## By rule (Δ since previous audit)", "", "| Rule | Findings | Δ |", "| --- | --- | --- |");
    for (const rule of rollup.ruleDeltas) {
      const sign = rule.delta > 0 ? `+${rule.delta}` : `${rule.delta}`;
      const cell = rule.delta === 0 ? "·" : `${arrow(rule.delta)} ${sign}`;
      lines.push(`| ${rule.ruleId} | ${rule.current} | ${cell} |`);
    }
    lines.push("");
  }

  lines.push("> Score is deterministic: 100 / (1 + severity-weighted findings per record). Lower findings or more clean records ⇒ higher score.");
  return `${lines.join("\n")}\n`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

// ── Profile-scoped storage ──────────────────────────────────────────────────

/** `$FSGTM_HOME[/profiles/<name>]/health.jsonl` — append-only, one entry per audit-save. */
export function healthFilePath(): string {
  return join(credentialsDir(), "health.jsonl");
}

/** `$FSGTM_HOME[/profiles/<name>]/snapshots/` — canonical snapshots correlated by plan id. */
export function snapshotsDir(): string {
  return join(credentialsDir(), "snapshots");
}

/** Append a health entry to the active profile's timeline (0600, owner-only). */
export function appendHealthEntry(entry: HealthEntry): void {
  ensureSecureHomeDir();
  appendFileSync(healthFilePath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Read the active profile's health timeline; tolerant of partial/corrupt lines. */
export function readHealthTimeline(): HealthEntry[] {
  let raw: string;
  try {
    raw = readFileSync(healthFilePath(), "utf8");
  } catch {
    return [];
  }
  const entries: HealthEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as HealthEntry);
    } catch {
      // Skip a torn line rather than failing the whole rollup.
    }
  }
  return entries;
}

/** Persist the snapshot behind a saved audit so the timeline can diff/attribute later. */
export function saveWorkspaceSnapshot(planId: string, snapshot: CanonicalGtmSnapshot): string {
  if (!/^[\w.-]+$/.test(planId)) throw new Error(`Invalid plan id: ${planId}`);
  ensureSecureHomeDir();
  const dir = snapshotsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${planId}.json`);
  writeSecureFile(path, `${JSON.stringify(snapshot)}\n`);
  return path;
}

/** The active profile name, for rollup labeling. */
export function activeWorkspaceProfile(): string {
  return activeProfile();
}

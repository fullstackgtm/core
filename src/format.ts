import type { PatchPlan, PatchPlanRun } from "./types.ts";

// `summary: true` renders only the header + the Findings-by-Rule table + an
// operation count, for read verbs like `audit` where the full per-operation
// dump (1,400+ lines on a real portal) buries the signal. Defaults to the full
// view so write-preview callers (bulk-update, fix, dedupe, plans show, MCP) —
// where you approve specific operations — keep every operation's detail.
export function patchPlanToMarkdown(plan: PatchPlan, opts: { summary?: boolean } = {}) {
  const lines = [
    `# ${plan.title}`,
    "",
    `Status: ${plan.status}`,
    `Dry run: ${plan.dryRun ? "yes" : "no"}`,
    `Summary: ${plan.summary}`,
    "",
  ];

  if (plan.findings.length > 0) {
    const byRule = new Map<string, { count: number; severity: string }>();
    for (const finding of plan.findings) {
      const entry = byRule.get(finding.ruleId) ?? { count: 0, severity: finding.severity };
      entry.count += 1;
      byRule.set(finding.ruleId, entry);
    }
    lines.push("## Findings by Rule", "", "| Rule | Findings | Severity |", "| --- | --- | --- |");
    byRule.forEach((entry, ruleId) => {
      lines.push(`| ${ruleId} | ${entry.count} | ${entry.severity} |`);
    });
    lines.push("");
  }

  if (opts.summary) {
    const ops = plan.operations.length;
    lines.push(
      ops === 0
        ? "No patch operations proposed."
        : `${ops} dry-run patch operation${ops === 1 ? "" : "s"} proposed — nothing written.`,
      "",
      "Full plan detail: re-run with `--full`.",
      "Client-ready report: `fullstackgtm report` (add `--format html` for a printable file).",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Findings", "");

  const findings = plan.pipelineFindings ?? [];
  if (findings.length > 0) {
    for (const finding of findings) {
      lines.push(
        `- **${finding.title}** (${finding.severity}, ${finding.status})`,
        `  - Finding: ${finding.type}`,
        `  - Object: ${finding.objectType}/${finding.objectId}`,
        `  - Summary: ${finding.summary}`,
        `  - Recommendation: ${finding.recommendation}`,
        `  - Evidence refs: ${formatRefs(finding.evidenceIds)}`,
        `  - Current CRM value: ${formatValue(finding.currentCrmValue)}`,
        `  - Proposed value: ${formatValue(finding.proposedValue)}`,
        `  - Source freshness: ${formatFreshness(finding.freshness)}`,
        `  - Patch eligible: ${finding.patchEligibility.eligible ? "yes" : "no"} (${finding.patchEligibility.reason})`,
      );
    }
    const pipelineFindingIds = new Set(findings.map((finding) => finding.id));
    const otherFindings = plan.findings.filter((finding) => !pipelineFindingIds.has(finding.id));
    if (otherFindings.length > 0) {
      lines.push("", "### Other Findings", "");
      for (const finding of otherFindings) {
        lines.push(
          `- **${finding.title}** (${finding.severity})`,
          `  - Object: ${finding.objectType}/${finding.objectId}`,
          `  - Rule: ${finding.ruleId}`,
          `  - Summary: ${finding.summary}`,
          `  - Recommendation: ${finding.recommendation}`,
        );
      }
    }
  } else if (plan.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of plan.findings) {
      lines.push(
        `- **${finding.title}** (${finding.severity})`,
        `  - Object: ${finding.objectType}/${finding.objectId}`,
        `  - Rule: ${finding.ruleId}`,
        `  - Summary: ${finding.summary}`,
        `  - Recommendation: ${finding.recommendation}`,
      );
    }
  }

  if (plan.evidence && plan.evidence.length > 0) {
    lines.push("", "## Evidence", "");
    for (const evidence of plan.evidence) {
      lines.push(
        `- **${evidence.id}** ${evidence.sourceSystem}:${evidence.sourceObjectType}/${evidence.sourceObjectId}`,
        `  - Object: ${evidence.objectType ?? "unknown"}/${evidence.objectId ?? "unknown"}`,
        `  - Text: ${evidence.text}`,
        `  - Freshness: ${evidence.freshness ? formatFreshness(evidence.freshness) : "unknown"}`,
      );
    }
  }

  lines.push("", "## Proposed Patch Operations", "");
  if (plan.operations.length === 0) {
    lines.push("No patch operations proposed.");
  } else {
    for (const operation of plan.operations) {
      lines.push(
        `- **${operation.operation}** ${operation.objectType}/${operation.objectId}`,
        `  - ID: ${operation.id}`,
        `  - Field/action: ${operation.field ?? operation.operation}`,
        `  - Findings: ${formatRefs(operation.findingIds)}`,
        `  - Evidence refs: ${formatRefs(operation.evidenceIds)}`,
        `  - Before: ${formatValue(operation.beforeValue)}`,
        `  - After: ${formatValue(operation.afterValue)}`,
        `  - Reason: ${operation.reason}`,
        `  - Source rule/policy: ${operation.sourceRuleOrPolicy ?? "unspecified"}`,
        `  - Risk: ${operation.riskLevel}`,
        `  - Approval required: ${operation.approvalRequired ? "yes" : "no"}`,
        `  - Rollback: ${operation.rollback ?? "restore prior value if apply is rejected or verification fails"}`,
        `  - Verification: ${formatVerification(operation.verification)}`,
      );
    }
  }

  lines.push(
    "",
    "> Dry-run plan — read-only. No provider write happens until you approve specific operations and run `apply`; placeholder values are refused without an explicit override. These safety invariants are not beta.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatPatchPlanRun(run: PatchPlanRun) {
  const lines = [
    `# Patch plan run`,
    "",
    `Plan: ${run.planId}`,
    `Provider: ${run.provider}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.finishedAt}`,
    "",
    "## Operation Results",
    "",
  ];
  if (run.results.length === 0) {
    lines.push("No operations were attempted.");
  } else {
    for (const result of run.results) {
      lines.push(
        `- **${result.status}** ${result.operationId}${result.detail ? ` — ${result.detail}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatRefs(refs: string[] | undefined) {
  return refs && refs.length > 0 ? refs.join(", ") : "none";
}

function formatFreshness(freshness: NonNullable<PatchPlan["pipelineFindings"]>[number]["freshness"]) {
  const age = freshness.ageDays === undefined ? "age unknown" : `${freshness.ageDays}d old`;
  const source = freshness.sourceUpdatedAt ? `source ${freshness.sourceUpdatedAt}` : "source date unknown";
  return `${freshness.state}, ${age}, ${source}, checked ${freshness.checkedAt}`;
}

function formatVerification(verification: NonNullable<PatchPlan["operations"]>[number]["verification"]) {
  if (!verification) return "not started";
  const observed = verification.observedValue === undefined
    ? ""
    : `, observed ${formatValue(verification.observedValue)}`;
  return `${verification.status}${observed}${verification.auditText ? ` (${verification.auditText})` : ""}`;
}

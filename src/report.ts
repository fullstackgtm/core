import { REQUIRES_HUMAN_PREFIX } from "./rules.ts";
import type {
  AuditFinding,
  AuditFindingSeverity,
  CanonicalGtmSnapshot,
  GtmAuditRule,
  PatchPlan,
} from "./types.ts";

/**
 * Client-ready rendering of an audit patch plan: the same findings the CLI
 * prints for operators, reshaped for the person who owns the CRM — counts up
 * front, prose summary, per-rule detail with capped examples, and next steps.
 * Deterministic: identical plan + options produce identical output, so a
 * report can be regenerated and diffed across engagements.
 */

export type ReportOptions = {
  /** Report heading (default "GTM Data Health Report"). */
  title?: string;
  /** Organization the report is about; shown in the heading and summary. */
  clientName?: string;
  /** Attribution line in the footer (e.g. a consultancy or team name). */
  preparedBy?: string;
  /** Report date (YYYY-MM-DD); defaults to the plan's creation date (UTC). */
  date?: string;
  /** Example records listed per rule before truncating (default 10). */
  maxExamplesPerRule?: number;
  /** Rule metadata used for section titles, descriptions, and categories. */
  rules?: GtmAuditRule[];
  /** Snapshot the plan was generated from; enables record counts and rates. */
  snapshot?: CanonicalGtmSnapshot;
};

const SEVERITY_ORDER: AuditFindingSeverity[] = ["critical", "warning", "info"];
const SEVERITY_RANK: Record<AuditFindingSeverity, number> = {
  critical: 2,
  warning: 1,
  info: 0,
};

type RuleSection = {
  ruleId: string;
  title: string;
  description?: string;
  category: string;
  severity: AuditFindingSeverity;
  findings: AuditFinding[];
};

type ReportModel = {
  title: string;
  clientName?: string;
  preparedBy?: string;
  date: string;
  provider?: string;
  recordCounts?: { label: string; count: number }[];
  totalRecords?: number;
  severityCounts: Record<AuditFindingSeverity, number>;
  affectedRecords: number;
  sections: RuleSection[];
  maxExamplesPerRule: number;
  operationCount: number;
  humanInputOperationCount: number;
  recordLabels: Map<string, string>;
  summaryText: string;
};

export function buildReportModel(plan: PatchPlan, options: ReportOptions = {}): ReportModel {
  const ruleMeta = new Map((options.rules ?? []).map((rule) => [rule.id, rule]));
  const byRule = new Map<string, AuditFinding[]>();
  for (const finding of plan.findings) {
    const findings = byRule.get(finding.ruleId) ?? [];
    findings.push(finding);
    byRule.set(finding.ruleId, findings);
  }

  const sections: RuleSection[] = Array.from(byRule.entries())
    .map(([ruleId, findings]) => {
      const meta = ruleMeta.get(ruleId);
      const severity = findings.reduce<AuditFindingSeverity>(
        (worst, finding) =>
          SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst,
        "info",
      );
      return {
        ruleId,
        title: meta?.title ?? ruleId,
        description: meta?.description,
        category: meta?.category ?? "uncategorized",
        severity,
        findings,
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.findings.length - a.findings.length ||
        a.ruleId.localeCompare(b.ruleId),
    );

  const severityCounts: Record<AuditFindingSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  const affected = new Set<string>();
  for (const finding of plan.findings) {
    severityCounts[finding.severity] += 1;
    affected.add(`${finding.objectType}:${finding.objectId}`);
  }

  const snapshot = options.snapshot;
  const recordCounts = snapshot
    ? [
        { label: "Accounts", count: snapshot.accounts.length },
        { label: "Contacts", count: snapshot.contacts.length },
        { label: "Deals", count: snapshot.deals.length },
        { label: "Users", count: snapshot.users.length },
        { label: "Activities", count: snapshot.activities.length },
      ]
    : undefined;
  const totalRecords = recordCounts?.reduce((sum, entry) => sum + entry.count, 0);

  const recordLabels = new Map<string, string>();
  if (snapshot) {
    for (const row of snapshot.accounts) recordLabels.set(`account:${row.id}`, row.name);
    for (const row of snapshot.users) recordLabels.set(`user:${row.id}`, row.name);
    for (const row of snapshot.deals) recordLabels.set(`deal:${row.id}`, row.name);
    for (const row of snapshot.contacts) {
      const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;
      if (name) recordLabels.set(`contact:${row.id}`, name);
    }
  }

  const humanInputOperationCount = plan.operations.filter(
    (operation) =>
      typeof operation.afterValue === "string" &&
      operation.afterValue.startsWith(REQUIRES_HUMAN_PREFIX),
  ).length;

  const model: ReportModel = {
    title: options.title ?? "GTM Data Health Report",
    clientName: options.clientName,
    preparedBy: options.preparedBy,
    date: options.date ?? plan.createdAt.slice(0, 10),
    provider: snapshot?.provider,
    recordCounts,
    totalRecords,
    severityCounts,
    affectedRecords: affected.size,
    sections,
    maxExamplesPerRule: Math.max(1, options.maxExamplesPerRule ?? 10),
    operationCount: plan.operations.length,
    humanInputOperationCount,
    recordLabels,
    summaryText: "",
  };
  model.summaryText = summaryText(model);
  return model;
}

function summaryText(model: ReportModel): string {
  const subject = model.clientName ? `${model.clientName}'s CRM data` : "the CRM data";
  if (model.sections.length === 0) {
    return `This audit reviewed ${subject} and found no issues with the rules that ran. The checks are deterministic and can be re-run at any time to confirm the data stays healthy.`;
  }
  const total = model.sections.reduce((sum, section) => sum + section.findings.length, 0);
  const severityParts = SEVERITY_ORDER.filter((severity) => model.severityCounts[severity] > 0)
    .map((severity) => `${model.severityCounts[severity]} ${severity}`)
    .join(", ");
  const scope =
    model.totalRecords !== undefined
      ? `${model.affectedRecords} of ${model.totalRecords} records (${percent(model.affectedRecords, model.totalRecords)}%)`
      : `${model.affectedRecords} records`;
  const top = model.sections[0];
  const fixes =
    model.operationCount > 0
      ? ` ${model.operationCount} of the issues have a proposed fix ready for review; nothing is changed in the CRM until each fix is explicitly approved.`
      : "";
  return (
    `This audit reviewed ${subject} and surfaced ${total} findings (${severityParts}) across ${scope}. ` +
    `The largest issue is "${top.title}" (${top.findings.length} records).${fixes}`
  );
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 100);
}

function findingLabel(model: ReportModel, finding: AuditFinding): string {
  const name = model.recordLabels.get(`${finding.objectType}:${finding.objectId}`);
  return name ? `${name} (${finding.objectType})` : `${finding.objectType}/${finding.objectId}`;
}

export function auditReportToMarkdown(plan: PatchPlan, options: ReportOptions = {}): string {
  const model = buildReportModel(plan, options);
  const lines: string[] = [];

  lines.push(`# ${model.title}${model.clientName ? ` — ${model.clientName}` : ""}`, "");
  const subtitle = [
    `Prepared ${model.date}`,
    model.provider ? `Source: ${model.provider}` : null,
    model.preparedBy ? `By: ${model.preparedBy}` : null,
  ].filter(Boolean);
  lines.push(subtitle.join(" · "), "");

  lines.push("## At a Glance", "", "| Metric | Value |", "| --- | --- |");
  if (model.recordCounts && model.totalRecords !== undefined) {
    lines.push(
      `| Records audited | ${model.totalRecords} (${model.recordCounts
        .map((entry) => `${entry.count} ${entry.label.toLowerCase()}`)
        .join(", ")}) |`,
    );
  }
  const totalFindings = SEVERITY_ORDER.reduce(
    (sum, severity) => sum + model.severityCounts[severity],
    0,
  );
  lines.push(`| Findings | ${totalFindings} |`);
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${capitalize(severity)} | ${model.severityCounts[severity]} |`);
  }
  lines.push(
    `| Records affected | ${model.affectedRecords}${
      model.totalRecords !== undefined && model.totalRecords > 0
        ? ` (${percent(model.affectedRecords, model.totalRecords)}%)`
        : ""
    } |`,
    `| Proposed fixes | ${model.operationCount}${
      model.humanInputOperationCount > 0
        ? ` (${model.humanInputOperationCount} need a human-chosen value)`
        : ""
    } |`,
    "",
  );

  lines.push("## Summary", "", model.summaryText, "");

  if (model.sections.length > 0) {
    lines.push(
      "## Findings by Rule",
      "",
      "| Rule | Category | Severity | Records |",
      "| --- | --- | --- | --- |",
    );
    for (const section of model.sections) {
      lines.push(
        `| ${section.title} | ${section.category} | ${section.severity} | ${section.findings.length} |`,
      );
    }
    lines.push("", "## Details", "");
    for (const section of model.sections) {
      lines.push(
        `### ${section.title} (${section.findings.length} ${
          section.findings.length === 1 ? "record" : "records"
        }, ${section.severity})`,
        "",
      );
      if (section.description) lines.push(section.description, "");
      const shown = section.findings.slice(0, model.maxExamplesPerRule);
      for (const finding of shown) {
        lines.push(`- **${findingLabel(model, finding)}** — ${finding.summary}`);
        lines.push(`  - Recommendation: ${finding.recommendation}`);
      }
      const hidden = section.findings.length - shown.length;
      if (hidden > 0) lines.push(`- … and ${hidden} more.`);
      lines.push("");
    }

    lines.push("## Recommended Next Steps", "");
    if (model.operationCount > 0) {
      lines.push(
        `1. Review the ${model.operationCount} proposed fixes (\`fullstackgtm audit --save\`, then \`fullstackgtm plans show <id>\`).`,
        `2. Approve the operations to apply${
          model.humanInputOperationCount > 0
            ? `, supplying values for the ${model.humanInputOperationCount} that need a human decision`
            : ""
        } (\`fullstackgtm plans approve\`). Nothing is written without explicit approval.`,
        "3. Re-run the audit after applying to confirm the findings clear, and schedule it recurring to catch regressions.",
      );
    } else {
      lines.push(
        "1. Address the findings above in the CRM (no automated fixes are available for them yet).",
        "2. Re-run the audit to confirm the findings clear, and schedule it recurring to catch regressions.",
      );
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `Generated by the fullstackgtm CLI on ${model.date}.` +
      (model.preparedBy ? ` Prepared by ${model.preparedBy}.` : "") +
      " Findings are deterministic and re-runnable; no CRM data was modified to produce this report.",
  );
  return `${lines.join("\n")}\n`;
}

const SEVERITY_COLORS: Record<AuditFindingSeverity, { fg: string; bg: string }> = {
  critical: { fg: "#991b1b", bg: "#fee2e2" },
  warning: { fg: "#92400e", bg: "#fef3c7" },
  info: { fg: "#1e40af", bg: "#dbeafe" },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function severityBadge(severity: AuditFindingSeverity): string {
  const colors = SEVERITY_COLORS[severity];
  return `<span class="badge" style="color:${colors.fg};background:${colors.bg}">${severity}</span>`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Self-contained HTML (inline styles, no external assets) so the file can be
 * emailed or dropped into a shared drive and render anywhere, including
 * print-to-PDF.
 */
export function auditReportToHtml(plan: PatchPlan, options: ReportOptions = {}): string {
  const model = buildReportModel(plan, options);
  const totalFindings = SEVERITY_ORDER.reduce(
    (sum, severity) => sum + model.severityCounts[severity],
    0,
  );

  const glanceRows: string[] = [];
  if (model.recordCounts && model.totalRecords !== undefined) {
    glanceRows.push(
      row(
        "Records audited",
        `${model.totalRecords} (${model.recordCounts
          .map((entry) => `${entry.count} ${entry.label.toLowerCase()}`)
          .join(", ")})`,
      ),
    );
  }
  glanceRows.push(row("Findings", String(totalFindings)));
  for (const severity of SEVERITY_ORDER) {
    glanceRows.push(
      `<tr><th>${capitalize(severity)}</th><td>${model.severityCounts[severity]} ${severityBadge(severity)}</td></tr>`,
    );
  }
  glanceRows.push(
    row(
      "Records affected",
      `${model.affectedRecords}${
        model.totalRecords !== undefined && model.totalRecords > 0
          ? ` (${percent(model.affectedRecords, model.totalRecords)}%)`
          : ""
      }`,
    ),
    row(
      "Proposed fixes",
      `${model.operationCount}${
        model.humanInputOperationCount > 0
          ? ` (${model.humanInputOperationCount} need a human-chosen value)`
          : ""
      }`,
    ),
  );

  const ruleRows = model.sections
    .map(
      (section) =>
        `<tr><td>${escapeHtml(section.title)}</td><td>${escapeHtml(section.category)}</td>` +
        `<td>${severityBadge(section.severity)}</td><td class="num">${section.findings.length}</td></tr>`,
    )
    .join("\n");

  const detailSections = model.sections
    .map((section) => {
      const shown = section.findings.slice(0, model.maxExamplesPerRule);
      const hidden = section.findings.length - shown.length;
      const items = shown
        .map(
          (finding) =>
            `<li><strong>${escapeHtml(findingLabel(model, finding))}</strong> — ${escapeHtml(finding.summary)}` +
            `<div class="rec">Recommendation: ${escapeHtml(finding.recommendation)}</div></li>`,
        )
        .join("\n");
      return [
        `<section>`,
        `<h3>${escapeHtml(section.title)} <span class="count">${section.findings.length} ${
          section.findings.length === 1 ? "record" : "records"
        }</span> ${severityBadge(section.severity)}</h3>`,
        section.description ? `<p>${escapeHtml(section.description)}</p>` : "",
        `<ul>`,
        items,
        hidden > 0 ? `<li class="more">… and ${hidden} more.</li>` : "",
        `</ul>`,
        `</section>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const nextSteps =
    model.sections.length === 0
      ? ""
      : model.operationCount > 0
        ? `<ol>
<li>Review the ${model.operationCount} proposed fixes (<code>fullstackgtm audit --save</code>, then <code>fullstackgtm plans show &lt;id&gt;</code>).</li>
<li>Approve the operations to apply${
            model.humanInputOperationCount > 0
              ? `, supplying values for the ${model.humanInputOperationCount} that need a human decision`
              : ""
          } (<code>fullstackgtm plans approve</code>). Nothing is written without explicit approval.</li>
<li>Re-run the audit after applying to confirm the findings clear, and schedule it recurring to catch regressions.</li>
</ol>`
        : `<ol>
<li>Address the findings above in the CRM (no automated fixes are available for them yet).</li>
<li>Re-run the audit to confirm the findings clear, and schedule it recurring to catch regressions.</li>
</ol>`;

  const subtitle = [
    `Prepared ${model.date}`,
    model.provider ? `Source: ${escapeHtml(model.provider)}` : null,
    model.preparedBy ? `By: ${escapeHtml(model.preparedBy)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}${model.clientName ? ` — ${escapeHtml(model.clientName)}` : ""}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1f2937; max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; line-height: 1.55; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3rem; }
  h3 { font-size: 1.05rem; margin-top: 1.5rem; }
  .subtitle { color: #6b7280; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e5e7eb; font-size: 0.95rem; }
  th { color: #374151; font-weight: 600; }
  td.num { text-align: right; }
  .badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px;
           font-size: 0.78rem; font-weight: 600; vertical-align: middle; }
  .count { color: #6b7280; font-weight: 400; font-size: 0.9rem; }
  ul { padding-left: 1.2rem; }
  li { margin-bottom: 0.5rem; }
  .rec { color: #4b5563; font-size: 0.92rem; }
  .more { color: #6b7280; list-style: none; }
  code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.88rem; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;
           color: #6b7280; font-size: 0.85rem; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(model.title)}${model.clientName ? ` — ${escapeHtml(model.clientName)}` : ""}</h1>
<p class="subtitle">${subtitle}</p>

<h2>At a Glance</h2>
<table>
${glanceRows.join("\n")}
</table>

<h2>Summary</h2>
<p>${escapeHtml(model.summaryText)}</p>
${
  model.sections.length > 0
    ? `
<h2>Findings by Rule</h2>
<table>
<tr><th>Rule</th><th>Category</th><th>Severity</th><th class="num">Records</th></tr>
${ruleRows}
</table>

<h2>Details</h2>
${detailSections}

<h2>Recommended Next Steps</h2>
${nextSteps}`
    : ""
}
<footer>Generated by the fullstackgtm CLI on ${model.date}.${
    model.preparedBy ? ` Prepared by ${escapeHtml(model.preparedBy)}.` : ""
  } Findings are deterministic and re-runnable; no CRM data was modified to produce this report.</footer>
</body>
</html>
`;
}

function row(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

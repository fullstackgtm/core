import type { AuditFinding, AuditFindingSeverity, CanonicalGtmSnapshot, GtmAuditRule, PatchPlan } from "./types.ts";
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
    recordCounts?: {
        label: string;
        count: number;
    }[];
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
export declare function buildReportModel(plan: PatchPlan, options?: ReportOptions): ReportModel;
export declare function auditReportToMarkdown(plan: PatchPlan, options?: ReportOptions): string;
/**
 * Self-contained HTML (inline styles, no external assets) so the file can be
 * emailed or dropped into a shared drive and render anywhere, including
 * print-to-PDF.
 */
export declare function auditReportToHtml(plan: PatchPlan, options?: ReportOptions): string;
export {};

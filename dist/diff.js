/**
 * Snapshot and audit drift. Record ids and finding ids are stable across
 * runs, so two snapshots (or two plans) can be compared directly: what
 * appeared, what disappeared, what changed — and whether hygiene regressed.
 */
// Fields that change on every sync without semantic meaning.
const IGNORED_FIELDS = new Set(["raw", "lastSyncAt", "identities", "provenance"]);
function labelOf(record) {
    return record.name ?? record.email ?? record.id;
}
function diffCollection(before, after) {
    const beforeById = new Map(before.map((record) => [record.id, record]));
    const afterById = new Map(after.map((record) => [record.id, record]));
    const added = after
        .filter((record) => !beforeById.has(record.id))
        .map((record) => ({ id: record.id, label: labelOf(record) }));
    const removed = before
        .filter((record) => !afterById.has(record.id))
        .map((record) => ({ id: record.id, label: labelOf(record) }));
    const changed = [];
    for (const record of after) {
        const previous = beforeById.get(record.id);
        if (!previous)
            continue;
        const fields = new Set([...Object.keys(previous), ...Object.keys(record)]);
        const changes = [];
        for (const field of fields) {
            if (IGNORED_FIELDS.has(field))
                continue;
            const beforeValue = previous[field];
            const afterValue = record[field];
            if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
                changes.push({ field, before: beforeValue ?? null, after: afterValue ?? null });
            }
        }
        if (changes.length > 0) {
            changed.push({ id: record.id, label: labelOf(record), changes });
        }
    }
    return { added, removed, changed };
}
export function diffSnapshots(before, after) {
    return {
        before: { provider: before.provider, generatedAt: before.generatedAt },
        after: { provider: after.provider, generatedAt: after.generatedAt },
        users: diffCollection(before.users, after.users),
        accounts: diffCollection(before.accounts, after.accounts),
        contacts: diffCollection(before.contacts, after.contacts),
        deals: diffCollection(before.deals, after.deals),
        activities: diffCollection(before.activities, after.activities),
    };
}
/** Hygiene drift between two plans, keyed on stable finding ids. */
export function diffFindings(before, after) {
    const beforeIds = new Set(before.findings.map((finding) => finding.id));
    const afterIds = new Set(after.findings.map((finding) => finding.id));
    return {
        newFindings: after.findings.filter((finding) => !beforeIds.has(finding.id)),
        resolvedFindings: before.findings.filter((finding) => !afterIds.has(finding.id)),
        persistingCount: after.findings.filter((finding) => beforeIds.has(finding.id)).length,
    };
}
export function diffToMarkdown(diff, drift) {
    const lines = [
        "# Snapshot diff",
        "",
        `Before: ${diff.before.provider} @ ${diff.before.generatedAt}`,
        `After: ${diff.after.provider} @ ${diff.after.generatedAt}`,
        "",
        "| Collection | Added | Removed | Changed |",
        "| --- | --- | --- | --- |",
    ];
    for (const collection of ["users", "accounts", "contacts", "deals", "activities"]) {
        const entry = diff[collection];
        lines.push(`| ${collection} | ${entry.added.length} | ${entry.removed.length} | ${entry.changed.length} |`);
    }
    for (const collection of ["users", "accounts", "contacts", "deals", "activities"]) {
        const entry = diff[collection];
        if (entry.added.length + entry.removed.length + entry.changed.length === 0)
            continue;
        lines.push("", `## ${collection}`, "");
        for (const record of entry.added)
            lines.push(`- added ${record.label} (${record.id})`);
        for (const record of entry.removed)
            lines.push(`- removed ${record.label} (${record.id})`);
        for (const record of entry.changed) {
            lines.push(`- changed ${record.label} (${record.id}): ${record.changes
                .map((change) => `${change.field} ${formatValue(change.before)} → ${formatValue(change.after)}`)
                .join("; ")}`);
        }
    }
    if (drift) {
        lines.push("", "## Hygiene drift", "", `New findings: ${drift.newFindings.length}`, `Resolved findings: ${drift.resolvedFindings.length}`, `Persisting findings: ${drift.persistingCount}`);
        for (const finding of drift.newFindings) {
            lines.push(`- NEW [${finding.ruleId}] ${finding.summary}`);
        }
        for (const finding of drift.resolvedFindings) {
            lines.push(`- resolved [${finding.ruleId}] ${finding.summary}`);
        }
    }
    return `${lines.join("\n")}\n`;
}
function formatValue(value) {
    if (value === undefined || value === null || value === "")
        return "∅";
    return typeof value === "string" ? value : JSON.stringify(value);
}

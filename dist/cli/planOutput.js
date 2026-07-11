import { box, colorEnabled, paint, truncateToWidth } from "./ui.js";
export function compactPlan(plan, options = {}) {
    const counts = new Map();
    for (const operation of plan.operations) {
        const action = operation.operation || operation.field || "change";
        counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    const mix = [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([action, count]) => `${count} ${action}`)
        .join(" · ");
    const lines = [
        truncateToWidth(plan.title, 100),
        `Status   ${options.saved ? "SAVED · NEEDS APPROVAL" : "DRY RUN · NOTHING WRITTEN"}`,
        truncateToWidth(`Scope    ${plan.operations.length} operation${plan.operations.length === 1 ? "" : "s"}${mix ? ` · ${mix}` : ""}`, 100),
        truncateToWidth(`Effect   ${plan.summary}`, 100),
        options.saved ? `Next     fullstackgtm plans show ${plan.id}` : "Next     re-run with --save to stage this plan for approval",
    ];
    return [
        ...box(lines, paint(colorEnabled(process.stdout)), "Plan preview"),
        `Details: re-run with --verbose${options.saved ? `; JSON: fullstackgtm plans show ${plan.id} --json` : "; machine output: --json"}`,
    ].join("\n");
}
export function verbosePlanRequested(args) {
    return args.includes("--verbose") || args.includes("--full");
}

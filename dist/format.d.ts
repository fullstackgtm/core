import type { PatchPlan, PatchPlanRun } from "./types.ts";
export declare function patchPlanToMarkdown(plan: PatchPlan, opts?: {
    summary?: boolean;
}): string;
export declare function formatPatchPlanRun(run: PatchPlanRun): string;

import type { PatchPlan } from "../types.ts";
export declare function compactPlan(plan: PatchPlan, options?: {
    saved?: boolean;
}): string;
export declare function verbosePlanRequested(args: readonly string[]): boolean;

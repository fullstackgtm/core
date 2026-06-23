/** A command annotates its headline metrics (merged). */
export declare function reportCounts(values: Record<string, unknown>): void;
/** A command annotates a structured event (plan saved, meter charged, …). */
export declare function reportEvent(type: string, detail?: string): void;
/**
 * Send the run record if the CLI is paired. Best-effort: a 4s-capped POST that
 * swallows every error. Call once per process from the entry point.
 */
export declare function flushRunReport(args: string[], status: "success" | "partial" | "error", startedAt: number, error?: string): Promise<void>;

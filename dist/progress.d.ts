/**
 * The shared progress-event vocabulary — ONE set of semantics for every
 * long-running process, rendered natively by each surface:
 *
 *   CLI  → ui.ts (spinner / checklist / apply-ticker; TTY-only styling)
 *   app  → Convex heartbeat patches → reactive ProgressChip / StageTimeline
 *   both → optional broker streaming (a paired CLI POSTs heartbeats to the
 *          hosted app under its clientRunId, so long local runs tick live in
 *          the org's activity feed)
 *
 * Renderer-agnostic by contract: no event assumes persistence (the CLI drops
 * them after painting) or ANSI (the app can't use it). Listeners are
 * best-effort — a throwing renderer must never fail the work — and the
 * throttle policy lives HERE so both surfaces feel identical.
 *
 * Standing convention: if a verb loops, it emits. New long-running verbs wire
 * an emitter at the package layer; surfaces get feedback for free.
 */
export type ProgressEvent = {
    kind: "stage";
    stage: string;
    stageIndex: number;
    stageCount: number;
} | {
    kind: "items";
    done: number;
    total?: number;
} | {
    kind: "note";
    note: string;
} | {
    kind: "opResult";
    opId: string;
    status: "applied" | "skipped" | "failed" | "conflict";
    detail?: string;
} | {
    kind: "meter";
    spent: number;
    budget: number;
    unit: string;
};
/** Accumulated state — what a heartbeat persists / a chip renders. */
export type ProgressSnapshot = {
    stage?: string;
    stageIndex?: number;
    stageCount?: number;
    itemsDone?: number;
    itemsTotal?: number;
    note?: string;
    opsApplied: number;
    opsSkipped: number;
    opsFailed: number;
    updatedAt: number;
};
export type ProgressListener = (event: ProgressEvent, snapshot: ProgressSnapshot) => void;
export type ProgressEmitter = {
    stage(stage: string, stageIndex: number, stageCount: number): void;
    items(done: number, total?: number): void;
    note(note: string): void;
    opResult(opId: string, status: "applied" | "skipped" | "failed" | "conflict", detail?: string): void;
    meter(spent: number, budget: number, unit: string): void;
    /** Current accumulated state (always fresh, ignoring the throttle). */
    snapshot(): ProgressSnapshot;
    /** Force-deliver the latest state (call at stage ends / completion). */
    flush(): void;
};
/**
 * Throttled emitter: `items` heartbeats coalesce to at most one delivery per
 * throttle window (terminal `done === total` always delivers); `stage`,
 * `opResult`, `note`, and `meter` are structural and always deliver.
 */
export declare function createProgressEmitter(listener: ProgressListener, options?: {
    throttleMs?: number;
    now?: () => number;
}): ProgressEmitter;
/**
 * Fan one event stream out to several listeners (e.g. the CLI's local renderer
 * plus the broker heartbeat streamer). Each listener is isolated: one throwing
 * never starves the others, matching the emitter's own best-effort contract.
 */
export declare function composeListeners(...listeners: Array<ProgressListener | undefined | null>): ProgressListener;
export declare const CRM_SYNC_STAGES: readonly ["owners", "accounts", "contacts", "deals", "counters", "health"];
/** A connector snapshot pull — the CRM-sync stages that happen CLI-side. */
export declare const SNAPSHOT_PULL_STAGES: readonly ["owners", "accounts", "contacts", "deals"];
/** The Stripe connector's snapshot pull (billing systems have no owners). */
export declare const STRIPE_SNAPSHOT_STAGES: readonly ["customers", "subscriptions"];
export declare const CALL_SYNC_STAGES: readonly ["notes", "transcripts", "insights"];
export declare const BACKFILL_STRIPE_STAGES: readonly ["invoices", "snapshot", "matching", "plan"];
/** `backfill runs` — replaying local plan runs + health history to the broker. */
export declare const RUNS_REPLAY_STAGES: readonly ["runs", "health"];
export declare const APPLY_STAGES: readonly ["preflight", "operations", "results"];
/** `enrich acquire` — discovery through a governed create plan. */
export declare const ACQUIRE_STAGES: readonly ["discovery", "resolution", "plan"];
export declare const MARKET_CAPTURE_STAGES: readonly ["sources", "capture", "classify", "persist"];
/** No-op emitter for callers that don't care (keeps signatures simple). */
export declare function nullProgressEmitter(): ProgressEmitter;

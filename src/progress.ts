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

export type ProgressEvent =
  | { kind: "stage"; stage: string; stageIndex: number; stageCount: number }
  | { kind: "items"; done: number; total?: number }
  | { kind: "note"; note: string }
  | {
      kind: "opResult";
      opId: string;
      status: "applied" | "skipped" | "failed" | "conflict";
      detail?: string;
    }
  | { kind: "meter"; spent: number; budget: number; unit: string };

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

const DEFAULT_THROTTLE_MS = 2000;

/**
 * Throttled emitter: `items` heartbeats coalesce to at most one delivery per
 * throttle window (terminal `done === total` always delivers); `stage`,
 * `opResult`, `note`, and `meter` are structural and always deliver.
 */
export function createProgressEmitter(
  listener: ProgressListener,
  options: { throttleMs?: number; now?: () => number } = {},
): ProgressEmitter {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = options.now ?? Date.now;
  const state: ProgressSnapshot = {
    opsApplied: 0,
    opsSkipped: 0,
    opsFailed: 0,
    updatedAt: now(),
  };
  let lastItemsDelivery = 0;
  let pendingItems = false;

  function deliver(event: ProgressEvent) {
    state.updatedAt = now();
    try {
      listener(event, { ...state });
    } catch {
      // Renderers are presentation-only; never fail the work.
    }
  }

  return {
    stage(stage, stageIndex, stageCount) {
      state.stage = stage;
      state.stageIndex = stageIndex;
      state.stageCount = stageCount;
      state.itemsDone = undefined;
      state.itemsTotal = undefined;
      state.note = undefined;
      pendingItems = false;
      deliver({ kind: "stage", stage, stageIndex, stageCount });
    },
    items(done, total) {
      state.itemsDone = done;
      state.itemsTotal = total;
      const terminal = total !== undefined && done >= total;
      const due = now() - lastItemsDelivery >= throttleMs;
      if (terminal || due) {
        lastItemsDelivery = now();
        pendingItems = false;
        deliver({ kind: "items", done, total });
      } else {
        pendingItems = true;
      }
    },
    note(note) {
      state.note = note;
      deliver({ kind: "note", note });
    },
    opResult(opId, status, detail) {
      if (status === "applied") state.opsApplied += 1;
      else if (status === "skipped") state.opsSkipped += 1;
      else state.opsFailed += 1;
      deliver({ kind: "opResult", opId, status, detail });
    },
    meter(spent, budget, unit) {
      deliver({ kind: "meter", spent, budget, unit });
    },
    snapshot() {
      return { ...state, updatedAt: now() };
    },
    flush() {
      if (pendingItems && state.itemsDone !== undefined) {
        lastItemsDelivery = now();
        pendingItems = false;
        deliver({ kind: "items", done: state.itemsDone, total: state.itemsTotal });
      }
    },
  };
}

/**
 * Fan one event stream out to several listeners (e.g. the CLI's local renderer
 * plus the broker heartbeat streamer). Each listener is isolated: one throwing
 * never starves the others, matching the emitter's own best-effort contract.
 */
export function composeListeners(
  ...listeners: Array<ProgressListener | undefined | null>
): ProgressListener {
  const active = listeners.filter((listener): listener is ProgressListener => Boolean(listener));
  return (event, snapshot) => {
    for (const listener of active) {
      try {
        listener(event, snapshot);
      } catch {
        // Listeners are presentation/observability only; never fail the work.
      }
    }
  };
}

// ── Shared stage registries ─────────────────────────────────────────────────
// Package constants so the CLI checklist and the app StageTimeline render
// LITERALLY the same stages in the same order — one mental model everywhere.

export const CRM_SYNC_STAGES = [
  "owners",
  "accounts",
  "contacts",
  "deals",
  "counters",
  "health",
] as const;

/** A connector snapshot pull — the CRM-sync stages that happen CLI-side. */
export const SNAPSHOT_PULL_STAGES = ["owners", "accounts", "contacts", "deals"] as const;

/** The Stripe connector's snapshot pull (billing systems have no owners). */
export const STRIPE_SNAPSHOT_STAGES = ["customers", "subscriptions"] as const;

export const CALL_SYNC_STAGES = ["notes", "transcripts", "insights"] as const;

export const BACKFILL_STRIPE_STAGES = ["invoices", "snapshot", "matching", "plan"] as const;

/** `backfill runs` — replaying local plan runs + health history to the broker. */
export const RUNS_REPLAY_STAGES = ["runs", "health"] as const;

export const APPLY_STAGES = ["preflight", "operations", "results"] as const;

/** `enrich acquire` — routing sourced candidate rows into a create plan. */
export const ACQUIRE_STAGES = ["candidates"] as const;

export const MARKET_CAPTURE_STAGES = ["sources", "capture", "classify", "persist"] as const;

/** No-op emitter for callers that don't care (keeps signatures simple). */
export function nullProgressEmitter(): ProgressEmitter {
  return createProgressEmitter(() => {});
}

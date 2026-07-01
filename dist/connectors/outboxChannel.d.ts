/**
 * Outbox channel connector — the governed SEND-side terminus of the outbound
 * loop (signal → judge → draft → approve → apply → outbox), and the mirror image
 * of the webhook spool. It is a `GtmConnector` whose `applyOperation` RENDERS an
 * approved drafted opener to a local outbox artifact instead of writing a CRM —
 * so it reuses the entire governed apply machinery (approval set, integrity/HMAC
 * verification, idempotency, run recording) with no change to the apply engine.
 *
 * THE INVARIANT IT KEEPS: the CLI **transmits nothing**. Rendering an approved
 * opener to `<home>/signals/outbox/<channel>.jsonl` is a local file write, never
 * an SMTP/API connection. A downstream sender (the hosted product, or the
 * operator's own MTA) drains the outbox and does the actual transmission. This
 * is the send-side half of the open-core boundary: the governed artifact + its
 * format are open; always-on transmission infrastructure is hosted/opt-in.
 *
 * Governance: it only renders ops that came from `draft` (a `create_task` op
 * whose policy is `draft:<channel>`); any other op is `skipped` (it is not a
 * general CRM writer). Idempotent on the operation id — re-applying an approved
 * plan never duplicates an outbox row. Read paths (`fetchSnapshot`) intentionally
 * throw: a channel has no snapshot, and `applyPatchPlan` never calls it for a
 * draft plan (no guards/filter/irreversible ops → no snapshot needed).
 */
import type { GtmConnector } from "../types.ts";
/** One approved, ready-to-send touch — a governed send INTENT, not a sent message. */
export type OutboxEntry = {
    /** Idempotency key = the source operation id (stable per draft op). */
    id: string;
    /** email | linkedin | task — from the draft op's `draft:<channel>` policy. */
    channel: string;
    /** The CRM target the opener is addressed to (a sender resolves id → address). */
    objectType: string;
    objectId: string;
    /** The APPROVED opener, verbatim as it was signed in the plan op. */
    body: string;
    /** The draft op's human-readable reason (carries the account + trigger). */
    reason?: string;
    /** Evidence ids the opener was grounded in (the verbatim signal quote). */
    evidenceIds: string[];
    /** ISO 8601 — when the CLI rendered this to the outbox (NOT a send time). */
    renderedAt: string;
};
/** Channel ids this build can render to. */
export declare const CHANNELS: readonly ["outbox"];
export type OutboxChannelOptions = {
    /** Outbox directory; defaults to the profile-scoped `signalsOutboxDir()`. */
    outboxDir?: string;
    /** Injectable clock for deterministic tests. */
    now?: () => Date;
};
/**
 * Build the outbox channel connector. With no `outboxDir`, writes to the
 * profile-scoped conventional outbox and locks the home down (0700/0600) like
 * the signal store; with an explicit `outboxDir` (tests), it writes there
 * without touching the real home.
 */
export declare function createOutboxChannelConnector(options?: OutboxChannelOptions): GtmConnector;
/** Resolve a channel connector by id (mirrors the source-connector registry). */
export declare function createChannelConnector(id: string, options?: OutboxChannelOptions): GtmConnector;
/**
 * Read every outbox entry across all channel files in `dir` (default: the
 * conventional outbox), newest-appended last. The reader a downstream sender (or
 * a future `signals outbox` command) uses to drain the queue.
 */
export declare function listOutbox(dir?: string): OutboxEntry[];

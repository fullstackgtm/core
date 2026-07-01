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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSecureHomeDir, writeSecureFile } from "../credentials.ts";
import { signalsOutboxDir } from "../signals.ts";
import type { CanonicalGtmSnapshot, GtmConnector, PatchOperation, PatchOperationResult } from "../types.ts";

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
export const CHANNELS = ["outbox"] as const;

export type OutboxChannelOptions = {
  /** Outbox directory; defaults to the profile-scoped `signalsOutboxDir()`. */
  outboxDir?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
};

const DRAFT_POLICY_PREFIX = "draft:";

/**
 * Build the outbox channel connector. With no `outboxDir`, writes to the
 * profile-scoped conventional outbox and locks the home down (0700/0600) like
 * the signal store; with an explicit `outboxDir` (tests), it writes there
 * without touching the real home.
 */
export function createOutboxChannelConnector(options: OutboxChannelOptions = {}): GtmConnector {
  const usingDefaultHome = options.outboxDir === undefined;
  const dir = options.outboxDir ?? signalsOutboxDir();
  const now = options.now ?? (() => new Date());

  function fileFor(channel: string): string {
    if (!/^[\w.-]+$/.test(channel)) throw new Error(`Invalid outbox channel name: ${channel}`);
    return join(dir, `${channel}.jsonl`);
  }

  /** Existing entry ids in a channel file (for idempotent re-apply). */
  function existingIds(channel: string): Set<string> {
    const ids = new Set<string>();
    let raw: string;
    try {
      raw = readFileSync(fileFor(channel), "utf8");
    } catch {
      return ids; // no file yet
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const id = (JSON.parse(t) as { id?: unknown }).id;
        if (typeof id === "string") ids.add(id);
      } catch {
        // Skip a corrupt line rather than fail the whole apply.
      }
    }
    return ids;
  }

  function append(channel: string, entry: OutboxEntry): void {
    if (usingDefaultHome) ensureSecureHomeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = fileFor(channel);
    // Owner-only like the signal store: outbox carries opener text + CRM ids.
    if (!existsSync(path)) writeSecureFile(path, "");
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async function applyOperation(operation: PatchOperation): Promise<PatchOperationResult> {
    const policy = String(operation.sourceRuleOrPolicy ?? "");
    if (operation.operation !== "create_task" || !policy.startsWith(DRAFT_POLICY_PREFIX)) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail:
          "The outbox channel only renders drafted openers (create_task ops from `draft`). " +
          "Apply other operations through a CRM connector (--provider hubspot|salesforce).",
      };
    }
    const channel = policy.slice(DRAFT_POLICY_PREFIX.length) || "task";

    // Idempotent: a re-applied approved plan must not duplicate the row.
    if (existingIds(channel).has(operation.id)) {
      return {
        operationId: operation.id,
        status: "applied",
        detail: `Already in outbox (${channel}.jsonl); idempotent — not duplicated. Nothing transmitted.`,
      };
    }

    const entry: OutboxEntry = {
      id: operation.id,
      channel,
      objectType: operation.objectType,
      objectId: operation.objectId,
      body: typeof operation.afterValue === "string" ? operation.afterValue : String(operation.afterValue ?? ""),
      ...(operation.reason ? { reason: operation.reason } : {}),
      evidenceIds: operation.evidenceIds ?? [],
      renderedAt: now().toISOString(),
    };
    append(channel, entry);
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Rendered to outbox (${channel}.jsonl) for a downstream sender. Nothing was transmitted.`,
    };
  }

  async function fetchSnapshot(): Promise<CanonicalGtmSnapshot> {
    // A channel has no readable state. apply never calls this for a draft plan
    // (no guards/filter/irreversible ops); make the misuse explicit if it does.
    throw new Error(
      "The outbox channel has no snapshot to read — it is a send-side render target. " +
        "Use it only to `apply` an approved draft plan (`apply --plan-id <id> --channel outbox`).",
    );
  }

  return {
    provider: "outbox",
    fetchSnapshot,
    applyOperation,
  };
}

/** Resolve a channel connector by id (mirrors the source-connector registry). */
export function createChannelConnector(id: string, options: OutboxChannelOptions = {}): GtmConnector {
  if (id === "outbox") return createOutboxChannelConnector(options);
  throw new Error(`Unknown channel: ${id} (one of: ${CHANNELS.join(", ")}).`);
}

/**
 * Read every outbox entry across all channel files in `dir` (default: the
 * conventional outbox), newest-appended last. The reader a downstream sender (or
 * a future `signals outbox` command) uses to drain the queue.
 */
export function listOutbox(dir?: string): OutboxEntry[] {
  const outboxDir = dir ?? signalsOutboxDir();
  let names: string[];
  try {
    names = readdirSync(outboxDir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: OutboxEntry[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(outboxDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as OutboxEntry);
      } catch {
        // Skip corrupt lines.
      }
    }
  }
  return out;
}

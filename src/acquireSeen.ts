/**
 * The acquire "seen" cache — cross-run memory of prospects already processed,
 * so re-running the same ICP doesn't re-pay the (expensive) email-resolution
 * step for people we resolved last time. Keyed by stable prospect identity
 * (LinkedIn URL, name+domain, email); a hit on ANY key means "skip before
 * paying". Per-profile, stored under the credential home.
 *
 * Distinct from the meter (spend budget) and from the live-CRM dedup (the
 * snapshot match + apply-time resolve-first): this avoids RE-spending across
 * runs; those avoid double-creating within/against the CRM.
 *
 * Zero deps. Stored as { key: lastSeenISO } so the cache can be pruned by age.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsDir } from "./credentials.ts";

type SeenStore = Record<string, string>;

/** Keep the newest N keys; bounds the file for very large/long-running fills. */
const SEEN_CAP = 50_000;

export function acquireSeenPath(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "acquire", "seen.json");
}

/** Load the set of seen keys (empty if none/corrupt). */
export function loadSeen(baseDir?: string): Set<string> {
  try {
    const store = JSON.parse(readFileSync(acquireSeenPath(baseDir), "utf8")) as SeenStore;
    return new Set(Object.keys(store));
  } catch {
    return new Set();
  }
}

/** Merge keys into the cache with a `now` timestamp, prune to cap, persist. */
export function recordSeen(keys: string[], now: Date, baseDir?: string): void {
  if (keys.length === 0) return;
  let store: SeenStore = {};
  try {
    store = JSON.parse(readFileSync(acquireSeenPath(baseDir), "utf8")) as SeenStore;
  } catch {
    store = {};
  }
  const iso = now.toISOString();
  for (const key of keys) store[key] = iso;

  let entries = Object.entries(store);
  if (entries.length > SEEN_CAP) {
    entries = entries.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, SEEN_CAP);
    store = Object.fromEntries(entries);
  }
  const path = acquireSeenPath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store)}\n`, "utf8");
}

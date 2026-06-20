/**
 * The acquire meter — a persistent, windowed budget for net-new lead creation.
 *
 * `enrich acquire` proposes `create_record` operations; `apply` writes them.
 * Both gate on this meter so a profile can never create more leads — or spend
 * more on enrichment — than its declared budget, per day AND per month
 * (whichever limit is hit first). The meter is the volume control; a human
 * still approves the plan (the CLI never auto-writes). State is per-profile,
 * stored under the credential home so one client's budget never bleeds into
 * another's.
 *
 * Pure where it counts: window math and `remaining()` take an explicit `now`
 * and operate on a passed-in state, so they are deterministic and testable.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsDir } from "./credentials.js";
export function dayKey(now) {
    return now.toISOString().slice(0, 10);
}
export function monthKey(now) {
    return now.toISOString().slice(0, 7);
}
export function acquireMeterPath(baseDir) {
    return join(baseDir ?? credentialsDir(), "acquire", "meter.json");
}
function emptyState(now) {
    return {
        day: dayKey(now),
        month: monthKey(now),
        records: { day: 0, month: 0 },
        spendUsd: { day: 0, month: 0 },
    };
}
/**
 * Roll the window counters forward: a new UTC day zeroes the day buckets, a
 * new UTC month zeroes the month buckets. Returns a fresh object; never
 * mutates the input.
 */
export function rollWindows(state, now) {
    const today = dayKey(now);
    const thisMonth = monthKey(now);
    return {
        day: today,
        month: thisMonth,
        records: {
            day: state.day === today ? state.records.day : 0,
            month: state.month === thisMonth ? state.records.month : 0,
        },
        spendUsd: {
            day: state.day === today ? state.spendUsd.day : 0,
            month: state.month === thisMonth ? state.spendUsd.month : 0,
        },
    };
}
/** Load the meter from disk, rolling stale windows forward. Missing = empty. */
export function loadMeter(now, baseDir) {
    let raw;
    try {
        raw = readFileSync(acquireMeterPath(baseDir), "utf8");
    }
    catch {
        return emptyState(now);
    }
    try {
        const parsed = JSON.parse(raw);
        const state = {
            day: typeof parsed.day === "string" ? parsed.day : dayKey(now),
            month: typeof parsed.month === "string" ? parsed.month : monthKey(now),
            records: {
                day: Number(parsed.records?.day) || 0,
                month: Number(parsed.records?.month) || 0,
            },
            spendUsd: {
                day: Number(parsed.spendUsd?.day) || 0,
                month: Number(parsed.spendUsd?.month) || 0,
            },
        };
        return rollWindows(state, now);
    }
    catch {
        return emptyState(now);
    }
}
export function saveMeter(state, baseDir) {
    const path = acquireMeterPath(baseDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function headroom(limit, used) {
    if (limit === undefined)
        return null;
    return Math.max(0, limit - used);
}
/**
 * Compute remaining headroom and the max additional records creatable now.
 * `costPerRecord` (USD) converts the spend budget into a record ceiling; when
 * it is 0 the spend budget cannot constrain record count.
 */
export function remaining(state, budget, costPerRecord, now) {
    const rolled = rollWindows(state, now);
    const records = {
        day: headroom(budget?.records?.perDay, rolled.records.day),
        month: headroom(budget?.records?.perMonth, rolled.records.month),
    };
    const spendUsd = {
        day: headroom(budget?.spend?.perDay, rolled.spendUsd.day),
        month: headroom(budget?.spend?.perMonth, rolled.spendUsd.month),
    };
    const ceilings = [];
    if (records.day !== null)
        ceilings.push(records.day);
    if (records.month !== null)
        ceilings.push(records.month);
    if (costPerRecord > 0) {
        if (spendUsd.day !== null)
            ceilings.push(Math.floor(spendUsd.day / costPerRecord));
        if (spendUsd.month !== null)
            ceilings.push(Math.floor(spendUsd.month / costPerRecord));
    }
    const maxRecords = ceilings.length === 0 ? null : Math.max(0, Math.min(...ceilings));
    return { records, spendUsd, maxRecords };
}
/**
 * Record a successful batch of creates against the budget and persist.
 * Returns the updated state. Call AFTER the writes land, so a failed apply
 * never charges the meter.
 */
export function recordConsumption(now, recordsCreated, spendUsd, baseDir) {
    const state = loadMeter(now, baseDir);
    const next = {
        day: state.day,
        month: state.month,
        records: {
            day: state.records.day + recordsCreated,
            month: state.records.month + recordsCreated,
        },
        spendUsd: {
            day: state.spendUsd.day + spendUsd,
            month: state.spendUsd.month + spendUsd,
        },
    };
    saveMeter(next, baseDir);
    return next;
}

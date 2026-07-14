/**
 * Opt-in CLI → hosted-app observability. When the user has paired the CLI
 * (`login --via <url>` → broker token), each command fire-and-forgets a run
 * record to the hosted app's `/api/cli/run`, authenticated by the broker token.
 *
 * Invariants: the CLI never requires web login; this does nothing when unpaired;
 * it never throws and never changes the CLI's exit code or output. Reporting is
 * pure added value for users who granted it.
 */
import { getCredential } from "./credentials.js";
// Bound the fire-and-forget POST: a pathological audit could surface thousands
// of findings; cap what we ship (counts still carry the true total).
const MAX_REPORTED_FINDINGS = 2000;
let counts;
let findings;
let crm;
const events = [];
/** A command annotates its headline metrics (merged). */
export function reportCounts(values) {
    counts = { ...(counts ?? {}), ...values };
}
/** A command reports per-row findings (IDs + issue type, no values). */
export function reportFindings(values) {
    findings = values.slice(0, MAX_REPORTED_FINDINGS);
}
/** A command reports the source CRM's record-URL base for dashboard deep-links. */
export function reportCrm(value) {
    crm = value;
}
/** A command annotates a structured event (plan saved, meter charged, …). */
export function reportEvent(type, detail) {
    events.push({ ts: Date.now(), type, detail });
}
// FNV-1a — the stable-id hash used across the package (see backfill.ts).
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
// Setup/inspection verbs aren't interesting as "runs" — skip the noise.
const SKIP_COMMANDS = new Set([
    "login",
    "logout",
    "doctor",
    "help",
    "profiles",
    "--help",
    "-h",
    "--version",
    "-v",
]);
/** The stable per-invocation identity flushRunReport and heartbeats share. */
function runIdentity(args, startedAt) {
    const command = args[0];
    if (!command || SKIP_COMMANDS.has(command))
        return null;
    const sub = args[1] && !args[1].startsWith("-") ? ` ${args[1]}` : "";
    const full = `${command}${sub}`;
    return { command: full, clientRunId: `run_${fnv1a(`${full}:${startedAt}:${process.pid}`)}` };
}
// ── Live progress streaming ─────────────────────────────────────────────────
// While a long command runs, a paired CLI streams heartbeats to the hosted
// app: POST /api/cli/run with the SAME clientRunId the final flushRunReport
// will use, status "in_progress", and the progress emitter's snapshot. The
// server upserts by clientRunId, so the terminal flush simply wins. Same
// invariants as flushRunReport: opt-in (paired only), fire-and-forget,
// time-capped, never affects the command's outcome or output.
const HEARTBEAT_INTERVAL_MS = 5000;
/** No heartbeat before the run is ~this old — fast commands never stream. */
const HEARTBEAT_MIN_RUN_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 2000;
let runContext = null;
let lastHeartbeatAt = 0;
// Broker credential resolved once per run (undefined = not looked up yet;
// null = looked up, not paired).
let heartbeatBroker;
let inflightHeartbeat = null;
/**
 * Arm heartbeat streaming for this invocation. Call once from the entry point
 * (alongside capturing `startedAt`); without it, progress listeners from
 * `progressReporter()` are inert. Safe to call for any command — skip-listed
 * commands simply never stream.
 */
export function beginRunReport(args, startedAt) {
    counts = undefined;
    findings = undefined;
    crm = undefined;
    events.length = 0;
    lastHeartbeatAt = 0;
    heartbeatBroker = undefined;
    inflightHeartbeat = null;
    const identity = runIdentity(args, startedAt);
    runContext = identity ? { ...identity, startedAt } : null;
}
/**
 * A ProgressListener that streams the run's progress snapshot to the paired
 * hosted app. Verbs compose it with their local renderer:
 *
 *   createProgressEmitter(composeListeners(renderer.listener, progressReporter()))
 *
 * Throttled to one POST per ~5s, first no earlier than ~5s into the run,
 * 2s-capped and fire-and-forget. Privacy: stage names and counts only — notes
 * must stay generic ("batch 4/12"); CRM field values never leave the machine.
 */
export function progressReporter(overrides = {}) {
    const now = overrides.now ?? Date.now;
    const intervalMs = overrides.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    const minRunMs = overrides.minRunMs ?? HEARTBEAT_MIN_RUN_MS;
    const fetchImpl = overrides.fetchImpl ?? fetch;
    return (_event, snapshot) => {
        try {
            if (!runContext)
                return;
            const at = now();
            if (at - runContext.startedAt < minRunMs)
                return;
            if (at - lastHeartbeatAt < intervalMs)
                return;
            if (heartbeatBroker === undefined) {
                const broker = getCredential("broker");
                heartbeatBroker =
                    broker?.baseUrl && broker.accessToken
                        ? { baseUrl: broker.baseUrl.replace(/\/+$/, ""), accessToken: broker.accessToken }
                        : null; // opt-in: only when paired
            }
            if (!heartbeatBroker)
                return;
            lastHeartbeatAt = at;
            sendHeartbeat(fetchImpl, heartbeatBroker, runContext, snapshot, at);
        }
        catch {
            // Observability is best-effort; never affect the command.
        }
    };
}
function sendHeartbeat(fetchImpl, broker, context, snapshot, at) {
    // One heartbeat in flight at a time: a stalled POST is superseded, and the
    // terminal flush aborts any straggler so it can never delay process exit.
    inflightHeartbeat?.abort();
    const controller = new AbortController();
    inflightHeartbeat = controller;
    const timer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    timer.unref?.();
    void fetchImpl(`${broker.baseUrl}/api/cli/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${broker.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            command: context.command,
            clientRunId: context.clientRunId,
            status: "in_progress",
            startedAt: context.startedAt,
            finishedAt: at,
            durationMs: at - context.startedAt,
            progress: {
                // Stage names + counts only — never CRM field values.
                stage: snapshot.stage,
                stageIndex: snapshot.stageIndex,
                stageCount: snapshot.stageCount,
                itemsDone: snapshot.itemsDone,
                itemsTotal: snapshot.itemsTotal,
                note: snapshot.note,
                heartbeatAt: at,
            },
        }),
        signal: controller.signal,
    })
        .catch(() => {
        // fire-and-forget
    })
        .finally(() => {
        clearTimeout(timer);
        if (inflightHeartbeat === controller)
            inflightHeartbeat = null;
    });
}
/**
 * Send the run record if the CLI is paired. Best-effort: a 4s-capped POST that
 * swallows every error. Call once per process from the entry point.
 */
export async function flushRunReport(args, status, startedAt, error) {
    // The terminal upsert supersedes any streaming heartbeat still in flight.
    inflightHeartbeat?.abort();
    inflightHeartbeat = null;
    // Stable per-invocation identity: the server dedupes on clientRunId, so a
    // retried report, an "in_progress" heartbeat, or a later `backfill runs`
    // replay of local history never duplicates.
    const identity = runIdentity(args, startedAt);
    if (!identity)
        return;
    // A successful command with no result, finding, event, or live progress is
    // terminal telemetry rather than something a person can explore. Keep it
    // out of Runs. Errors always report; heartbeating commands still send their
    // terminal status so an in-progress row cannot be stranded.
    const hasUsefulOutput = Boolean((counts && Object.keys(counts).length > 0) || findings?.length || events.length);
    if (status === "success" && !hasUsefulOutput && lastHeartbeatAt === 0)
        return;
    const broker = getCredential("broker");
    if (!broker?.baseUrl || !broker.accessToken)
        return; // opt-in: only when paired
    const finishedAt = Date.now();
    try {
        await fetch(`${broker.baseUrl.replace(/\/+$/, "")}/api/cli/run`, {
            method: "POST",
            headers: { Authorization: `Bearer ${broker.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                command: identity.command,
                clientRunId: identity.clientRunId,
                status,
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
                counts,
                findings: findings?.length ? findings : undefined,
                crm,
                events: events.length ? events : undefined,
                error,
            }),
            signal: AbortSignal.timeout(4000),
        });
    }
    catch {
        // Observability is best-effort; never affect the CLI outcome.
    }
}

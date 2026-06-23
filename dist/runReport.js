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
let counts;
const events = [];
/** A command annotates its headline metrics (merged). */
export function reportCounts(values) {
    counts = { ...(counts ?? {}), ...values };
}
/** A command annotates a structured event (plan saved, meter charged, …). */
export function reportEvent(type, detail) {
    events.push({ ts: Date.now(), type, detail });
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
/**
 * Send the run record if the CLI is paired. Best-effort: a 4s-capped POST that
 * swallows every error. Call once per process from the entry point.
 */
export async function flushRunReport(args, status, startedAt, error) {
    const command = args[0];
    if (!command || SKIP_COMMANDS.has(command))
        return;
    const broker = getCredential("broker");
    if (!broker?.baseUrl || !broker.accessToken)
        return; // opt-in: only when paired
    const sub = args[1] && !args[1].startsWith("-") ? ` ${args[1]}` : "";
    const finishedAt = Date.now();
    try {
        await fetch(`${broker.baseUrl.replace(/\/+$/, "")}/api/cli/run`, {
            method: "POST",
            headers: { Authorization: `Bearer ${broker.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                command: `${command}${sub}`,
                status,
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
                counts,
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

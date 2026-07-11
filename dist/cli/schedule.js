// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { activeProfile, credentialsDir } from "../credentials.js";
import { createFilePlanStore } from "../planStore.js";
import { createFileEnrichRunStore } from "../enrich.js";
import { computeMissedFirings, createFileScheduleRunStore, createFileScheduleStore, installLaunchdAgents, isDuplicateCronFiring, nextCronFiring, parseCron, renderManagedBlock, replaceManagedBlock, assertSingleLineLabel, hasControlChar, scheduleId, systemCrontabIo, systemLaunchdIo, tokenizeCommand, uninstallLaunchdAgents, validateSchedulableArgv } from "../schedule.js";
import { runCli } from "../cli.js";
import { isOptionValue, numericOption, option } from "./shared.js";
import { unknownSubcommandError } from "./suggest.js";
import { colorEnabled, paint, table } from "./ui.js";
/**
 * The schedule layer: declarative cadences for read/plan-side commands,
 * materialized through a provider (MVP: the user crontab), with an
 * append-only run history. The governance invariant — scheduling never
 * auto-approves — is enforced at `add` time and re-checked at `run` time.
 * Spec: docs/schedule.md (monorepo).
 */
export async function scheduleCommand(args) {
    const [subcommand, ...rest] = args;
    // Catch --help BEFORE any store read, credential access, or crontab
    // round-trip (the enrich/market early-catch pattern — `schedule install
    // --help` must never touch the crontab).
    if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
        console.log(`Usage:
schedule add "<fullstackgtm command>" --cron "<expr>" [--label <name>] [--provider local]
schedule list [--json]
schedule remove <id>
schedule enable <id> | disable <id>
schedule run <id>                     execute now; the single entry point every provider's timer calls
schedule install [--timer crontab|launchd]    materialize enabled entries into the system timer
schedule uninstall [--timer crontab|launchd]  remove everything install created (nothing else)
schedule status [<id>] [--runs <n>] [--json]

add validates the command against the schedulable allowlist — read/plan-side
only: audit, snapshot, enrich append|refresh, market capture|refresh,
suggest, report, doctor — and parses the 5-field cron expression (*, lists,
ranges, steps), but touches NO crontab: entries are declarative until install
materializes them (the plan/apply split — declare, then deliberately
activate).

Scheduling never auto-approves. apply is schedulable ONLY as
\`apply --plan-id <id>\`, and every firing re-checks the plan's status is
approved — an unapproved plan records a plan_not_approved no-op run instead
of executing. There is no flag that relaxes this. Unattended runs accumulate
proposals (plans, run records, reports), never surprise CRM writes.

install materializes enabled entries into the system timer. --timer defaults
by platform: launchd on macOS, crontab elsewhere. launchd writes one
LaunchAgent plist per entry (com.fullstackgtm.<profile>.<id> in
~/Library/LaunchAgents) — no Full Disk Access needed (macOS gates \`crontab\`
behind it), and firings missed while asleep coalesce into one run on wake.
crontab renders a sentinel-delimited block (# >>> fullstackgtm <profile> >>>
...) in the user crontab. Either way every timer line/plist invokes
\`schedule run <id> --profile <profile>\` and nothing else; re-install
replaces what install owns wholesale and never touches anything outside it.
Providers other than local (modal, aws) are not yet implemented — they will
be scaffold generators calling the same \`schedule run\` contract.

run executes the command in-process and records the outcome (exit code,
output tail, artifacts: plan ids / enrich run labels) under the profile's
schedule/runs/<id>/; the exit code propagates. Manual runs record
trigger: manual. status shows next firing and surfaces missed firings
(laptop asleep = cron skips silently; visibility only, no catch-up).`);
        return;
    }
    const store = createFileScheduleStore();
    const runStore = createFileScheduleRunStore();
    if (subcommand === "add") {
        const commandText = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
        if (!commandText) {
            throw new Error('Usage: fullstackgtm schedule add "<fullstackgtm command>" --cron "<expr>" [--label <name>] [--provider local]');
        }
        const cronText = option(rest, "--cron");
        if (!cronText)
            throw new Error('schedule add requires --cron "<minute hour day-of-month month day-of-week>"');
        requireLocalScheduleProvider(option(rest, "--provider") ?? "local");
        let argv = tokenizeCommand(commandText);
        if (argv[0] === "fullstackgtm")
            argv = argv.slice(1);
        validateSchedulableArgv(argv);
        const cron = parseCron(cronText);
        const next = nextCronFiring(cron, new Date()); // also rejects never-firing expressions
        const createdAt = new Date().toISOString();
        const label = option(rest, "--label") ??
            argv.filter((arg) => !arg.startsWith("--")).slice(0, 2).join("-").replace(/[^\w.-]+/g, "-");
        assertSingleLineLabel(label);
        const entry = {
            id: scheduleId(label, cron.source, argv, createdAt),
            label,
            argv,
            cron: cron.source,
            provider: "local",
            enabled: true,
            createdAt,
        };
        await store.add(entry);
        console.log(`Added ${entry.id} "${label}": \`${argv.join(" ")}\` at \`${cron.source}\` (next firing: ${next.toISOString()}).`);
        console.log("Declarative until materialized — activate with `fullstackgtm schedule install`.");
        return;
    }
    if (subcommand === "list") {
        const entries = await store.list();
        const now = new Date();
        const withNext = entries.map((entry) => ({
            ...entry,
            nextFiring: entry.enabled ? safeNextFiring(entry.cron, now) : null,
        }));
        if (rest.includes("--json")) {
            console.log(JSON.stringify(withNext, null, 2));
            return;
        }
        if (entries.length === 0) {
            console.log('No schedules. Add one with `fullstackgtm schedule add "<command>" --cron "<expr>"`.');
            return;
        }
        const p = paint(colorEnabled(process.stdout));
        const verbose = rest.includes("--verbose");
        const rows = [
            ["STATE", "SCHEDULE", "NEXT", ...(verbose ? ["CRON", "COMMAND"] : [])],
            ...withNext.map((entry) => [
                entry.enabled ? "on" : "off",
                `${entry.label} · ${entry.id}`,
                entry.nextFiring ?? "—",
                ...(verbose ? [entry.cron, entry.argv.join(" ")] : []),
            ]),
        ];
        console.log(table(rows, [p.dim, null, null]).join("\n"));
        console.log("\nDeclarative only · run `fullstackgtm schedule install` after changes.");
        return;
    }
    if (subcommand === "remove") {
        const id = positionalArg(rest, "Usage: fullstackgtm schedule remove <id>");
        if (!(await store.remove(id)))
            throw new Error(`No schedule with id ${id}.`);
        console.log(`Removed ${id}. Run \`fullstackgtm schedule install\` to update the crontab block.`);
        return;
    }
    if (subcommand === "enable" || subcommand === "disable") {
        const id = positionalArg(rest, `Usage: fullstackgtm schedule ${subcommand} <id>`);
        const entry = await store.setEnabled(id, subcommand === "enable");
        console.log(`${subcommand === "enable" ? "Enabled" : "Disabled"} ${entry.id} "${entry.label}". ` +
            "Run `fullstackgtm schedule install` to update the crontab block.");
        return;
    }
    if (subcommand === "run") {
        const id = positionalArg(rest, "Usage: fullstackgtm schedule run <id>");
        const entry = await store.get(id);
        if (!entry)
            throw new Error(`No schedule with id ${id} in profile "${activeProfile()}".`);
        if (!entry.enabled) {
            throw new Error(`Schedule ${id} is disabled — enable it with \`fullstackgtm schedule enable ${id}\`.`);
        }
        const trigger = (option(rest, "--trigger") ?? "manual");
        if (trigger !== "cron" && trigger !== "manual") {
            throw new Error("--trigger must be cron or manual");
        }
        const run = await executeScheduledRun(entry, trigger);
        if (run.exitCode !== 0)
            process.exitCode = run.exitCode;
        return;
    }
    if (subcommand === "install" || subcommand === "uninstall") {
        requireLocalScheduleProvider(option(rest, "--provider") ?? "local");
        const timer = resolveScheduleTimer(option(rest, "--timer") ?? undefined);
        const profile = activeProfile();
        if (timer === "launchd") {
            const io = systemLaunchdIo();
            if (subcommand === "uninstall") {
                const removed = uninstallLaunchdAgents(profile, io);
                console.log(`Removed ${removed.length} fullstackgtm LaunchAgent(s) for profile "${profile}" ` +
                    "(plists outside com.fullstackgtm.* untouched).");
                return;
            }
            const enabled = (await store.list()).filter((entry) => entry.enabled && entry.provider === "local");
            if (enabled.length === 0) {
                const removed = uninstallLaunchdAgents(profile, io);
                console.log(`No enabled schedules for profile "${profile}" — removed ${removed.length} LaunchAgent(s).`);
                return;
            }
            const logDir = join(credentialsDir(), "schedule", "logs");
            mkdirSync(logDir, { recursive: true, mode: 0o700 });
            const { installed } = installLaunchdAgents(profile, enabled, scheduleCliArgv(), io, {
                environment: process.env.FSGTM_HOME ? { FSGTM_HOME: process.env.FSGTM_HOME } : undefined,
                logDir,
            });
            console.log(`Installed ${installed.length} LaunchAgent(s) for profile "${profile}" ` +
                "(one plist per schedule in ~/Library/LaunchAgents — no crontab, no Full Disk Access). " +
                "Re-running install replaces them wholesale; `schedule uninstall` removes them.");
            return;
        }
        const io = systemCrontabIo();
        const existing = io.read();
        if (subcommand === "uninstall") {
            io.write(replaceManagedBlock(existing, profile, null));
            console.log(`Removed the fullstackgtm managed crontab block for profile "${profile}" (lines outside the sentinels untouched).`);
            return;
        }
        const enabled = (await store.list()).filter((entry) => entry.enabled && entry.provider === "local");
        if (enabled.length === 0) {
            io.write(replaceManagedBlock(existing, profile, null));
            console.log(`No enabled schedules for profile "${profile}" — removed the managed block.`);
            return;
        }
        const block = renderManagedBlock(profile, enabled, scheduleCliInvocation());
        io.write(replaceManagedBlock(existing, profile, block));
        console.log(`Installed ${enabled.length} schedule(s) into the managed crontab block for profile "${profile}". ` +
            "Re-running install replaces the block wholesale; `schedule uninstall` removes it.");
        return;
    }
    if (subcommand === "status") {
        const id = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
        const entries = await store.list();
        const selected = id ? entries.filter((entry) => entry.id === id) : entries;
        if (id && selected.length === 0)
            throw new Error(`No schedule with id ${id}.`);
        if (selected.length === 0) {
            console.log('No schedules. Add one with `fullstackgtm schedule add "<command>" --cron "<expr>"`.');
            return;
        }
        const showRuns = numericOption(rest, "--runs");
        const now = new Date();
        const report = [];
        for (const entry of selected) {
            const runs = await runStore.list(entry.id);
            const last = runs.length > 0 ? runs[runs.length - 1] : null;
            let streak = 0;
            for (let index = runs.length - 1; index >= 0; index -= 1) {
                if ((runs[index].exitCode === 0) !== (last.exitCode === 0))
                    break;
                streak += 1;
            }
            const missed = computeMissedFirings(entry, runs, now);
            report.push({
                id: entry.id,
                label: entry.label,
                argv: entry.argv,
                cron: entry.cron,
                enabled: entry.enabled,
                nextFiring: entry.enabled ? safeNextFiring(entry.cron, now) : null,
                lastRun: last
                    ? {
                        firedAt: last.firedAt,
                        trigger: last.trigger,
                        exitCode: last.exitCode,
                        noopReason: last.noopReason,
                        artifacts: last.artifacts,
                    }
                    : null,
                streak: last ? { outcome: last.exitCode === 0 ? "success" : "failure", length: streak } : null,
                missedFirings: missed.missed.map((firing) => firing.toISOString()),
                missedFiringsCapped: missed.capped,
                runs: showRuns !== undefined ? runs.slice(-showRuns) : undefined,
            });
        }
        if (rest.includes("--json")) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        for (const entry of report) {
            const last = entry.lastRun;
            const streak = entry.streak;
            const missed = entry.missedFirings;
            const verbose = rest.includes("--verbose");
            const outcome = !last ? "never run" : last.exitCode === 0 ? (last.noopReason ? `no-op · ${last.noopReason}` : "healthy") : `failed · exit ${last.exitCode}`;
            console.log(`${entry.enabled ? "●" : "○"} ${entry.label} · ${outcome}`);
            console.log(`  ${entry.id} · next ${entry.nextFiring ?? "— (disabled)"}`);
            if (verbose)
                console.log(`  ${entry.argv.join(" ")} · cron ${entry.cron}`);
            if (last) {
                const artifacts = [
                    ...last.artifacts.planIds.map((planId) => `plan ${planId}`),
                    ...last.artifacts.runLabels.map((runLabel) => `run ${runLabel}`),
                ];
                console.log(`  last ${last.firedAt} · ${last.trigger} · ${streak.length} ${streak.outcome}${streak.length === 1 ? "" : "s"}${artifacts.length ? ` · ${artifacts.join(", ")}` : ""}`);
            }
            else {
                console.log("  last never fired");
            }
            if (missed.length > 0) {
                console.log(`  missed: ${missed.length}${entry.missedFiringsCapped ? "+" : ""} expected firing(s) with no run record ` +
                    `(latest: ${missed[missed.length - 1]}) — cron has no catch-up (launchd coalesces missed firings into one run on wake); visibility only`);
            }
            const runs = entry.runs;
            if (runs) {
                for (const run of runs) {
                    console.log(`    ${run.firedAt}  ${run.trigger.padEnd(6)} exit ${run.exitCode}${run.noopReason ? `  no-op: ${run.noopReason}` : ""}`);
                }
            }
        }
        return;
    }
    throw unknownSubcommandError("schedule", subcommand, [
        "add", "list", "remove", "enable", "disable", "run", "install", "uninstall", "status",
    ]);
}
function positionalArg(rest, usage) {
    const value = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    if (!value)
        throw new Error(usage);
    return value;
}
function safeNextFiring(cron, now) {
    try {
        return nextCronFiring(parseCron(cron), now).toISOString();
    }
    catch {
        return null;
    }
}
/**
 * Which local timer materializes the entries. Defaults by platform: launchd
 * on macOS (crontab there is TCC-gated behind Full Disk Access — a permission
 * no program can request), the user crontab everywhere else. `--timer` is the
 * escape hatch, e.g. a macOS user who already granted FDA and prefers cron.
 */
function resolveScheduleTimer(raw) {
    const timer = raw ?? (process.platform === "darwin" ? "launchd" : "crontab");
    if (timer !== "crontab" && timer !== "launchd") {
        throw new Error(`--timer must be crontab or launchd, got "${raw}".`);
    }
    if (timer === "launchd" && process.platform !== "darwin") {
        throw new Error("--timer launchd is macOS-only; use --timer crontab on this platform.");
    }
    return timer;
}
/** The provider seam: local ships now; modal/aws arrive as scaffold generators. */
function requireLocalScheduleProvider(provider) {
    if (provider === "local")
        return;
    if (provider === "modal" || provider === "aws") {
        throw new Error(`Provider "${provider}" is not yet implemented — it will be a scaffold generator that emits a ` +
            "deploy-ready artifact whose runner calls the same `schedule run <id>` contract. MVP provider: local.");
    }
    throw new Error(`Unknown provider "${provider}" — not yet implemented. MVP provider: local.`);
}
/**
 * Resolve how cron should invoke this CLI: the current node binary plus the
 * entry script (source checkouts need --experimental-strip-types), with
 * FSGTM_HOME pinned when set so the cron environment sees the same store.
 */
function scheduleCliInvocation() {
    const script = process.argv[1] ? resolve(process.argv[1]) : null;
    if (!script || !existsSync(script)) {
        throw new Error("Cannot resolve the fullstackgtm entry point for crontab lines (process.argv[1] is missing).");
    }
    // A newline/control char in any of these flows verbatim into the crontab
    // executable line; single-quote escaping defends the shell, not cron's line
    // parser. Refuse early with a clear message (renderManagedBlock re-checks).
    for (const [name, value] of [
        ["FSGTM_HOME", process.env.FSGTM_HOME],
        ["the node executable path", process.execPath],
        ["the CLI script path", script],
    ]) {
        if (value && hasControlChar(value)) {
            throw new Error(`Cannot install schedules: ${name} contains a newline or control character.`);
        }
    }
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    const parts = [quote(process.execPath)];
    if (script.endsWith(".ts"))
        parts.push("--experimental-strip-types");
    parts.push(quote(script));
    const home = process.env.FSGTM_HOME ? `FSGTM_HOME=${quote(process.env.FSGTM_HOME)} ` : "";
    // cron treats an unescaped `%` in the command field as a newline/stdin split.
    // Escape it as `\%` so a stray `%` in a path can't truncate the managed line.
    return (home + parts.join(" ")).replace(/%/g, "\\%");
}
/**
 * The argv-array analog of scheduleCliInvocation for launchd ProgramArguments:
 * same entry-point resolution, but no shell ever parses it, so no quoting or
 * %-escaping — launchd execs the array directly. (FSGTM_HOME travels via the
 * plist's EnvironmentVariables dict instead of an inline prefix.)
 */
function scheduleCliArgv() {
    const script = process.argv[1] ? resolve(process.argv[1]) : null;
    if (!script || !existsSync(script)) {
        throw new Error("Cannot resolve the fullstackgtm entry point for LaunchAgent plists (process.argv[1] is missing).");
    }
    const parts = [process.execPath];
    if (script.endsWith(".ts"))
        parts.push("--experimental-strip-types");
    parts.push(script);
    return parts;
}
/**
 * The single provider entry point: execute the scheduled command in-process
 * (dispatch into the CLI router — never a shell), capture the output tail and
 * exit code as a run record, and hand the exit code back to the caller. Cron
 * calls it, cloud providers will call it, and a human running it manually
 * produces the same record (trigger: manual).
 *
 * Governance re-checks happen here, not just at `add` time: the allowlist is
 * re-validated (schedules.json is user-editable), and a scheduled apply
 * hard-checks the plan is approved — an unapproved plan records a
 * plan_not_approved no-op run and does NOT execute. Scheduling never
 * auto-approves.
 */
async function executeScheduledRun(entry, trigger) {
    const runStore = createFileScheduleRunStore();
    const firedAt = new Date().toISOString();
    const noop = async (reason, exitCode, message) => {
        const run = {
            scheduleId: entry.id,
            firedAt,
            completedAt: new Date().toISOString(),
            trigger,
            exitCode,
            outputTail: message,
            artifacts: { planIds: [], runLabels: [] },
            noopReason: reason,
        };
        await runStore.record(run);
        console.error(message);
        return run;
    };
    // launchd can trigger the same job twice in one minute when day-of-month
    // and day-of-week are both restricted (Vixie OR compiles to two interval
    // sets). Drop the duplicate here — the single entry point — so no timer
    // quirk can double-run a command. Manual runs always run.
    if (trigger === "cron" && isDuplicateCronFiring(await runStore.list(entry.id), firedAt)) {
        return noop("duplicate_firing", 0, `A cron firing for ${entry.id} was already recorded in this minute — skipping the duplicate.`);
    }
    try {
        validateSchedulableArgv(entry.argv);
    }
    catch (error) {
        return noop("not_schedulable", 1, error instanceof Error ? error.message : String(error));
    }
    if (entry.argv[0] === "apply") {
        const planId = option(entry.argv.slice(1), "--plan-id");
        const stored = await createFilePlanStore().get(planId);
        const status = stored ? stored.status : "missing";
        if (status !== "approved") {
            // The governance gate holding is not a machinery failure: exit 0, with
            // the refusal recorded on the run for `schedule status` to surface.
            return noop("plan_not_approved", 0, `Plan ${planId} is ${status}, not approved — scheduled apply refuses to execute. ` +
                `Scheduling never auto-approves; review and approve with \`fullstackgtm plans approve ${planId} --operations <ids|all>\`.`);
        }
    }
    // Artifact attribution by store diff: anything new in the plan store or the
    // enrich run store after the command ran was produced by this firing.
    const planStore = createFilePlanStore();
    const plansBefore = new Set((await planStore.list()).map((stored) => stored.plan.id));
    const enrichStore = createFileEnrichRunStore();
    const enrichBefore = new Set((await enrichStore.list()).map((run) => run.runLabel));
    const lines = [];
    const originalLog = console.log;
    const originalError = console.error;
    const tee = (original) => (...args) => {
        for (const line of args.map(String).join(" ").split("\n"))
            lines.push(line);
        original(...args);
    };
    console.log = tee(originalLog);
    console.error = tee(originalError);
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let exitCode = 0;
    try {
        await runCli([...entry.argv]);
        exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    }
    catch (error) {
        exitCode = 1;
        lines.push(error instanceof Error ? error.message : String(error));
    }
    finally {
        console.log = originalLog;
        console.error = originalError;
        process.exitCode = priorExitCode;
    }
    const planIds = (await planStore.list())
        .map((stored) => stored.plan.id)
        .filter((planId) => !plansBefore.has(planId));
    const runLabels = (await enrichStore.list())
        .map((run) => run.runLabel)
        .filter((runLabel) => !enrichBefore.has(runLabel));
    const run = {
        scheduleId: entry.id,
        firedAt,
        completedAt: new Date().toISOString(),
        trigger,
        exitCode,
        outputTail: lines.slice(-50).join("\n"),
        artifacts: { planIds, runLabels },
    };
    await runStore.record(run);
    return run;
}

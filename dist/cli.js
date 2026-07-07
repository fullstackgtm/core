import { activeProfile, listProfiles, setActiveProfile } from "./credentials.js";
import { capabilitiesCommand, printCommandHelpJson, robotDocsCommand, unknownCommandEnvelope } from "./cli/capabilities.js";
import { BESPOKE_HELP, commandHelp, HELP, shortUsage, stylizeShortUsage, usage } from "./cli/help.js";
import { readPackageInfo } from "./cli/shared.js";
import { correctedCommand, detectFlagTypo, suggestCommand, unknownFlagEnvelope } from "./cli/suggest.js";
import { colorEnabled, paint } from "./cli/ui.js";
// Verb modules load lazily inside their dispatch branch below. The dispatcher
// used to import all of them eagerly, so `--version` compiled the full
// 78-module graph (audit, market, enrich, signals, schedule, …) before
// printing one line. Each branch now `await import()`s only its own module;
// help/typo/error paths and the exports above stay eager and byte-identical.
/**
 * Pull the global `--profile <name>` flag out of argv (it may appear before
 * or after the command) and activate it. Stripping it keeps positional
 * detection in subcommands — `login <provider>`, `plans show <id>` — simple.
 */
function extractProfile(argv) {
    const index = argv.indexOf("--profile");
    if (index === -1)
        return argv;
    const name = argv[index + 1];
    if (!name)
        throw new Error("--profile requires a name, e.g. --profile acme");
    setActiveProfile(name);
    return [...argv.slice(0, index), ...argv.slice(index + 2)];
}
function profilesCommand(args) {
    const profiles = listProfiles();
    const current = activeProfile();
    if (args.includes("--json")) {
        console.log(JSON.stringify({ active: current, profiles }, null, 2));
        return;
    }
    for (const profile of profiles) {
        console.log(`${profile === current ? "*" : " "} ${profile}`);
    }
    if (!profiles.includes(current)) {
        console.log(`* ${current} (selected; created on first login)`);
    }
    console.log("\nSelect with --profile <name> on any command, or set FULLSTACKGTM_PROFILE. " +
        "Each profile keeps its own credentials and stored plans.");
}
export async function runCli(argv) {
    const [command, ...args] = extractProfile(argv);
    // Front door: the lifecycle-grouped map by default, the full reference on
    // --full. `help <command>` zooms into one verb. (docs/dx-punch-list.md #1)
    // Interactive terminals get the styled front door (dim brand header, bold
    // command names); piped/CI/agent output is the plain text, byte-identical.
    const styledShortUsage = () => stylizeShortUsage(shortUsage(), paint(colorEnabled(process.stdout)), {
        version: readPackageInfo().version,
        profile: activeProfile(),
    });
    if (!command || command === "--help" || command === "-h") {
        console.log(args.includes("--full") ? usage() : styledShortUsage());
        return;
    }
    if (command === "help") {
        const [topic] = args;
        if (topic && topic !== "--full" && !topic.startsWith("-")) {
            // `help <cmd> --json` → machine-readable help derived from the same
            // HELP entry the plain text renders from. Plain output is unchanged.
            if (args.includes("--json"))
                printCommandHelpJson(topic);
            else
                console.log(commandHelp(topic));
        }
        else {
            console.log(args.includes("--full") || topic === "--full" ? usage() : styledShortUsage());
        }
        return;
    }
    if (command === "--version" || command === "-v" || command === "version") {
        console.log(readPackageInfo().version);
        return;
    }
    // `<cmd> --help --json` → machine-readable help for EVERY command,
    // including the bespoke-help verbs (their plain --help still routes to
    // their own richer text reference below). Plain --help output is unchanged.
    if ((args.includes("--help") || args.includes("-h")) && args.includes("--json")) {
        printCommandHelpJson(command);
        return;
    }
    // Commands without bespoke help get focused per-command help on --help
    // instead of executing (audit used to silently run the sample audit) or
    // dumping the whole surface. call/market/enrich/bulk-update/schedule print
    // their own richer help. `--full` always escapes to the complete reference.
    if (!BESPOKE_HELP.includes(command) && (args.includes("--help") || args.includes("-h"))) {
        console.log(args.includes("--full") ? usage() : commandHelp(command));
        return;
    }
    // Flag typos used to be silently dropped by the per-verb parsers —
    // `audit --demo --jsn` exited 0 and printed markdown where the agent asked
    // for JSON. Near-miss unknown flags (≤ 1 edit from a flag documented in
    // help.ts) now stop with the exact corrected command. Suggest-only: never
    // auto-execute the correction, so a typo can never change what a
    // write-shaped invocation stages.
    if (command in HELP) {
        const typo = detectFlagTypo(args);
        if (typo) {
            if (args.includes("--json")) {
                console.log(JSON.stringify(unknownFlagEnvelope(command, args, typo), null, 2));
            }
            else {
                console.error(`Unknown flag: ${typo.given}`);
                console.error(`Did you mean: ${typo.suggestion}`);
                console.error(`Try: ${correctedCommand(command, args, typo)}`);
            }
            process.exitCode = 1;
            return;
        }
    }
    if (command === "capabilities") {
        capabilitiesCommand(args);
        return;
    }
    if (command === "robot-docs") {
        robotDocsCommand(args);
        return;
    }
    if (command === "login") {
        await (await import("./cli/auth.js")).login(args);
        return;
    }
    if (command === "logout") {
        (await import("./cli/auth.js")).logout(args);
        return;
    }
    if (command === "snapshot") {
        await (await import("./cli/audit.js")).snapshotCommand(args);
        return;
    }
    if (command === "audit") {
        await (await import("./cli/audit.js")).audit(args);
        return;
    }
    if (command === "report") {
        await (await import("./cli/audit.js")).reportCommand(args);
        return;
    }
    if (command === "rules") {
        await (await import("./cli/audit.js")).rulesCommand(args);
        return;
    }
    if (command === "doctor") {
        await (await import("./cli/auth.js")).doctorCommand(args);
        return;
    }
    if (command === "health") {
        (await import("./cli/audit.js")).healthCommand(args);
        return;
    }
    if (command === "suggest") {
        await (await import("./cli/fix.js")).suggest(args);
        return;
    }
    if (command === "call") {
        await (await import("./cli/call.js")).callCommand(args);
        return;
    }
    if (command === "resolve") {
        await (await import("./cli/fix.js")).resolveCommand(args);
        return;
    }
    if (command === "bulk-update") {
        await (await import("./cli/fix.js")).bulkUpdateCommand(args);
        return;
    }
    if (command === "dedupe") {
        await (await import("./cli/fix.js")).dedupeCommand(args);
        return;
    }
    if (command === "reassign") {
        await (await import("./cli/fix.js")).reassignCommand(args);
        return;
    }
    if (command === "fix") {
        await (await import("./cli/fix.js")).fixCommand(args);
        return;
    }
    if (command === "market") {
        await (await import("./cli/market.js")).marketCommand(args);
        return;
    }
    if (command === "enrich") {
        await (await import("./cli/enrich.js")).enrichCommand(args);
        return;
    }
    if (command === "backfill") {
        await (await import("./cli/backfill.js")).backfillCommand(args);
        return;
    }
    if (command === "init") {
        (await import("./cli/init.js")).initCommand(args);
        return;
    }
    if (command === "tam") {
        await (await import("./cli/tam.js")).tamCommand(args);
        return;
    }
    if (command === "icp") {
        await (await import("./cli/icp.js")).icpCommand(args);
        return;
    }
    if (command === "signals") {
        await (await import("./cli/signals.js")).signalsCommand(args);
        return;
    }
    if (command === "draft") {
        await (await import("./cli/draft.js")).draftCommand(args);
        return;
    }
    if (command === "schedule") {
        await (await import("./cli/schedule.js")).scheduleCommand(args);
        return;
    }
    if (command === "profiles") {
        profilesCommand(args);
        return;
    }
    if (command === "diff") {
        await (await import("./cli/plans.js")).diffCommand(args);
        return;
    }
    if (command === "merge") {
        await (await import("./cli/plans.js")).mergeCommand(args);
        return;
    }
    if (command === "plans") {
        await (await import("./cli/plans.js")).plansCommand(args);
        return;
    }
    if (command === "audit-log") {
        await (await import("./cli/plans.js")).auditLogCommand(args);
        return;
    }
    if (command === "apply") {
        await (await import("./cli/plans.js")).apply(args);
        return;
    }
    // Machine callers get a structured envelope with a did-you-mean hint
    // (derived from the HELP table) instead of the full-usage text wall.
    if (args.includes("--json")) {
        console.log(JSON.stringify(unknownCommandEnvelope(command), null, 2));
        process.exitCode = 1;
        return;
    }
    // Text callers get the same hint instead of the ~200-line usage() wall the
    // error path used to dump — `plan`, `dedup`, `healthcheck` are one nudge
    // away from the right verb. `--help` still prints the full map on request.
    if (command.startsWith("-")) {
        // A flag-shaped first token is a different mistake: the flag came before
        // (or without) a command. Say that, and resolve the flag itself when it
        // is a near-miss of a documented one.
        console.error(`${command} is a flag — a command must come first (e.g. fullstackgtm audit --json).`);
        const flagTypo = detectFlagTypo([command]);
        if (flagTypo)
            console.error(`Did you mean: ${flagTypo.suggestion} (after a command)`);
    }
    else {
        console.error(`Unknown command: ${command}`);
        const suggestion = suggestCommand(command);
        if (suggestion)
            console.error(`Did you mean: fullstackgtm ${suggestion}`);
    }
    console.error("Run `fullstackgtm --help` for the command map, or `fullstackgtm capabilities --json` for the machine-readable contract.");
    process.exitCode = 1;
}
// Public re-exports: cli.ts remains the stable import surface for the
// symbols tests and embedders use (mechanical split, no behavior change).
export { assertSecureBrokerUrl, doctorReport } from "./cli/auth.js";

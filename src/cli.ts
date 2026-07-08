import { activeProfile, listProfiles, setActiveProfile } from "./credentials.ts";
import { capabilitiesCommand, printCommandHelpJson, robotDocsCommand, unknownCommandEnvelope } from "./cli/capabilities.ts";
import { BESPOKE_HELP, commandHelp, HELP, shortUsage, stylizeShortUsage, usage } from "./cli/help.ts";
import { readPackageInfo } from "./cli/shared.ts";
import { correctedCommand, detectFlagTypo, detectUnknownFlag, suggestCommand, unknownFlagEnvelope } from "./cli/suggest.ts";
import { colorEnabled, paint } from "./cli/ui.ts";

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
function extractProfile(argv: string[]): string[] {
  const index = argv.indexOf("--profile");
  if (index === -1) return argv;
  const name = argv[index + 1];
  if (!name) throw new Error("--profile requires a name, e.g. --profile acme");
  setActiveProfile(name);
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function profilesCommand(args: string[]) {
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
  console.log(
    "\nSelect with --profile <name> on any command, or set FULLSTACKGTM_PROFILE. " +
      "Each profile keeps its own credentials and stored plans.",
  );
}

export async function runCli(argv: string[]) {
  const [command, ...args] = extractProfile(argv);
  // Front door: the lifecycle-grouped map by default, the full reference on
  // --full. `help <command>` zooms into one verb. (docs/dx-punch-list.md #1)
  // Interactive terminals get the styled front door (dim brand header, bold
  // command names); piped/CI/agent output is the plain text, byte-identical.
  const styledShortUsage = () =>
    stylizeShortUsage(shortUsage(), paint(colorEnabled(process.stdout)), {
      version: readPackageInfo().version,
      profile: activeProfile(),
    });
  if (!command || command === "--help" || command === "-h") {
    console.log(args.includes("--full") ? usage() : styledShortUsage());
    return;
  }
  if (command === "help") {
    const [topic] = args;
    if (topic && !topic.startsWith("-") && args.includes("--json")) {
      // `help <cmd> --json` → machine-readable help derived from the same
      // HELP entry the plain text renders from. JSON takes precedence over
      // --full so automated callers get a stable shape.
      printCommandHelpJson(topic);
    } else if (args.includes("--full")) {
      // --full is the global escape hatch to the complete reference, even
      // when a topic is given (help <cmd> --full), unless --json is requested.
      console.log(usage());
    } else if (topic && !topic.startsWith("-")) {
      console.log(commandHelp(topic));
    } else {
      console.log(styledShortUsage());
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
  // for JSON. Every flag-shaped token is now checked against the per-command
  // registry in help.ts, so unknown flags fail closed instead of being ignored.
  // Suggest-only: never auto-execute the correction, so a typo can never
  // silently change what a write-shaped invocation stages.
  if (command in HELP) {
    const typo = detectUnknownFlag(command, args);
    if (typo) {
      if (args.includes("--json")) {
        console.log(JSON.stringify(unknownFlagEnvelope(command, args, typo), null, 2));
      } else {
        console.error(`Unknown flag for ${command}: ${typo.given}`);
        // Keep the old near-miss shape too; existing agents key off it.
        console.error(`Unknown flag: ${typo.given}`);
        if (typo.suggestion) {
          console.error(`Did you mean ${typo.suggestion}?`);
          console.error(`Did you mean: ${typo.suggestion}`);
          if (typo.replacement.length > 0) {
            console.error(`Try: ${correctedCommand(command, args, typo)}`);
          }
        }
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
    await (await import("./cli/auth.ts")).login(args);
    return;
  }
  if (command === "logout") {
    (await import("./cli/auth.ts")).logout(args);
    return;
  }
  if (command === "snapshot") {
    await (await import("./cli/audit.ts")).snapshotCommand(args);
    return;
  }
  if (command === "audit") {
    await (await import("./cli/audit.ts")).audit(args);
    return;
  }
  if (command === "report") {
    await (await import("./cli/audit.ts")).reportCommand(args);
    return;
  }
  if (command === "rules") {
    await (await import("./cli/audit.ts")).rulesCommand(args);
    return;
  }
  if (command === "doctor") {
    await (await import("./cli/auth.ts")).doctorCommand(args);
    return;
  }
  if (command === "health") {
    (await import("./cli/audit.ts")).healthCommand(args);
    return;
  }
  if (command === "suggest") {
    await (await import("./cli/fix.ts")).suggest(args);
    return;
  }
  if (command === "call") {
    await (await import("./cli/call.ts")).callCommand(args);
    return;
  }
  if (command === "resolve") {
    await (await import("./cli/fix.ts")).resolveCommand(args);
    return;
  }
  if (command === "route") {
    await (await import("./cli/fix.ts")).routeCommand(args);
    return;
  }
  if (command === "hierarchy") {
    await (await import("./cli/fix.ts")).hierarchyCommand(args);
    return;
  }
  if (command === "relationships") {
    await (await import("./cli/fix.ts")).relationshipsCommand(args);
    return;
  }
  if (command === "bulk-update") {
    await (await import("./cli/fix.ts")).bulkUpdateCommand(args);
    return;
  }
  if (command === "dedupe") {
    await (await import("./cli/fix.ts")).dedupeCommand(args);
    return;
  }
  if (command === "reassign") {
    await (await import("./cli/fix.ts")).reassignCommand(args);
    return;
  }
  if (command === "fix") {
    await (await import("./cli/fix.ts")).fixCommand(args);
    return;
  }
  if (command === "market") {
    await (await import("./cli/market.ts")).marketCommand(args);
    return;
  }
  if (command === "enrich") {
    await (await import("./cli/enrich.ts")).enrichCommand(args);
    return;
  }
  if (command === "backfill") {
    await (await import("./cli/backfill.ts")).backfillCommand(args);
    return;
  }
  if (command === "init") {
    (await import("./cli/init.ts")).initCommand(args);
    return;
  }
  if (command === "tam") {
    await (await import("./cli/tam.ts")).tamCommand(args);
    return;
  }
  if (command === "icp") {
    await (await import("./cli/icp.ts")).icpCommand(args);
    return;
  }
  if (command === "signals") {
    await (await import("./cli/signals.ts")).signalsCommand(args);
    return;
  }
  if (command === "draft") {
    await (await import("./cli/draft.ts")).draftCommand(args);
    return;
  }
  if (command === "schedule") {
    await (await import("./cli/schedule.ts")).scheduleCommand(args);
    return;
  }
  if (command === "profiles") {
    profilesCommand(args);
    return;
  }
  if (command === "diff") {
    await (await import("./cli/plans.ts")).diffCommand(args);
    return;
  }
  if (command === "merge") {
    await (await import("./cli/plans.ts")).mergeCommand(args);
    return;
  }
  if (command === "plans") {
    await (await import("./cli/plans.ts")).plansCommand(args);
    return;
  }
  if (command === "audit-log") {
    await (await import("./cli/plans.ts")).auditLogCommand(args);
    return;
  }
  if (command === "apply") {
    await (await import("./cli/plans.ts")).apply(args);
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
    if (flagTypo) console.error(`Did you mean: ${flagTypo.suggestion} (after a command)`);
  } else {
    console.error(`Unknown command: ${command}`);
    const suggestion = suggestCommand(command);
    if (suggestion) console.error(`Did you mean: fullstackgtm ${suggestion}`);
  }
  console.error(
    "Run `fullstackgtm --help` for the command map, or `fullstackgtm capabilities --json` for the machine-readable contract.",
  );
  process.exitCode = 1;
}

// Public re-exports: cli.ts remains the stable import surface for the
// symbols tests and embedders use (mechanical split, no behavior change).
export { assertSecureBrokerUrl, doctorReport } from "./cli/auth.ts";

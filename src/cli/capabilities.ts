// Machine-readable contract surfaces: `capabilities`, `robot-docs`, and the
// `--help --json` payloads.
//
// DESIGN RULE — every list in these payloads is DERIVED from an existing
// single source of truth (the HELP table in help.ts, BESPOKE_HELP,
// readPackageInfo(), the shipped SKILL.md), never hand-maintained in
// parallel. Hand-written parallel lists were the core defect of the first
// attempt at this surface (PR #156): its `mutates` list omitted `merge`, its
// `dryRunOnly` list omitted snapshot/health/suggest, and its MCP tool list
// reported 4 of 8+ tools.

import { readFileSync } from "node:fs";
import { BESPOKE_HELP, HELP } from "./help.ts";
import { readPackageInfo } from "./shared.ts";
import { suggestCommand } from "./suggest.ts";

export type CommandAccess = "read-only" | "write-shaped";

// Lifecycle phase → access shape. "write-shaped" means the verb participates
// in the write path (emits dry-run patch plans, applies approved operations,
// or installs schedule entries); "read-only" verbs never stage or perform a
// write. Derived from each HELP entry's `phase`, with the deviations from
// the naive phase mapping documented inline.
const PHASE_ACCESS: Record<string, CommandAccess> = {
  Setup: "read-only",
  Detect: "read-only",
  // Prevent gates writes but performs none: its one verb, `resolve`, only
  // reads the snapshot and exits 0/2 — the CALLER decides whether to create.
  Prevent: "read-only",
  Remediate: "write-shaped",
  Govern: "write-shaped",
  "Govern / Verify": "write-shaped",
  // Verify inspects the tamper-evident record of past applies (`audit-log`
  // export/verify); it writes nothing.
  Verify: "read-only",
  // Continuous = `schedule`: installs crontab entries — a local write with
  // ongoing side effects, and `apply --plan-id <id>` is schedulable.
  Continuous: "write-shaped",
  // Intelligence (`market`, `tam`) reads public pages / the CRM and writes
  // only the local workspace — except `tam populate`, overridden below.
  Intelligence: "read-only",
};

// Per-verb overrides for commands whose phase would misclassify them.
const ACCESS_OVERRIDES: Record<string, CommandAccess> = {
  // `suggest` sits on the Govern spine but is explicitly read-only: it
  // derives values for requires_human_* placeholders from snapshot evidence
  // and writes nothing — approval happens later in `plans approve`.
  suggest: "read-only",
  // `tam populate` installs recurring schedule entries (by delegating to the
  // schedule layer) — the same "ongoing side effects" that make `schedule`
  // write-shaped. An agent trusting this contract must not treat `tam` as
  // inert.
  tam: "write-shaped",
};

export function commandAccess(name: string): CommandAccess {
  const override = ACCESS_OVERRIDES[name];
  if (override) return override;
  const entry = HELP[name];
  const access = entry ? PHASE_ACCESS[entry.phase] : undefined;
  if (!access) {
    // Fail loudly instead of guessing: a new phase value (or a command
    // missing from HELP) must be classified deliberately, not defaulted.
    throw new Error(
      `No access mapping for command "${name}" (phase: ${entry?.phase ?? "not in HELP"}). ` +
        "Add the phase to PHASE_ACCESS or an explicit ACCESS_OVERRIDES entry in src/cli/capabilities.ts.",
    );
  }
  return access;
}

// Quoted from docs/api.md ("Exit codes: `0` success · `1` error · `2`
// findings/regressions at the requested gate (`--fail-on`,
// `--fail-on-new-findings`)"), plus the gate-shaped exit-2 semantics the
// help table documents for `resolve` and `icp eval`.
const EXIT_CODES = {
  "0": "success",
  "1": "error",
  "2": "findings/regressions at the requested gate (--fail-on, --fail-on-new-findings); resolve: match found (exists/ambiguous); icp eval: accuracy below --min-accuracy",
} as const;

// Quoted from the Safety section of the full help reference (help.ts usage()).
const SAFETY =
  "Audits are read-only. Apply writes only operations you explicitly approve, " +
  "and never writes requires_human_* placeholders without a --value override.";

function commandRecords() {
  return Object.entries(HELP).map(([name, entry]) => ({
    name,
    summary: entry.summary,
    phase: entry.phase,
    access: commandAccess(name),
    bespokeHelp: BESPOKE_HELP.includes(name),
  }));
}

export function capabilitiesCommand(_args: string[]) {
  const payload = {
    ok: true,
    tool: "fullstackgtm",
    version: readPackageInfo().version,
    contract: {
      jsonFlag: "--json",
      planFirst: true,
      writePath:
        "write-shaped verbs emit dry-run patch plans; a CRM write happens only through `apply` on operations approved via `plans approve` (or an explicit --approve list)",
      safety: SAFETY,
      exitCodes: EXIT_CODES,
    },
    commands: commandRecords(),
    help: {
      perCommand: "npx fullstackgtm <command> --help [--json]",
      full: "npx fullstackgtm help --full",
      agentGuide: "npx fullstackgtm robot-docs",
    },
    mcp: {
      command: "npx -y fullstackgtm-mcp",
      capabilitiesTool: "fullstackgtm_capabilities",
      note: "the MCP tool inventory is self-reported by the fullstackgtm_capabilities tool, derived from the server's own registration table",
    },
    examples: [
      "npx fullstackgtm capabilities --json",
      "npx fullstackgtm audit --demo --json",
      "npx fullstackgtm plans list --json",
      "npx fullstackgtm doctor --json",
    ],
  };
  console.log(JSON.stringify(payload, null, 2));
}

function stripFrontmatter(markdown: string) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown;
  return markdown.slice(end + "\n---\n".length);
}

export function robotDocsCommand(args: string[]) {
  const topic = args.find((arg) => !arg.startsWith("-"));
  if (topic && topic !== "guide") {
    console.error(`Unknown robot-docs topic: ${topic}. Run \`fullstackgtm robot-docs\` for the agent guide.`);
    process.exitCode = 1;
    return;
  }
  // The package ships exactly one maintained agent guide —
  // skills/fullstackgtm/SKILL.md (in the npm tarball via the `files` field).
  // Print its body instead of maintaining a second hand-written guide here.
  // Resolved relative to the package root, same hop as readPackageInfo().
  let raw: string;
  try {
    raw = readFileSync(new URL("../../skills/fullstackgtm/SKILL.md", import.meta.url), "utf8");
  } catch {
    console.error(
      "robot-docs: the packaged agent guide (skills/fullstackgtm/SKILL.md) is missing from this install. " +
        "Reinstall the package, or read it at https://github.com/fullstackgtm/core/blob/main/packages/fullstackgtm/skills/fullstackgtm/SKILL.md",
    );
    process.exitCode = 1;
    return;
  }
  console.log(stripFrontmatter(raw).trim());
}

// ── `--help --json` / `help <cmd> --json` ──────────────────────────────────

export function commandHelpJsonPayload(command: string) {
  const entry = HELP[command];
  if (!entry) return null;
  return {
    ok: true,
    command,
    summary: entry.summary,
    phase: entry.phase,
    access: commandAccess(command),
    synopsis: entry.synopsis,
    detail: entry.detail ?? null,
    options: (entry.options ?? []).map(([flag, description]) => ({ flag, description })),
    seeAlso: entry.seeAlso ?? [],
    // Bespoke verbs keep a richer plain-text subcommand reference of their own.
    bespokeHelp: BESPOKE_HELP.includes(command),
    fullReference: "npx fullstackgtm help --full",
  };
}

// Nearest-command lookup lives in suggest.ts alongside the flag-typo
// handler; re-exported here so existing importers keep working.
export { suggestCommand } from "./suggest.ts";

export function unknownCommandEnvelope(command: string) {
  const suggestion = suggestCommand(command);
  return {
    ok: false as const,
    error: {
      code: "UNKNOWN_COMMAND" as const,
      message: `Unknown command: ${command}`,
      hints: [
        suggestion
          ? `Did you mean: npx fullstackgtm ${suggestion}`
          : "Run `npx fullstackgtm capabilities --json` to list supported commands.",
      ],
    },
  };
}

// Print machine-readable help for one command; unknown commands get the
// structured UNKNOWN_COMMAND envelope (exit 1) instead of a text wall.
export function printCommandHelpJson(command: string) {
  const payload = commandHelpJsonPayload(command);
  if (!payload) {
    console.log(JSON.stringify(unknownCommandEnvelope(command), null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

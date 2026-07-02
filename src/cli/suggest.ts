// Intent-inference helpers: nearest-match suggestions for unknown flags and
// commands.
//
// DESIGN RULE — same as capabilities.ts: every suggestion list is DERIVED at
// runtime from the HELP table in help.ts (the CLI's single source of truth),
// never hand-maintained. The documented-flag set is the union of every flag
// token in usage() and in each HELP entry's synopsis/options, so it stays in
// sync with the docs by construction.
//
// SAFETY RULE — suggestions never auto-execute. A near-miss flag is an error
// (exit 1) that prints the exact corrected command for the agent to run
// itself; this holds uniformly for read and write verbs, so a typo can never
// silently change what a write-shaped invocation stages.

import { HELP, usage } from "./help.ts";

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** Nearest candidate within maxDistance edits; ties break alphabetically. */
export function nearest(input: string, candidates: Iterable<string>, maxDistance: number): string | null {
  let best: string | null = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of [...candidates].sort()) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}

let cachedDocumentedFlags: Set<string> | null = null;

/**
 * Every `--flag` documented anywhere in help.ts: the full usage() reference
 * plus each HELP entry's synopsis lines and options table. Cached — help text
 * is static per process.
 */
export function documentedFlags(): Set<string> {
  if (cachedDocumentedFlags) return cachedDocumentedFlags;
  const flags = new Set<string>(usage().match(/--[a-z][a-z0-9-]*/g) ?? []);
  for (const entry of Object.values(HELP)) {
    const text = [...entry.synopsis, ...(entry.options ?? []).map(([flag]) => flag)].join(" ");
    for (const flag of text.match(/--[a-z][a-z0-9-]*/g) ?? []) flags.add(flag);
  }
  cachedDocumentedFlags = flags;
  return flags;
}

export type FlagTypo = {
  given: string;
  /** Human-readable correction, e.g. `--json` or `--rules missing-deal-owner`. */
  suggestion: string;
  /** The argv tokens that replace `given` in the corrected command. */
  replacement: string[];
};

/**
 * First argv token that is (a) flag-shaped, (b) documented nowhere in
 * help.ts, and (c) either within one edit of a documented flag after
 * lowercasing and `_`→`-` normalization (`--jsn`, `--dry_run`, `--jason`),
 * or a GNU-style `--flag=value` spelling of a documented flag (this CLI
 * takes space-separated values, so `--rules=x` was silently dropped too).
 *
 * Near-miss-only on purpose: verbs parse their own flags, so an unknown flag
 * with no near-miss may be a legitimately undocumented one (audited
 * 2026-07-01: all 12 parsed-but-undocumented flags sit ≥ 2 edits from every
 * documented flag, so distance ≤ 1 cannot collide with a real flag today).
 * Without this check a typo'd flag was silently dropped — `audit --demo
 * --jsn` exited 0 and printed markdown where the agent asked for JSON.
 */
export function detectFlagTypo(args: string[]): FlagTypo | null {
  const known = documentedFlags();
  for (const token of args) {
    if (!token.startsWith("--") || token === "--") continue;
    if (known.has(token)) continue;
    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      // `--flag=value` → suggest the space-separated form this CLI parses.
      const base = token.slice(0, equalsIndex).toLowerCase().replace(/_/g, "-");
      const value = token.slice(equalsIndex + 1);
      const resolved = known.has(base) ? base : nearest(base, known, 1);
      if (resolved) {
        const replacement = value === "" ? [resolved] : [resolved, value];
        return { given: token, suggestion: replacement.join(" "), replacement };
      }
      continue;
    }
    const normalized = token.toLowerCase().replace(/_/g, "-");
    const suggestion = known.has(normalized) ? normalized : nearest(normalized, known, 1);
    if (suggestion) return { given: token, suggestion, replacement: [suggestion] };
  }
  return null;
}

/** Nearest known command, derived from the same HELP table. */
export function suggestCommand(command: string): string | null {
  if (!command) return null;
  return nearest(command.toLowerCase(), Object.keys(HELP), 3);
}

/**
 * Shared unknown-subcommand error for the bespoke multi-verb commands
 * (`enrich apend` → "did you mean append?"). Keeps every dispatcher's
 * message in one shape: the near-miss first, then the full list.
 */
export function unknownSubcommandError(parent: string, given: string, subcommands: string[]): Error {
  const suggestion = nearest(given.toLowerCase(), subcommands, 2);
  return new Error(
    `Unknown ${parent} subcommand: ${given}.` +
      (suggestion ? ` Did you mean: fullstackgtm ${parent} ${suggestion}?` : "") +
      ` Subcommands: ${subcommands.join(", ")}.`,
  );
}

/** The exact corrected invocation to print — copy-pasteable. */
export function correctedCommand(command: string, args: string[], typo: FlagTypo): string {
  const fixed = args.flatMap((arg) => (arg === typo.given ? typo.replacement : [arg]));
  return ["fullstackgtm", command, ...fixed]
    .map((part) => (/[\s"'$]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function unknownFlagEnvelope(command: string, args: string[], typo: FlagTypo) {
  return {
    ok: false as const,
    error: {
      code: "UNKNOWN_FLAG" as const,
      message: `Unknown flag: ${typo.given}`,
      hints: [
        `Did you mean: ${typo.suggestion}`,
        `Try: ${correctedCommand(command, args, typo)}`,
      ],
    },
  };
}

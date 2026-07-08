export declare function levenshtein(a: string, b: string): number;
/** Nearest candidate within maxDistance edits; ties break alphabetically. */
export declare function nearest(input: string, candidates: Iterable<string>, maxDistance: number): string | null;
/**
 * Every `--flag` documented anywhere in help.ts: the full usage() reference
 * plus each HELP entry's synopsis lines and options table. Cached — help text
 * is static per process.
 */
export declare function documentedFlags(): Set<string>;
export type FlagTypo = {
    given: string;
    /** Human-readable correction, e.g. `--json` or `--rules missing-deal-owner`. */
    suggestion: string | null;
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
export declare function detectFlagTypo(args: string[]): FlagTypo | null;
export declare function detectUnknownFlag(command: string, args: string[]): FlagTypo | null;
/** Nearest known command, derived from the same HELP table. */
export declare function suggestCommand(command: string): string | null;
/**
 * Shared unknown-subcommand error for the bespoke multi-verb commands
 * (`enrich apend` → "did you mean append?"). Keeps every dispatcher's
 * message in one shape: the near-miss first, then the full list.
 */
export declare function unknownSubcommandError(parent: string, given: string, subcommands: string[]): Error;
/** The exact corrected invocation to print — copy-pasteable. */
export declare function correctedCommand(command: string, args: string[], typo: FlagTypo): string;
export declare function unknownFlagEnvelope(command: string, args: string[], typo: FlagTypo): {
    ok: false;
    error: {
        code: "UNKNOWN_FLAG";
        message: string;
        hints: string[];
    };
};

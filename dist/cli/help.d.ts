import type { Paint } from "./ui.ts";
export declare function usage(): string;
export type HelpEntry = {
    summary: string;
    phase: string;
    synopsis: string[];
    detail?: string;
    options?: Array<[string, string]>;
    seeAlso?: string[];
};
export declare const HELP: Record<string, HelpEntry>;
export declare const BESPOKE_HELP: string[];
export declare function shortUsage(): string;
/**
 * Interactive-terminal styling for the short front door: a dimmed one-line
 * brand header (name · version · active profile), bold title and command
 * names, cyan lifecycle-group titles. Never applied to piped output — the
 * plain shortUsage() text stays byte-identical (and `capabilities` keeps
 * deriving from the HELP table, which this never touches).
 */
export declare function stylizeShortUsage(text: string, p: Paint, info: {
    version: string;
    profile: string;
}): string;
export declare function commandHelp(command: string): string;

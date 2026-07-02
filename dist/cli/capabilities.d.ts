export type CommandAccess = "read-only" | "write-shaped";
export declare function commandAccess(name: string): CommandAccess;
export declare function capabilitiesCommand(_args: string[]): void;
export declare function robotDocsCommand(args: string[]): void;
export declare function commandHelpJsonPayload(command: string): {
    ok: boolean;
    command: string;
    summary: string;
    phase: string;
    access: CommandAccess;
    synopsis: string[];
    detail: string | null;
    options: {
        flag: string;
        description: string;
    }[];
    seeAlso: string[];
    bespokeHelp: boolean;
    fullReference: string;
} | null;
export { suggestCommand } from "./suggest.ts";
export declare function unknownCommandEnvelope(command: string): {
    ok: false;
    error: {
        code: "UNKNOWN_COMMAND";
        message: string;
        hints: string[];
    };
};
export declare function printCommandHelpJson(command: string): void;

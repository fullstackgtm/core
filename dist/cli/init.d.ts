/**
 * `init` — scaffold a GTM workspace from cold scratch: a starter icp.json, an
 * enrich.config.json (acquire preset + a visible assign seam), and a PLAYBOOK
 * wired with the chosen source/provider that points at the recipes. Pure
 * file-writer: no network, never overwrites without --force.
 */
export declare function initCommand(args: string[]): void;

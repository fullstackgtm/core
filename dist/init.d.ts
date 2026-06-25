/**
 * `fullstackgtm init` — scaffold a GTM workspace from cold scratch.
 *
 * The product thesis (see docs/recipes.md): the CLI ships governed PRIMITIVES;
 * the user's coding agent is the orchestrator. There is deliberately no
 * `outbound` mega-verb. `init` is the one piece of scaffolding that earns its
 * keep — it writes the three files a workspace needs so the very first
 * `enrich acquire` / `signals` / `judge` / `draft` commands work, plus a
 * PLAYBOOK that points at the recipes wired with THIS workspace's source and
 * provider.
 *
 * It is a pure file-writer: no network, no credentials, never overwrites
 * without `--force`. The starter ICP is a valid (editable) example so
 * `icp show` / `enrich acquire` run immediately; re-run `icp interview` to
 * replace it with a real one.
 */
import { type EnrichConfig } from "./enrich.ts";
import { type Icp } from "./icp.ts";
export type InitProvider = "hubspot" | "salesforce";
export type InitSource = "pipe0" | "explorium" | "linkedin";
export type ScaffoldOptions = {
    /** discovery source the acquire preset + playbook are wired for. Default "pipe0". */
    source?: InitSource;
    /** CRM the playbook writes against. Default "hubspot". */
    provider?: InitProvider;
    /** profile the playbook scopes commands to (omitted = default profile). */
    profile?: string;
};
export type ScaffoldFile = {
    path: string;
    content: string;
};
/** A generic, valid starter ICP. Edit it, or replace via `icp interview`. */
export declare function starterIcp(): Icp;
/** The acquire preset for the chosen source, with an explicit (placeholder)
 *  assign policy so the seam is visible — leads are never silently ownerless. */
export declare function starterEnrichConfig(source: InitSource): EnrichConfig;
/** The workspace PLAYBOOK: the cold-start + outbound-loop recipes wired with the
 *  chosen source/provider/profile, pointing at docs/recipes.md for the rest. */
export declare function starterPlaybook(opts: Required<Pick<ScaffoldOptions, "source" | "provider">> & {
    profile?: string;
}): string;
/**
 * Build the set of files `init` would write (pure — no IO). The caller decides
 * which to actually write (skipping existing files unless --force).
 */
export declare function scaffoldWorkspace(opts?: ScaffoldOptions): ScaffoldFile[];

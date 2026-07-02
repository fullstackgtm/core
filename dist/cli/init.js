// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeProfile, DEFAULT_PROFILE } from "../credentials.js";
import { scaffoldWorkspace } from "../init.js";
import { option } from "./shared.js";
/**
 * `init` — scaffold a GTM workspace from cold scratch: a starter icp.json, an
 * enrich.config.json (acquire preset + a visible assign seam), and a PLAYBOOK
 * wired with the chosen source/provider that points at the recipes. Pure
 * file-writer: no network, never overwrites without --force.
 */
export function initCommand(args) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`Usage:
  fullstackgtm init [--source pipe0|explorium|linkedin] [--provider hubspot|salesforce] [--out <dir>] [--force]

Scaffolds a workspace so the first acquire/signals/judge/draft commands work:
  icp.json            starter ICP (edit, or rebuild with \`icp interview\`)
  enrich.config.json  acquire preset for --source + a placeholder assign policy
  PLAYBOOK.md         the cold-start + outbound-loop recipes wired for this workspace

The CLI ships governed primitives; your coding agent is the orchestrator. See
docs/recipes.md for the full play set. Existing files are kept unless --force.`);
        return;
    }
    const source = (option(args, "--source") ?? "pipe0");
    if (!["pipe0", "explorium", "linkedin"].includes(source)) {
        throw new Error(`init: --source must be pipe0|explorium|linkedin (got "${source}")`);
    }
    const provider = (option(args, "--provider") ?? "hubspot");
    if (!["hubspot", "salesforce"].includes(provider)) {
        throw new Error(`init: --provider must be hubspot|salesforce (got "${provider}")`);
    }
    const outDir = resolve(process.cwd(), option(args, "--out") ?? ".");
    const force = args.includes("--force");
    const current = activeProfile();
    const profile = current === DEFAULT_PROFILE ? undefined : current;
    const files = scaffoldWorkspace({ source, provider, profile });
    const wrote = [];
    const kept = [];
    for (const file of files) {
        const path = resolve(outDir, file.path);
        if (existsSync(path) && !force) {
            kept.push(file.path);
            continue;
        }
        writeFileSync(path, file.content);
        wrote.push(file.path);
    }
    console.log(`Scaffolded workspace (${provider}, discovery via ${source}${profile ? `, profile ${profile}` : ""}).`);
    if (wrote.length)
        console.log(`  wrote: ${wrote.join(", ")}`);
    if (kept.length)
        console.log(`  kept (use --force to overwrite): ${kept.join(", ")}`);
    console.log("\nNext: edit icp.json + set acquire.assign.ownerId in enrich.config.json, then follow PLAYBOOK.md\n" +
        "(full recipe set: docs/recipes.md).");
}

#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: fullstackgtm-mcp [--help] [--version]

Starts the fullstackgtm MCP stdio server.

The MCP server requires optional peer dependencies:
  @modelcontextprotocol/sdk
  zod

Zero-install with peers:
  npx -y -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(await readPackageVersion());
  process.exit(0);
}

export {};

async function readPackageVersion(): Promise<string> {
  try {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The MCP server needs the optional peer dependencies. Import dynamically so
// a missing peer produces install guidance instead of a module-load stack
// trace — `npx fullstackgtm-mcp` alone never installs optional peers.
const MISSING_PEER_HELP = `The MCP server needs the optional peer dependencies @modelcontextprotocol/sdk and zod.

In a project:
  npm install fullstackgtm @modelcontextprotocol/sdk zod

Zero-install (the fullstackgtm-mcp wrapper package bundles the peers):
  npx -y fullstackgtm-mcp`;

function isMissingPeerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  return error.message.includes("@modelcontextprotocol/sdk") || error.message.includes("zod");
}

try {
  const { startMcpServer } = await import("./mcp.ts");
  await startMcpServer();
} catch (error) {
  if (isMissingPeerError(error)) {
    console.error(MISSING_PEER_HELP);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

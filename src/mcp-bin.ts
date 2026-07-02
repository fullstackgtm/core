#!/usr/bin/env node
export {};

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

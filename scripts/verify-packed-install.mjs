import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const withPeers = process.argv.includes("--with-peers");
const keep = process.argv.includes("--keep-temp");
const tempRoot = await mkdtemp(join(tmpdir(), "fullstackgtm-pack-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status ?? "no exit code"}): ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function walk(root, prefix = "") {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name).replaceAll("\\", "/");
    paths.push(relative);
    if (entry.isDirectory()) paths.push(...await walk(root, relative));
  }
  return paths;
}

try {
  const pack = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot]);
  const packResult = JSON.parse(pack.stdout);
  assert(Array.isArray(packResult) && packResult.length === 1, "npm pack did not describe exactly one archive");
  const archive = join(tempRoot, packResult[0].filename);
  const packedPaths = new Set(packResult[0].files.map(({ path }) => path));

  for (const required of [
    "package.json", "dist/index.js", "dist/index.d.ts", "dist/bin.js", "dist/mcp-bin.js",
    "LICENSE", "NOTICE", "README.md", "SECURITY.md", "DATA-FLOWS.md",
  ]) assert(packedPaths.has(required), `Packed archive is missing required file: ${required}`);
  for (const path of packedPaths) {
    assert(!/^(?:oss|evals|tests|agent_ergonomics_audit)(?:\/|$)/.test(path), `Prohibited internal path was packed: ${path}`);
    assert(!/(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.pem$|[^/]*\.key$)/.test(path), `Secret-like path was packed: ${path}`);
  }

  const project = join(tempRoot, withPeers ? "with-peers" : "without-peers");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const installArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (!withPeers) installArgs.push("--omit=optional");
  installArgs.push(archive);
  if (withPeers) installArgs.push("@modelcontextprotocol/sdk@^1.29.0", "zod@^4.4.2");
  run(npm, installArgs, { cwd: project });

  const installed = join(project, "node_modules", "fullstackgtm");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert(manifest.exports?.["."]?.types === "./dist/index.d.ts", "Root types export is missing or changed");
  assert(manifest.exports?.["."]?.import === "./dist/index.js", "Root ESM export is missing or changed");
  assert(manifest.bin?.fullstackgtm === "dist/bin.js", "fullstackgtm bin mapping is missing or changed");
  assert(manifest.bin?.["fullstackgtm-mcp"] === "dist/mcp-bin.js", "fullstackgtm-mcp bin mapping is missing or changed");
  await import(pathToFileURL(join(installed, "dist", "index.js")).href);

  for (const bin of ["dist/bin.js", "dist/mcp-bin.js"]) {
    const result = run(process.execPath, [join(installed, bin), "--help"], { cwd: project });
    assert(result.stdout.includes("Usage:"), `${basename(bin)} --help did not print usage`);
    assert(result.stderr === "", `${basename(bin)} --help wrote to stderr`);
  }

  const resolveFromProject = createRequire(join(project, "package.json")).resolve;
  for (const peer of ["@modelcontextprotocol/sdk/package.json", "zod/package.json"]) {
    let present = true;
    try { resolveFromProject(peer); } catch { present = false; }
    assert(present === withPeers, `${peer} was ${present ? "present" : "absent"} in the ${withPeers ? "with" : "without"}-peers install`);
  }

  const installedPaths = await walk(installed);
  assert(!installedPaths.some((path) => path.startsWith("scripts/")), "Release-verification scripts unexpectedly shipped in the npm archive");
  console.log(`Packed-install conformance OK (${withPeers ? "with" : "without"} optional peers, Node ${process.versions.node}, ${process.platform})`);
} finally {
  if (keep) console.log(`Kept temporary files at ${tempRoot}`);
  else await rm(tempRoot, { recursive: true, force: true });
}

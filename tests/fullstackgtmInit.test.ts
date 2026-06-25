import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseEnrichConfig,
  scaffoldWorkspace,
  starterEnrichConfig,
  starterIcp,
  starterPlaybook,
} from "../src/index.ts";
import { parseIcp } from "../src/icp.ts";
import { runCli } from "../src/cli.ts";

test("starterIcp is a valid ICP (parseIcp accepts it) with a scoring threshold", () => {
  const icp = starterIcp();
  // parseIcp throws on an invalid ICP — round-trip the serialized form.
  const parsed = parseIcp(`${JSON.stringify(icp)}`);
  assert.ok(parsed.persona.titleKeywords && parsed.persona.titleKeywords.length > 0);
  assert.equal(typeof parsed.scoring?.threshold, "number");
});

test("starterEnrichConfig is acquire-ready with a visible assign seam", () => {
  for (const source of ["pipe0", "explorium", "linkedin"] as const) {
    const config = parseEnrichConfig(`${JSON.stringify(starterEnrichConfig(source))}`);
    assert.ok(config.acquire, `${source}: has an acquire section`);
    assert.ok(config.acquire?.create.contact, `${source}: creates contacts`);
    // The assign seam is present so leads are never silently ownerless.
    assert.equal(config.acquire?.assign?.strategy, "fixed", `${source}: fixed assign policy`);
    assert.match(
      JSON.stringify(config.acquire?.assign),
      /REPLACE_WITH_OWNER_ID/,
      `${source}: a clearly-placeholder owner id to replace`,
    );
  }
  // linkedin keys on the LinkedIn URL (leads are sparse on email); pipe0 on email.
  assert.equal(starterEnrichConfig("linkedin").acquire?.create.contact?.matchKey, "linkedin");
  assert.equal(starterEnrichConfig("pipe0").acquire?.create.contact?.matchKey, "email");
});

test("starterPlaybook wires the chosen source, provider, and profile", () => {
  const pb = starterPlaybook({ source: "explorium", provider: "salesforce", profile: "acme" });
  assert.match(pb, /enrich acquire --source explorium --provider salesforce --profile acme/);
  assert.match(pb, /login salesforce --profile acme/);
  assert.match(pb, /never sends/i);
  // No profile → no --profile noise in the commands.
  const plain = starterPlaybook({ source: "pipe0", provider: "hubspot" });
  assert.doesNotMatch(plain, /--profile/);
  assert.match(plain, /login heyreach|login pipe0/);
});

test("scaffoldWorkspace emits the three workspace files", () => {
  const files = scaffoldWorkspace({ source: "pipe0", provider: "hubspot" });
  const names = files.map((f) => f.path).sort();
  assert.deepEqual(names, ["PLAYBOOK.md", "enrich.config.json", "icp.json"]);
});

test("init writes the workspace, keeps existing files, and --force overwrites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-init-"));
  const origLog = console.log;
  const out: string[] = [];
  try {
    console.log = (m: unknown) => out.push(String(m));

    // 1. Fresh init writes all three files.
    await runCli(["init", "--out", dir, "--source", "pipe0", "--provider", "hubspot"]);
    const icp = parseIcp(readFileSync(join(dir, "icp.json"), "utf8"));
    assert.ok(icp.name);
    parseEnrichConfig(readFileSync(join(dir, "enrich.config.json"), "utf8")); // throws if invalid
    assert.match(readFileSync(join(dir, "PLAYBOOK.md"), "utf8"), /Workspace playbook/);
    assert.match(out.join("\n"), /wrote: .*icp\.json/);

    // 2. A user edit survives a second init (no --force keeps existing files).
    writeFileSync(join(dir, "icp.json"), '{"name":"MINE"}\n');
    out.length = 0;
    await runCli(["init", "--out", dir]);
    assert.equal(JSON.parse(readFileSync(join(dir, "icp.json"), "utf8")).name, "MINE");
    assert.match(out.join("\n"), /kept .*icp\.json/);

    // 3. --force overwrites the edited file back to the starter.
    out.length = 0;
    await runCli(["init", "--out", dir, "--force"]);
    assert.notEqual(JSON.parse(readFileSync(join(dir, "icp.json"), "utf8")).name, "MINE");
    assert.match(out.join("\n"), /wrote: .*icp\.json/);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init rejects unknown --source / --provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-init-"));
  const origLog = console.log;
  try {
    console.log = () => {};
    await assert.rejects(() => runCli(["init", "--out", dir, "--source", "bogus"]), /--source must be/);
    await assert.rejects(() => runCli(["init", "--out", dir, "--provider", "bogus"]), /--provider must be/);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

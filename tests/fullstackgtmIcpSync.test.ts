import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactKeyForDomain, classifyIcpSync, extractHostedIcp, icpSha256, readIcpSyncState, sidecarPathFor, writeIcpSyncState, type IcpSyncState } from "../src/icpSync.ts";

const icp = { name: "Acme ICP", firmographics: { industries: ["Software"] }, persona: { titleKeywords: ["VP Sales"] } };
const tracked: IcpSyncState = { version: 1, artifactId: "a1", key: "icp:acme.com", domain: "acme.com", revision: 3, localIcpSha256: icpSha256(icp), syncedAt: "2026-01-01T00:00:00.000Z" };

test("ICP sync classifies independent and concurrent changes without merging arrays", () => {
  assert.equal(classifyIcpSync(tracked.localIcpSha256, 3, tracked.localIcpSha256, tracked), "in_sync");
  assert.equal(classifyIcpSync("local-new", 3, tracked.localIcpSha256, tracked), "local_changed");
  assert.equal(classifyIcpSync(tracked.localIcpSha256, 4, "hosted-new", tracked), "hosted_changed");
  assert.equal(classifyIcpSync("local-new", 4, "hosted-new", tracked), "conflict");
  assert.equal(classifyIcpSync("local", 1, "hosted", null), "untracked");
});

test("ICP sidecar is separate, private sync metadata and hosted extraction validates ICP", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-icp-sync-"));
  try {
    const path = join(dir, "icp.json"); writeIcpSyncState(path, tracked);
    assert.equal(sidecarPathFor(path), join(dir, ".fullstackgtm", "icp.json.sync.json"));
    assert.deepEqual(readIcpSyncState(path), tracked);
    assert.equal(JSON.parse(readFileSync(sidecarPathFor(path), "utf8")).revision, 3);
    assert.deepEqual(extractHostedIcp({ artifactId: "a1", kind: "icp", key: tracked.key, label: icp.name, document: { company: { domain: "acme.com" }, icp }, revision: 3, origin: "cli", updatedAt: 1 }), icp);
    assert.equal(artifactKeyForDomain("https://ACME.com/"), "icp:acme.com");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

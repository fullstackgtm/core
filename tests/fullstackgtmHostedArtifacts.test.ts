import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storeCredential } from "../src/credentials.ts";
import { readHostedArtifact, writeHostedArtifact } from "../src/hostedArtifacts.ts";

function isolated(run: () => Promise<void>) {
  return async () => {
    const previous = process.env.FSGTM_HOME;
    const home = mkdtempSync(join(tmpdir(), "fsgtm-artifact-sync-"));
    process.env.FSGTM_HOME = home;
    try { await run(); } finally {
      if (previous === undefined) delete process.env.FSGTM_HOME; else process.env.FSGTM_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("artifact mirroring is inert until a human pairs the CLI", isolated(async () => {
  let called = false;
  const result = await writeHostedArtifact({ kind: "icp", key: "icp:acme.com", label: "Acme ICP", document: {} }, {
    fetchImpl: async () => { called = true; throw new Error("must not call"); },
  });
  assert.deepEqual(result, { status: "unpaired" });
  assert.equal(called, false);
}));

test("paired artifact writes authenticate and preserve the canonical document", isolated(async () => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://team.example.test",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  let request: Request | undefined;
  const document = { company: { domain: "acme.com" }, icp: { name: "Acme ICP" }, evidence: [{ excerpt: "public proof" }] };
  const result = await writeHostedArtifact({ kind: "icp", key: "icp:acme.com", label: "Acme ICP", domain: "acme.com", document }, {
    fetchImpl: async (input, init) => { request = new Request(input, init); return Response.json({ artifactId: "a1", created: true, updatedAt: 123, revision: 1, documentSha256: "abc", unchanged: false }); },
  });
  assert.deepEqual(result, { status: "saved", artifactId: "a1", created: true, updatedAt: 123, revision: 1, documentSha256: "abc", unchanged: false });
  assert.equal(request?.url, "https://team.example.test/api/cli/artifact");
  assert.equal(request?.headers.get("authorization"), "Bearer pair-secret");
  assert.deepEqual((await request?.json())?.document, document);
}));

test("artifact transport exposes reads and revision conflicts", isolated(async () => {
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "https://team.example.test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const state = { artifactId: "a1", kind: "icp" as const, key: "icp:acme.com", label: "Acme", document: { icp: { name: "Acme" } }, revision: 4, origin: "hosted" as const, updatedAt: 123 };
  const read = await readHostedArtifact("icp", "icp:acme.com", { fetchImpl: async () => Response.json(state) });
  assert.deepEqual(read, { status: "found", state });
  const conflict = await writeHostedArtifact({ kind: "icp", key: state.key, label: state.label, document: state.document, expectedRevision: 3 }, { fetchImpl: async () => Response.json({ currentRevision: 4, documentSha256: "new" }, { status: 409 }) });
  assert.deepEqual(conflict, { status: "conflict", reason: "hosted ICP changed since the last sync", currentRevision: 4, documentSha256: "new" });
}));

test("artifact transport rejects invalid metadata and insecure brokers", isolated(async () => {
  await assert.rejects(() => writeHostedArtifact({ kind: "signal_run", key: "", label: "run", document: {} }), /key\/label/);
  storeCredential("broker", { kind: "broker", accessToken: "pair-secret", baseUrl: "http://hosted.example.test",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  assert.deepEqual(await writeHostedArtifact({ kind: "signal_run", key: "signals:one", label: "one", document: {} }), { status: "unpaired" });
}));

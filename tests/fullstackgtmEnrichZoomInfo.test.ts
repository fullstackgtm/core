import assert from "node:assert/strict";
import test from "node:test";
import {
  createZoomInfoClient,
  pullZoomInfoRecords,
  type ZoomInfoCommandRunner,
} from "../src/enrichZoomInfo.ts";

function scriptedRunner(outputs: unknown[], calls: Array<{ executable: string; args: string[] }>): ZoomInfoCommandRunner {
  return async (executable, args) => {
    calls.push({ executable, args });
    const next = outputs.shift();
    if (next === undefined) throw new Error("fake ZoomInfo script exhausted");
    return { stdout: JSON.stringify(next), stderr: "" };
  };
}

test("ZoomInfo client invokes the official gtm CLI with structured argv and JSON output", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const client = createZoomInfoClient({
    executable: "/opt/bin/gtm",
    run: scriptedRunner([
      { data: [{ id: "42", attributes: { name: "Acme", website: "acme.com" } }] },
      { data: [{ id: "84", attributes: { fullName: "Jane Doe", email: "jane@acme.com" } }] },
    ], calls),
  });

  await client.enrichCompany("acme.com");
  await client.enrichContact("jane@acme.com");

  assert.deepEqual(calls, [
    { executable: "/opt/bin/gtm", args: ["companies", "enrich", "--domain", "acme.com", "-f", "json"] },
    { executable: "/opt/bin/gtm", args: ["contacts", "enrich", "--email", "jane@acme.com", "-f", "json"] },
  ]);
});

test("ZoomInfo pull normalizes JSON:API records, records misses, checkpoints, and resumes", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const client = createZoomInfoClient({
    run: scriptedRunner([
      { data: [{ id: "42", attributes: { name: "Acme Inc", website: "https://acme.com", employeeCount: 200 } }] },
      { data: [] },
    ], calls),
  });
  const progress: string[] = [];
  const result = await pullZoomInfoRecords(
    client,
    [
      { objectType: "company", key: "domain", value: "acme.com" },
      { objectType: "contact", key: "email", value: "missing@acme.com" },
    ],
    { onProgress: (item) => void progress.push(item.lastKeyValue) },
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "zoominfo:company_42");
  assert.deepEqual(result.records[0].keys, { domain: "https://acme.com", name: "Acme Inc" });
  assert.equal((result.records[0].payload.attributes as Record<string, unknown>).employeeCount, 200);
  assert.deepEqual(result.misses, [{ objectType: "contact", key: "email", value: "missing@acme.com" }]);
  assert.deepEqual(progress, ["acme.com", "missing@acme.com"]);

  const resumeCalls: Array<{ executable: string; args: string[] }> = [];
  const resumedClient = createZoomInfoClient({
    run: scriptedRunner([
      { data: [{ id: "84", attributes: { fullName: "Jane Doe", emailAddress: "jane@acme.com" } }] },
    ], resumeCalls),
  });
  const resumed = await pullZoomInfoRecords(
    resumedClient,
    [
      { objectType: "company", key: "domain", value: "acme.com" },
      { objectType: "contact", key: "email", value: "jane@acme.com" },
    ],
    { resumeAfter: "acme.com" },
  );
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumed.records[0].id, "zoominfo:contact_84");
  assert.deepEqual(resumed.records[0].keys, { email: "jane@acme.com", name: "Jane Doe" });
});

test("ZoomInfo client refuses non-JSON output", async () => {
  const client = createZoomInfoClient({
    run: async () => ({ stdout: "please log in", stderr: "" }),
  });
  await assert.rejects(client.enrichCompany("acme.com"), /returned non-JSON output/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the credential store at an empty temp dir before the CLI module
// loads, so the report reflects a fresh machine regardless of the host.
process.env.FSGTM_HOME = mkdtempSync(join(tmpdir(), "fsgtm-doctor-"));
const { doctorReport } = await import("../src/cli.ts");

test("doctor reports a fresh machine with no credentials", () => {
  const report = doctorReport({});

  assert.equal(report.node.ok, true);
  assert.equal(report.package.name, "fullstackgtm");
  assert.notEqual(report.package.version, "unknown");
  assert.equal(report.credentialStore.exists, false);
  assert.equal(report.broker.paired, false);
  for (const provider of ["hubspot", "salesforce", "stripe"]) {
    assert.equal(report.providers[provider].source, "none", `${provider} should be unconnected`);
  }
  // A fresh machine is steered to the zero-credential demo first.
  assert.match(report.nextSteps[0], /audit --demo/);
});

test("doctor detects ambient env credentials and suggests a live audit", () => {
  const report = doctorReport({
    HUBSPOT_ACCESS_TOKEN: "pat-test",
    SALESFORCE_ACCESS_TOKEN: "sf-test",
    SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com",
  });

  assert.equal(report.providers.hubspot.source, "env");
  assert.equal(report.providers.salesforce.source, "env");
  assert.equal(report.providers.stripe.source, "none");
  assert.match(report.nextSteps[0], /audit --provider hubspot/);
});

test("doctor report is JSON-serializable for agents", () => {
  const report = doctorReport({});
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.deepEqual(roundTripped, report);
});

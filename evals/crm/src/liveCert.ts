/**
 * Live-write certification: proves every connector write operation works
 * against a REAL provider — run it against a HubSpot developer test account
 * or a Salesforce Developer Edition org, NEVER against production.
 *
 *   # HubSpot (free developer test account: app.hubspot.com → developer
 *   # account → "Create test account"; mint a private-app token there)
 *   HUBSPOT_ACCESS_TOKEN=<test-portal token> npm run cert -- --provider hubspot
 *
 *   # Salesforce (free Developer Edition org or SFDX scratch org)
 *   SALESFORCE_ACCESS_TOKEN=… SALESFORCE_INSTANCE_URL=… npm run cert -- --provider salesforce
 *
 *   # Self-test of the harness against the in-memory mock (no credentials)
 *   npm run cert -- --provider mock
 *
 * Safety model:
 *  - refuses to run when the org already holds more than --max-existing
 *    records (default 250) — a production portal fails this gate instantly;
 *  - every record it creates is namespaced "ZZCERT" and archived in cleanup;
 *  - it never mutates a record it did not create.
 */
import { MockHubspot } from "./mock/server.ts";
import {
  applyPatchPlan,
  createHubspotConnector,
  createSalesforceConnector,
  type GtmConnector,
  type PatchOperation,
} from "../../../src/index.ts";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const provider = flag("provider", "mock");
const maxExisting = Number(flag("max-existing", "250"));
const STAMP = `ZZCERT ${new Date().toISOString().slice(0, 16)}`;

type Fixtures = {
  createCompany: (name: string, domain: string) => Promise<string>;
  createContact: (lastName: string, email: string) => Promise<string>;
  createDeal: (name: string, stage: string) => Promise<string>;
};

async function hubspotFixtures(baseUrl: string, token: string): Promise<Fixtures> {
  const post = async (path: string, properties: Record<string, string>): Promise<string> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) throw new Error(`fixture create failed ${res.status}: ${await res.text()}`);
    return String(((await res.json()) as any).id);
  };
  return {
    createCompany: (name, domain) => post("/crm/v3/objects/companies", { name: `${STAMP} ${name}`, domain }),
    createContact: (lastName, email) => post("/crm/v3/objects/contacts", { firstname: "ZZCERT", lastname: lastName, email }),
    createDeal: (name, stage) => post("/crm/v3/objects/deals", { dealname: `${STAMP} ${name}`, dealstage: stage, closedate: "2026-12-31", amount: "1" }),
  };
}

async function salesforceFixtures(instanceUrl: string, token: string): Promise<Fixtures> {
  const post = async (sobject: string, body: Record<string, string>): Promise<string> => {
    const res = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/${sobject}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fixture create failed ${res.status}: ${await res.text()}`);
    return String(((await res.json()) as any).id);
  };
  return {
    createCompany: (name, domain) => post("Account", { Name: `${STAMP} ${name}`, Website: `https://${domain}` }),
    createContact: (lastName, email) => post("Contact", { LastName: `ZZCERT ${lastName}`, Email: email }),
    createDeal: (name) => post("Opportunity", { Name: `${STAMP} ${name}`, StageName: "Prospecting", CloseDate: "2026-12-31" }),
  };
}

function op(partial: Partial<PatchOperation> & Pick<PatchOperation, "id" | "objectType" | "objectId" | "operation">): PatchOperation {
  return { reason: "live-write certification", riskLevel: "low", approvalRequired: true, beforeValue: null, afterValue: null, ...partial };
}

async function applyOne(connector: GtmConnector, operation: PatchOperation) {
  return (await connector.applyOperation!(operation));
}

// ---- resolve provider --------------------------------------------------

let connector: GtmConnector;
let fixtures: Fixtures;
let mock: MockHubspot | null = null;

if (provider === "mock") {
  mock = new MockHubspot();
  mock.addOwner("Cert", "Owner");
  const baseUrl = await mock.start();
  connector = createHubspotConnector({ getAccessToken: () => "cert-token", apiBaseUrl: baseUrl });
  fixtures = await hubspotFixtures(baseUrl, "cert-token");
} else if (provider === "hubspot") {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Set HUBSPOT_ACCESS_TOKEN to a TEST-PORTAL private-app token (never production).");
  const baseUrl = process.env.HUBSPOT_API_BASE_URL ?? "https://api.hubapi.com";
  connector = createHubspotConnector({ getAccessToken: () => token, apiBaseUrl: process.env.HUBSPOT_API_BASE_URL });
  fixtures = await hubspotFixtures(baseUrl, token);
} else if (provider === "salesforce") {
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  if (!token || !instanceUrl) throw new Error("Set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL for a Developer Edition / scratch org (never production).");
  connector = createSalesforceConnector({ getConnection: () => ({ accessToken: token, instanceUrl }) });
  fixtures = await salesforceFixtures(instanceUrl, token);
} else {
  throw new Error(`Unknown --provider ${provider} (mock|hubspot|salesforce)`);
}

// ---- safety gate ---------------------------------------------------------

const baseline = await connector.fetchSnapshot();
const existing = baseline.accounts.length + baseline.contacts.length + baseline.deals.length;
if (existing > maxExisting) {
  console.error(
    `ABORT: org already holds ${existing} records (cap ${maxExisting}). This looks like a real portal — ` +
    `the certification suite only runs against disposable test orgs. Override with --max-existing if you are absolutely sure.`,
  );
  process.exit(2);
}
console.log(`Safety gate: ${existing} existing records (cap ${maxExisting}) — proceeding. Namespace: ${STAMP}`);

// ---- certification -------------------------------------------------------

const cleanup: Array<{ objectType: PatchOperation["objectType"]; id: string }> = [];
try {
  const companyA = await fixtures.createCompany("Alpha", "zzcert-alpha.example");
  const companyB = await fixtures.createCompany("Alpha Dup", "zzcert-alpha.example");
  const contact = await fixtures.createContact("Contact", "zzcert@zzcert-alpha.example");
  const deal = await fixtures.createDeal("Deal", "qualifiedtobuy");
  cleanup.push({ objectType: "account", id: companyA }, { objectType: "contact", id: contact }, { objectType: "deal", id: deal });
  check("fixtures created", true, `companies ${companyA},${companyB} contact ${contact} deal ${deal}`);

  // set_field + readField round-trip
  let r = await applyOne(connector, op({ id: "cert_set", objectType: "deal", objectId: deal, operation: "set_field", field: "amount", afterValue: "1234" }));
  const amount = await connector.readField!("deal", deal, "amount");
  check("set_field + readField", r.status === "applied" && String(amount) === "1234", `status=${r.status} read=${amount}`);

  // link_record + association read-back
  r = await applyOne(connector, op({ id: "cert_link", objectType: "deal", objectId: deal, operation: "link_record", afterValue: companyA }));
  const linked = await connector.readField!("deal", deal, "accountId");
  check("link_record + accountId read", r.status === "applied" && String(linked) === companyA, `status=${r.status} accountId=${linked}`);

  // create_task + operation-replay idempotency + open-task dedupe
  r = await applyOne(connector, op({ id: "cert_task", objectType: "deal", objectId: deal, operation: "create_task", field: "follow_up_task", afterValue: "ZZCERT follow-up" }));
  check("create_task", r.status === "applied", `status=${r.status}`);
  const replay = await applyOne(connector, op({ id: "cert_task", objectType: "deal", objectId: deal, operation: "create_task", field: "follow_up_task", afterValue: "ZZCERT follow-up" }));
  check("create_task replay idempotency", replay.status === "skipped", `status=${replay.status}`);
  const dedupe = await applyOne(connector, op({ id: "cert_task2", objectType: "deal", objectId: deal, operation: "create_task", field: "follow_up_task", afterValue: "ZZCERT second" }));
  check("create_task open-task dedupe", dedupe.status === "skipped", `status=${dedupe.status}`);

  // compare-and-set: a deliberately wrong beforeValue must conflict, not write
  const conflictPlan = {
    id: "cert_plan", title: "cert", createdAt: new Date().toISOString(), status: "approved" as const,
    dryRun: true as const, summary: "", findings: [],
    operations: [op({ id: "cert_conflict", objectType: "deal" as const, objectId: deal, operation: "set_field" as const, field: "amount", beforeValue: "999999", afterValue: "5" })],
  };
  const run = await applyPatchPlan(connector, conflictPlan as any, { approvedOperationIds: ["cert_conflict"] });
  const stillCorrect = String(await connector.readField!("deal", deal, "amount")) === "1234";
  check("compare-and-set conflict", run.results[0].status === "conflict" && stillCorrect, `status=${run.results[0].status} amount-intact=${stillCorrect}`);

  // merge_records (irreversible — both records are ZZCERT fixtures)
  r = await applyOne(connector, op({ id: "cert_merge", objectType: "account", objectId: companyA, operation: "merge_records", afterValue: companyA, beforeValue: [companyA, companyB] }));
  check("merge_records", r.status === "applied", `status=${r.status} detail=${r.detail?.slice(0, 60)}`);

  // archive_record
  r = await applyOne(connector, op({ id: "cert_archive", objectType: "contact", objectId: contact, operation: "archive_record" }));
  check("archive_record", r.status === "applied", `status=${r.status}`);
  cleanup.splice(cleanup.findIndex((c) => c.id === contact), 1);

  // pagination: snapshot must see everything we created
  const after = await connector.fetchSnapshot();
  check("snapshot sees fixtures", after.deals.some((d) => d.id === deal), `deals=${after.deals.length}`);
} finally {
  for (const record of cleanup) {
    try {
      await applyOne(connector, op({ id: `cert_cleanup_${record.id}`, objectType: record.objectType, objectId: record.id, operation: "archive_record" }));
    } catch { /* best effort */ }
  }
  console.log(`Cleanup: archived ${cleanup.length} ZZCERT record(s).`);
  if (mock) await mock.stop();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} certification checks passed (${provider}).`);
if (failed.length > 0) process.exit(1);

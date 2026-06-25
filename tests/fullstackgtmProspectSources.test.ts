import assert from "node:assert/strict";
import test from "node:test";
import {
  hostFromUrl,
  pipe0ResolveCompanyDomains,
  pipe0ResolveWorkEmails,
  type Prospect,
} from "../src/connectors/prospectSources.ts";

test("hostFromUrl: bare registrable host from URLs and domains", () => {
  assert.equal(hostFromUrl("https://www.momence.com/about"), "momence.com");
  assert.equal(hostFromUrl("http://ripple.com"), "ripple.com");
  assert.equal(hostFromUrl("stratamedia.co"), "stratamedia.co");
  assert.equal(hostFromUrl(""), undefined);
  assert.equal(hostFromUrl(undefined), undefined);
  assert.equal(hostFromUrl("not a url"), undefined);
});

test("pipe0ResolveCompanyDomains: fills companyDomain from company:identity, leaves resolved ones alone", async () => {
  const calls: Array<{ pipe: string; input: unknown }> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ pipe: body.pipes?.[0]?.pipe_id, input: body.input });
    // Echo a company:identity-shaped response: one record per input company.
    const order: string[] = [];
    const records: Record<string, unknown> = {};
    const sites: Record<string, string> = { Momence: "https://momence.com", Ripple: "https://www.ripple.com" };
    (body.input as Array<{ company_name: string }>).forEach((row, i) => {
      const id = `r${i}`;
      order.push(id);
      records[id] = {
        fields: {
          company_name: { value: row.company_name, status: "completed" },
          company_website_url: sites[row.company_name]
            ? { value: sites[row.company_name], status: "completed" }
            : { value: null, status: "failed" },
        },
      };
    });
    return new Response(JSON.stringify({ order, records }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const prospects: Prospect[] = [
    { fullName: "Michael Fontanella", companyName: "Momence" },
    { fullName: "Erica Sene", companyName: "Ripple" },
    { fullName: "Dana Pre", companyName: "Already Inc", companyDomain: "already.com" }, // skipped — has a domain
    { fullName: "Unknowable Person", companyName: "No Website Co" }, // not resolved → left as-is
  ];
  const out = await pipe0ResolveCompanyDomains({ apiKey: "k", prospects, fetchImpl: fakeFetch });

  assert.equal(out[0].companyDomain, "momence.com");
  assert.equal(out[1].companyDomain, "ripple.com");
  assert.equal(out[2].companyDomain, "already.com"); // untouched
  assert.equal(out[3].companyDomain, undefined); // unresolved, not guessed
  // Only companies missing a domain are looked up (3 of 4), deduped by name.
  const looked = calls.flatMap((c) => (c.input as Array<{ company_name: string }>).map((r) => r.company_name));
  assert.deepEqual(new Set(looked), new Set(["Momence", "Ripple", "No Website Co"]));
  assert.ok(calls.every((c) => c.pipe === "company:identity@1"));
});

test("pipe0ResolveWorkEmails: resolves across many concurrent chunks and recovers a transient failure", async () => {
  let calls = 0;
  let failedOnce = false;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const inputs = body.input as Array<{ name: string; company_domain?: string }>;
    // Fail the very first call once (transient) — the retry must recover it.
    if (!failedOnce) {
      failedOnce = true;
      return new Response("rate limited", { status: 429 });
    }
    const order: string[] = [];
    const records: Record<string, unknown> = {};
    inputs.forEach((row, i) => {
      const id = `${calls}_${i}`;
      order.push(id);
      records[id] = {
        fields: {
          name: { value: row.name, status: "completed" },
          company_domain: { value: row.company_domain, status: "completed" },
          work_email: { value: `hit@${row.company_domain}`, status: "completed" },
        },
      };
    });
    return new Response(JSON.stringify({ order, records }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const prospects: Prospect[] = Array.from({ length: 7 }, (_, i) => ({
    fullName: `Person ${i}`,
    companyName: `Co${i}`,
    companyDomain: `co${i}.com`,
  }));
  // chunkSize 1 → 7 chunks, run with concurrency; the first chunk 429s then retries OK.
  const out = await pipe0ResolveWorkEmails({ apiKey: "k", prospects, fetchImpl: fakeFetch, chunkSize: 1, concurrency: 4 });
  const withEmail = out.filter((p) => p.email);
  assert.equal(withEmail.length, 7, "every prospect resolves despite one transient failure");
  assert.ok(out.every((p) => p.email === `hit@${p.companyDomain}`));
});

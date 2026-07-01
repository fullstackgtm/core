import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileSource,
  serpapiNewsSource,
  hubspotFormsSource,
  getSignalSource,
  listSignalSources,
  type SignalSourceContext,
} from "../src/connectors/signalSources.ts";
import {
  stagedRowToSignal,
  signalsSpoolDir,
  SIGNAL_BUCKETS,
  type StagedSignalRow,
} from "../src/signals.ts";

const NOW = new Date("2026-06-23T12:00:00.000Z");

function baseCtx(over: Partial<SignalSourceContext> = {}): SignalSourceContext {
  return { watchlist: [], keywords: [], now: NOW, ...over };
}

// ---------------------------------------------------------------------------
// Registry

test("registry lists and resolves the three Phase-1 connectors", () => {
  const ids = listSignalSources().map((c) => c.id).sort();
  assert.deepEqual(ids, ["file", "hubspot-forms", "serpapi-news"]);
  assert.equal(getSignalSource("file")?.id, "file");
  assert.equal(getSignalSource("nope"), null);
});

test("every connector declares a valid bucket / shape / auth", () => {
  for (const c of listSignalSources()) {
    assert.ok(SIGNAL_BUCKETS.includes(c.bucket), `${c.id} bucket`);
    assert.ok(c.shape === "pull" || c.shape === "push", `${c.id} shape`);
    assert.ok(["none", "api_key", "oauth"].includes(c.auth), `${c.id} auth`);
  }
});

// ---------------------------------------------------------------------------
// stagedRowToSignal — the shared evidence gate

test("stagedRowToSignal stamps id/source and accepts domain alias", () => {
  const signal = stagedRowToSignal(
    { bucket: "funding", domain: "Acme.com", trigger: "raised Series B", quote: "Acme raised $40M" },
    { now: NOW, source: "serpapi-news", errorLabel: "row 0" },
  );
  assert.equal(signal.accountDomain, "acme.com");
  assert.equal(signal.source, "serpapi-news");
  assert.equal(signal.judgedBy, null);
  assert.ok(signal.id.startsWith("sig_"));
  assert.equal(signal.firstSeen, NOW.toISOString());
});

test("stagedRowToSignal rejects a missing quote (evidence gate)", () => {
  assert.throws(
    () => stagedRowToSignal({ bucket: "funding", domain: "a.com", trigger: "t" }, { now: NOW, source: "x", errorLabel: "row 2" }),
    /row 2 is missing the verbatim quote/,
  );
});

test("stagedRowToSignal rejects an unknown bucket and a missing domain", () => {
  assert.throws(
    () => stagedRowToSignal({ bucket: "nope", domain: "a.com", trigger: "t", quote: "q" }, { now: NOW, source: "x", errorLabel: "r" }),
    /unknown bucket "nope"/,
  );
  assert.throws(
    () => stagedRowToSignal({ bucket: "funding", trigger: "t", quote: "q" }, { now: NOW, source: "x", errorLabel: "r" }),
    /missing accountDomain/,
  );
});

// ---------------------------------------------------------------------------
// file source

test("file source reads a JSON array", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-file-"));
  try {
    const path = join(dir, "rows.json");
    const rows: StagedSignalRow[] = [
      { bucket: "company", accountDomain: "globex.com", trigger: "rebrand", quote: "Globex rebrands to Initech" },
    ];
    writeFileSync(path, JSON.stringify(rows));
    const out = await fileSource.fetch(baseCtx({ options: { path } }));
    assert.equal(out.length, 1);
    assert.equal(out[0].accountDomain, "globex.com");
    assert.equal(out[0].bucket, "company");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file source reads JSONL (the webhook spool format) and fills the default bucket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-file-"));
  try {
    const path = join(dir, "spool.jsonl");
    // Second row omits bucket -> connector default ("company"). Blank lines skipped.
    writeFileSync(
      path,
      `{"bucket":"funding","accountDomain":"a.com","trigger":"raised","quote":"A raised $10M"}\n\n{"accountDomain":"b.com","trigger":"news","quote":"B in the news"}\n`,
    );
    const out = await fileSource.fetch(baseCtx({ options: { path } }));
    assert.equal(out.length, 2);
    assert.equal(out[0].bucket, "funding");
    assert.equal(out[1].bucket, "company"); // default filled
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file source: no path -> [], missing file -> [], malformed -> throws", async () => {
  assert.deepEqual(await fileSource.fetch(baseCtx()), []);
  assert.deepEqual(await fileSource.fetch(baseCtx({ options: { path: "/no/such/file.json" } })), []);
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-file-"));
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    await assert.rejects(() => fileSource.fetch(baseCtx({ options: { path } })), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file source reads a spool DIRECTORY: all *.jsonl, name-sorted, non-spool files ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-spool-"));
  try {
    writeFileSync(join(dir, "rb2b.jsonl"), `{"bucket":"company","accountDomain":"globex.com","trigger":"visit","quote":"globex viewed /pricing"}\n`);
    writeFileSync(join(dir, "hubspot.jsonl"), `{"bucket":"demand","accountDomain":"initech.com","trigger":"form","quote":"Submitted Demo — vp@initech.com"}\n`);
    writeFileSync(join(dir, "README.txt"), "not a spool file"); // ignored
    const out = await fileSource.fetch(baseCtx({ options: { path: dir } }));
    assert.equal(out.length, 2);
    // name-sorted: hubspot.jsonl before rb2b.jsonl
    assert.equal(out[0].accountDomain, "initech.com");
    assert.equal(out[1].accountDomain, "globex.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file source: empty/missing spool directory -> [] (resilient), one bad file in dir throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-spool-"));
  try {
    assert.deepEqual(await fileSource.fetch(baseCtx({ options: { path: dir } })), []); // empty dir
    writeFileSync(join(dir, "bad.jsonl"), "{not json\n");
    await assert.rejects(() => fileSource.fetch(baseCtx({ options: { path: dir } })), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signalsSpoolDir is <signals>/spool under the profile home", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  try {
    assert.equal(signalsSpoolDir(dir), join(dir, "signals", "spool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// serpapi-news source

test("serpapi-news: no key -> inactive ([])", async () => {
  const out = await serpapiNewsSource.fetch(baseCtx({ watchlist: [{ domain: "acme.com" }], getApiKey: async () => null }));
  assert.deepEqual(out, []);
});

test("serpapi-news pulls a headline per account as verbatim evidence", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        news_results: [
          { title: "Acme raises $40M Series B", link: "https://news.example/acme", source: { name: "TechCrunch" } },
          { title: "", link: "https://news.example/blank" }, // no headline -> dropped
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const out = await serpapiNewsSource.fetch(
    baseCtx({ watchlist: [{ domain: "acme.com" }], fetchImpl, getApiKey: async (p) => (p === "serpapi" ? "key-123" : null) }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].bucket, "funding");
  assert.equal(out[0].quote, "Acme raises $40M Series B — TechCrunch");
  assert.equal(out[0].sourceUrl, "https://news.example/acme");
  assert.ok(calls[0].includes("api_key=key-123"));
  assert.ok(calls[0].includes(encodeURIComponent('"acme.com"')));
});

test("serpapi-news: a non-2xx for one account does not sink the run", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes("bad.com")) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ news_results: [{ title: "Good news", link: "u" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const out = await serpapiNewsSource.fetch(
    baseCtx({ watchlist: [{ domain: "bad.com" }, { domain: "good.com" }], fetchImpl, getApiKey: async () => "k" }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].accountDomain, "good.com");
});

test("serpapi-news: --connector-opt bucket override", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ news_results: [{ title: "T", link: "u" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const out = await serpapiNewsSource.fetch(
    baseCtx({ watchlist: [{ domain: "a.com" }], fetchImpl, getApiKey: async () => "k", options: { bucket: "company" } }),
  );
  assert.equal(out[0].bucket, "company");
});

// ---------------------------------------------------------------------------
// hubspot-forms source

test("hubspot-forms: no token -> inactive ([])", async () => {
  const out = await hubspotFormsSource.fetch(baseCtx({ getApiKey: async () => null }));
  assert.deepEqual(out, []);
});

test("hubspot-forms stages demand from corporate-domain submissions, drops free-mail", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const respond = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/marketing/v3/forms")) {
      return respond({ results: [{ guid: "form-1", name: "Demo Request" }] });
    }
    if (url.includes("/submissions/forms/form-1")) {
      return respond({
        results: [
          { values: [{ name: "email", value: "vp@globex.com" }], submittedAt: Date.parse("2026-06-20T00:00:00Z") },
          { values: [{ name: "email", value: "someone@gmail.com" }] }, // free-mail -> dropped
          { values: [{ name: "firstname", value: "NoEmail" }] }, // no email -> dropped
        ],
      });
    }
    return respond({});
  }) as typeof fetch;
  const out = await hubspotFormsSource.fetch(baseCtx({ fetchImpl, getApiKey: async (p) => (p === "hubspot" ? "tok" : null) }));
  assert.equal(out.length, 1);
  assert.equal(out[0].bucket, "demand");
  assert.equal(out[0].accountDomain, "globex.com");
  assert.equal(out[0].trigger, "form: Demo Request");
  assert.ok(out[0].quote.includes("vp@globex.com"));
  assert.equal(out[0].firstSeen, "2026-06-20T00:00:00.000Z");
});

test("hubspot-forms: forms endpoint non-2xx -> [] (resilient)", async () => {
  const fetchImpl = (async () => new Response("err", { status: 403 })) as typeof fetch;
  const out = await hubspotFormsSource.fetch(baseCtx({ fetchImpl, getApiKey: async () => "tok" }));
  assert.deepEqual(out, []);
});

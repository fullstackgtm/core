import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../src/cli.ts";

// Staged-file ingestion convergence: the Phase-2 spool container convention
// (JSONL, one object per line; or a directory of *.jsonl / *.json files) is
// readable by `signals fetch --from` and `enrich ingest` via the shared
// reader (src/spoolFiles.ts) — additively: existing JSON/CSV inputs parse
// exactly as before. (`market observe --from` is covered alongside its
// fixtures in fullstackgtmMarket.test.ts.)

async function cli(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = 0;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = origExit;
  return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-spool-ingest-"));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  return (async () => {
    try {
      return await fn(home);
    } finally {
      if (prevHome === undefined) delete process.env.FSGTM_HOME;
      else process.env.FSGTM_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  })();
}

const fundingRow = {
  accountDomain: "apexnorth.agency",
  bucket: "funding",
  trigger: "raised Series B",
  quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
  sourceUrl: "https://example.com/funding",
};
const jobRow = {
  accountDomain: "globex.com",
  bucket: "job",
  trigger: "hiring: Head of Growth",
  quote: "Head of Growth - own demand gen and marketing ops.",
  sourceUrl: "https://example.com/job",
};

test("signals fetch --from reads a .jsonl spool file identically to the JSON-array form", async () => {
  await withHome(async (home) => {
    const jsonl = join(home, "staged.jsonl");
    writeFileSync(jsonl, `${JSON.stringify(fundingRow)}\n\n${JSON.stringify(jobRow)}\n`);
    const json = join(home, "staged.json");
    writeFileSync(json, JSON.stringify([fundingRow, jobRow]));

    const viaJsonl = await cli(["signals", "fetch", "--bucket", "funding,job", "--from", jsonl]);
    assert.equal(viaJsonl.exitCode, 0, viaJsonl.stderr);
    const rowsJsonl = JSON.parse(viaJsonl.stdout) as Array<{ accountDomain: string; bucket: string }>;
    assert.equal(rowsJsonl.length, 2);

    const viaJson = await cli(["signals", "fetch", "--bucket", "funding,job", "--from", json]);
    const rowsJson = JSON.parse(viaJson.stdout) as Array<{ accountDomain: string; bucket: string }>;
    assert.deepEqual(
      rowsJsonl.map((r) => [r.accountDomain, r.bucket]),
      rowsJson.map((r) => [r.accountDomain, r.bucket]),
      "spool and JSON-array intake produce the same signals",
    );
  });
});

test("signals fetch --from reads a spool DIRECTORY (every *.jsonl / *.json, name-sorted)", async () => {
  await withHome(async (home) => {
    const spool = join(home, "landing-zone");
    mkdirSync(spool);
    writeFileSync(join(spool, "a-funding.jsonl"), `${JSON.stringify(fundingRow)}\n`);
    writeFileSync(join(spool, "b-jobs.json"), JSON.stringify([jobRow]));
    writeFileSync(join(spool, "notes.txt"), "not a spool file — ignored");

    const res = await cli(["signals", "fetch", "--bucket", "funding,job", "--from", spool]);
    assert.equal(res.exitCode, 0, res.stderr);
    const rows = JSON.parse(res.stdout) as Array<{ accountDomain: string }>;
    assert.equal(rows.length, 2, "both spool files land in one fetch");
  });
});

test("signals fetch --from surfaces a malformed spool line with file + line number", async () => {
  await withHome(async (home) => {
    const jsonl = join(home, "corrupt.jsonl");
    writeFileSync(jsonl, `${JSON.stringify(fundingRow)}\nnot json\n`);
    await assert.rejects(
      () => cli(["signals", "fetch", "--bucket", "funding", "--from", jsonl]),
      /--from .*corrupt\.jsonl: line 1 is not valid JSON/,
    );
  });
});

test("enrich ingest stages rows from a .jsonl spool file (CSV/JSON paths unchanged)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-spool-clay-"));
  try {
    const snap = join(dir, "snap.json");
    writeFileSync(
      snap,
      JSON.stringify({
        generatedAt: "2026-06-12T00:00:00.000Z",
        provider: "mock",
        users: [],
        accounts: [
          { id: "1001", name: "Acme Inc", domain: "acme.com" },
          { id: "1002", name: "Dup A", domain: "dup.com" },
          { id: "1003", name: "Dup B", domain: "dup.com" },
        ],
        contacts: [],
        deals: [],
        activities: [],
      }),
    );
    // Same rows the CSV one-shot test stages, as a JSONL spool file.
    const jsonl = join(dir, "clay.jsonl");
    writeFileSync(
      jsonl,
      [
        JSON.stringify({ "Company Name": "Acme", Domain: "https://www.acme.com/" }),
        JSON.stringify({ "Company Name": "Dup", Domain: "dup.com" }),
        JSON.stringify({ "Company Name": "NewCo", Domain: "newco.io" }),
      ].join("\n"),
    );
    const repoRoot = resolve(import.meta.dirname, "..");
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(repoRoot, "src/bin.ts"),
        "enrich", "ingest", jsonl,
        "--source", "clay",
        "--objects", "companies",
        "--input", snap,
        "--run-label", "spool-oneshot",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FSGTM_HOME: dir } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 matched/);
    assert.match(r.stdout, /1 ambiguous/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

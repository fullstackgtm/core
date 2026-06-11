import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  credentialsDir,
  credentialsPath,
  DEFAULT_PROFILE,
  getCredential,
  listProfiles,
  setActiveProfile,
  storeCredential,
} from "../src/index.ts";
import { validateProfileName } from "../src/credentials.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function withTempHome<T>(run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-profile-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    setActiveProfile(DEFAULT_PROFILE);
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args: string[], env: Record<string, string | undefined>) {
  const fullEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete fullEnv.HUBSPOT_ACCESS_TOKEN;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/bin.ts", ...args],
    { cwd: repoRoot, encoding: "utf8", env: fullEnv as NodeJS.ProcessEnv },
  );
}

test("profile names that could escape the home directory are rejected", () => {
  for (const name of ["", ".", "..", "../evil", "a/b", "a\\b", ".hidden", "-dash", "a".repeat(65)]) {
    assert.throws(() => validateProfileName(name), /Invalid profile name/, name);
  }
  for (const name of ["default", "acme", "Acme-Corp_2", "client.io"]) {
    assert.equal(validateProfileName(name), name);
  }
});

test("a named profile scopes the credential store; default layout is unchanged", () =>
  withTempHome(() => {
    const now = new Date().toISOString();
    const credential = {
      kind: "private_app" as const,
      accessToken: "default-token",
      createdAt: now,
      updatedAt: now,
    };
    storeCredential("hubspot", credential);
    assert.equal(credentialsPath(), join(process.env.FSGTM_HOME!, "credentials.json"));

    setActiveProfile("acme");
    assert.equal(
      credentialsDir(),
      join(process.env.FSGTM_HOME!, "profiles", "acme"),
    );
    assert.equal(getCredential("hubspot"), null, "profiles must not see default credentials");

    storeCredential("hubspot", { ...credential, accessToken: "acme-token" });
    assert.equal(getCredential("hubspot")?.accessToken, "acme-token");
    const mode = statSync(credentialsDir()).mode & 0o777;
    if (process.platform !== "win32") {
      assert.equal(mode, 0o700, "profile dir must be owner-only");
    }

    setActiveProfile(DEFAULT_PROFILE);
    assert.equal(getCredential("hubspot")?.accessToken, "default-token");
    assert.deepEqual(listProfiles(), ["acme", "default"]);
  }));

test("cli: --profile flag and FULLSTACKGTM_PROFILE select the store, flag wins", () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-profile-cli-"));
  try {
    const viaFlag = runCli(["--profile", "clienta", "doctor", "--json"], { FSGTM_HOME: home });
    assert.equal(viaFlag.status, 0, viaFlag.stderr);
    const flagReport = JSON.parse(viaFlag.stdout);
    assert.equal(flagReport.profile, "clienta");
    assert.ok(flagReport.credentialStore.path.includes(join("profiles", "clienta")));

    // The flag may also follow the command.
    const trailing = runCli(["doctor", "--profile", "clientb", "--json"], { FSGTM_HOME: home });
    assert.equal(JSON.parse(trailing.stdout).profile, "clientb");

    const viaEnv = runCli(["doctor", "--json"], {
      FSGTM_HOME: home,
      FULLSTACKGTM_PROFILE: "clientc",
    });
    assert.equal(JSON.parse(viaEnv.stdout).profile, "clientc");

    const flagOverEnv = runCli(["--profile", "clienta", "doctor", "--json"], {
      FSGTM_HOME: home,
      FULLSTACKGTM_PROFILE: "clientc",
    });
    assert.equal(JSON.parse(flagOverEnv.stdout).profile, "clienta");

    const invalid = runCli(["--profile", "../evil", "doctor"], { FSGTM_HOME: home });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid profile name/);
    assert.equal(existsSync(join(home, "evil")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli: stored plans are isolated per profile", () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-profile-plans-"));
  try {
    const save = runCli(
      ["--profile", "clienta", "audit", "--sample", "--today", "2026-05-03", "--json", "--save"],
      { FSGTM_HOME: home },
    );
    assert.equal(save.status, 0, save.stderr);
    const plan = JSON.parse(save.stdout);

    const samePlanList = runCli(["--profile", "clienta", "plans", "list", "--json"], {
      FSGTM_HOME: home,
    });
    assert.equal(JSON.parse(samePlanList.stdout).length, 1);

    // Another client's profile must not see — or be able to apply — the plan.
    const otherList = runCli(["--profile", "clientb", "plans", "list", "--json"], {
      FSGTM_HOME: home,
    });
    assert.equal(JSON.parse(otherList.stdout).length, 0);
    const otherApply = runCli(
      ["--profile", "clientb", "apply", "--plan-id", plan.id, "--provider", "hubspot"],
      { FSGTM_HOME: home },
    );
    assert.equal(otherApply.status, 1);
    assert.match(otherApply.stderr, /No stored plan/);

    // clientb only ran reads, so no profile directory was created for it.
    const profiles = runCli(["--profile", "clienta", "profiles", "--json"], { FSGTM_HOME: home });
    assert.deepEqual(JSON.parse(profiles.stdout), {
      active: "clienta",
      profiles: ["clienta", "default"],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

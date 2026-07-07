import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  credentialsPath,
  deleteCredential,
  getCredential,
  resolveHubspotAccessToken,
  runHubspotLoopbackLogin,
  storeCredential,
  validateHubspotToken,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function withTempHome<T>(run: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-auth-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  const restore = () => {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("credential store round-trips and is private to the user", () =>
  withTempHome(() => {
    const now = new Date().toISOString();
    storeCredential("hubspot", {
      kind: "private_app",
      accessToken: "pat-test",
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(getCredential("hubspot")?.accessToken, "pat-test");
    assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
    assert.equal(deleteCredential("hubspot"), true);
    assert.equal(getCredential("hubspot"), null);
    assert.equal(existsSync(credentialsPath()), false);
  }));

test("resolve returns stored private app tokens as-is", () =>
  withTempHome(async () => {
    const now = new Date().toISOString();
    storeCredential("hubspot", {
      kind: "private_app",
      accessToken: "pat-test",
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(await resolveHubspotAccessToken(), "pat-test");
  }));

test("resolve silently refreshes expired oauth tokens and persists the result", () =>
  withTempHome(async () => {
    const now = new Date().toISOString();
    storeCredential("hubspot", {
      kind: "oauth",
      accessToken: "stale-token",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1000,
      clientId: "client",
      clientSecret: "secret",
      createdAt: now,
      updatedAt: now,
    });

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body));
      return jsonResponse({
        access_token: "fresh-token",
        refresh_token: "refresh-2",
        expires_in: 1800,
      });
    }) as typeof fetch;

    assert.equal(await resolveHubspotAccessToken({ fetchImpl }), "fresh-token");
    assert.match(requests[0], /grant_type=refresh_token/);
    assert.match(requests[0], /refresh_token=refresh-1/);

    const stored = getCredential("hubspot");
    assert.equal(stored?.accessToken, "fresh-token");
    assert.equal(stored?.refreshToken, "refresh-2");

    // A fresh token resolves without another network call.
    const fetchBomb = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    assert.equal(await resolveHubspotAccessToken({ fetchImpl: fetchBomb }), "fresh-token");
  }));

test("loopback oauth captures the code locally and exchanges it directly", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /oauth\/v1\/token/);
    const body = String(init?.body);
    assert.match(body, /grant_type=authorization_code/);
    assert.match(body, /code=test-code/);
    assert.match(body, /redirect_uri=http%3A%2F%2Flocalhost%3A18763%2Fcallback/);
    return jsonResponse({
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      expires_in: 1800,
    });
  }) as typeof fetch;

  const tokens = await runHubspotLoopbackLogin({
    clientId: "client",
    clientSecret: "secret",
    port: 18763,
    fetchImpl,
    log: () => {},
    openUrl: async (authorizeUrl) => {
      const url = new URL(authorizeUrl);
      assert.equal(url.searchParams.get("client_id"), "client");
      const state = url.searchParams.get("state");
      // Simulate the provider redirecting the browser back to the CLI.
      await fetch(`http://127.0.0.1:18763/callback?code=test-code&state=${state}`);
    },
  });

  assert.equal(tokens.accessToken, "oauth-access");
  assert.equal(tokens.refreshToken, "oauth-refresh");
});

test("loopback oauth rejects forged states without exchanging anything", async () => {
  const fetchBomb = (async () => {
    throw new Error("exchange must not happen");
  }) as unknown as typeof fetch;

  await assert.rejects(
    runHubspotLoopbackLogin({
      clientId: "client",
      clientSecret: "secret",
      port: 18764,
      fetchImpl: fetchBomb,
      log: () => {},
      openUrl: async () => {
        await fetch(`http://127.0.0.1:18764/callback?code=evil&state=forged`);
      },
    }),
    /state mismatch/,
  );
});

test("validateHubspotToken accepts 200s and surfaces rejections", async () => {
  const ok = await validateHubspotToken(
    "good",
    (async () => jsonResponse({ results: [] })) as unknown as typeof fetch,
  );
  assert.equal(ok.ok, true);

  const bad = await validateHubspotToken(
    "bad",
    (async () => new Response("expired", { status: 401 })) as unknown as typeof fetch,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);
});

test("cli login/logout manage stored credentials without any web flow", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-cli-auth-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, FSGTM_HOME: dir };
    delete env.HUBSPOT_ACCESS_TOKEN;
    const run = (args: string[], input?: string) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8", env: env as NodeJS.ProcessEnv, input },
      );

    // The secret is piped on stdin — never passed as an argv flag.
    const login = run(["login", "hubspot", "--private-token", "--no-validate"], "pat-cli-test\n");
    assert.equal(login.status, 0, login.stderr);
    const stored = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    assert.equal(stored.providers.hubspot.accessToken, "pat-cli-test");

    // Passing the secret as a flag is rejected outright.
    const argvSecret = run(["login", "hubspot", "--private-token", "--token", "leaky", "--no-validate"], "");
    assert.equal(argvSecret.status, 1);
    assert.match(argvSecret.stderr, /no longer accepts a value on the command line/);

    // The stored login is picked up by provider commands (no env var set):
    // hubspot fetch fails fast against no network, but it must get past
    // credential resolution — i.e. not the "No HubSpot credentials" error.
    const audit = run(["audit", "--provider", "hubspot"]);
    assert.equal(audit.status, 1);
    assert.doesNotMatch(audit.stderr, /No HubSpot credentials/);

    const logout = run(["logout", "hubspot"]);
    assert.equal(logout.status, 0, logout.stderr);
    assert.equal(existsSync(join(dir, "credentials.json")), false);

    const auditAfter = run(["audit", "--provider", "hubspot"]);
    assert.equal(auditAfter.status, 1);
    assert.match(auditAfter.stderr, /No HubSpot credentials/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

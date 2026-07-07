import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import {
  getCredential,
  resolveHubspotConnection,
  storeCredential,
} from "../src/index.ts";

// The broker login flow opens the verification URL in the OS browser; without
// this, every test run pops a real browser tab pointed at the mock server.
process.env.FSGTM_NO_BROWSER = "1";

const CLI_TOKEN = "fsgtm_test_broker_token";
const FIELD_MAPPINGS = { deals: { nextStep: "custom_next_step" } };

/**
 * Stub of a hosted FullStackGTM deployment's CLI broker endpoints. The first
 * poll returns pending (the human is approving in the dashboard), the second
 * returns the minted CLI token.
 */
function startBrokerStub(): Promise<{ server: Server; url: string; state: { polls: number; tokenMints: number; starts: unknown[] } }> {
  const state = { polls: 0, tokenMints: 0, starts: [] as unknown[] };
  const server = createServer((request, response) => {
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const port = (server.address() as { port: number }).port;
      if (request.url === "/api/cli/auth/start" || request.url === "/api/cli/oauth/start") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        state.starts.push(body);
        respond(200, {
          deviceCode: "device-code-1",
          userCode: "ABCD-2345",
          verificationUrl:
            request.url === "/api/cli/oauth/start" && (body.provider === "hubspot" || body.provider === "salesforce")
              ? `http://127.0.0.1:${port}/oauth/${body.provider}?code=ABCD-2345`
              : `http://127.0.0.1:${port}/dashboard/cli-auth?code=ABCD-2345`,
          expiresInSeconds: 30,
          intervalSeconds: 0,
        });
        return;
      }
      if (request.url === "/api/cli/auth/poll") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (body.deviceCode !== "device-code-1") {
          respond(400, { error: "unknown device code" });
          return;
        }
        state.polls += 1;
        respond(200, state.polls < 2 ? { status: "pending" } : { status: "approved", cliToken: CLI_TOKEN });
        return;
      }
      if (request.url === "/api/cli/token") {
        if (request.headers.authorization !== `Bearer ${CLI_TOKEN}`) {
          respond(401, { error: "Invalid CLI token" });
          return;
        }
        state.tokenMints += 1;
        respond(200, { accessToken: "minted-hubspot-token", fieldMappings: FIELD_MAPPINGS });
        return;
      }
      respond(404, { error: "not found" });
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, state });
    });
  });
}

function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-broker-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  return run().finally(() => {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("login --via pairs with a deployment and stores the broker token", () =>
  withTempHome(async () => {
    const { server, url, state } = await startBrokerStub();
    try {
      await runCli(["login", "--via", url]);
      const stored = getCredential("broker");
      assert.equal(stored?.kind, "broker");
      assert.equal(stored?.accessToken, CLI_TOKEN);
      assert.equal(stored?.baseUrl, url);
      assert.equal(state.polls, 2);
    } finally {
      server.close();
    }
  }));

test("login hubspot --hosted stores a broker credential after hosted OAuth approval", () =>
  withTempHome(async () => {
    const { server, url, state } = await startBrokerStub();
    try {
      await runCli(["login", "hubspot", "--hosted", "--via", url]);
      const stored = getCredential("broker");
      assert.equal(stored?.kind, "broker");
      assert.equal(stored?.accessToken, CLI_TOKEN);
      assert.equal(stored?.baseUrl, url);
      assert.equal((state.starts.at(-1) as { provider?: string }).provider, "hubspot");
      assert.equal(typeof (state.starts.at(-1) as { requesterLabel?: string }).requesterLabel, "string");
      assert.equal(state.polls, 2);
    } finally {
      server.close();
    }
  }));

test("plain login salesforce defaults to hosted OAuth when no BYO flags are supplied", () =>
  withTempHome(async () => {
    const { server, url, state } = await startBrokerStub();
    try {
      await runCli(["login", "salesforce", "--via", url]);
      const stored = getCredential("broker");
      assert.equal(stored?.kind, "broker");
      assert.equal(stored?.accessToken, CLI_TOKEN);
      assert.equal((state.starts.at(-1) as { provider?: string }).provider, "salesforce");
    } finally {
      server.close();
    }
  }));

test("non-TTY missing BYO HubSpot app id prints deterministic hosted next command", () =>
  withTempHome(async () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    };
    try {
      await assert.rejects(runCli(["login", "hubspot", "--oauth"]), /--oauth requires --client-id/);
      assert.match(lines.join("\n"), /Next command: fullstackgtm login hubspot --hosted/);
    } finally {
      console.error = originalError;
    }
  }));

test("HubSpot BYO private-token path still rejects argv secrets", () =>
  withTempHome(async () => {
    await assert.rejects(
      runCli(["login", "hubspot", "--private-token", "--token"]),
      /--token no longer accepts a value on the command line/,
    );
  }));

test("broker pairing exchanges the CLI token for org sync credentials on use", () =>
  withTempHome(async () => {
    const { server, url, state } = await startBrokerStub();
    try {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: CLI_TOKEN,
        baseUrl: url,
        createdAt: now,
        updatedAt: now,
      });

      const connection = await resolveHubspotConnection();
      assert.equal(connection?.accessToken, "minted-hubspot-token");
      assert.deepEqual(connection?.fieldMappings, FIELD_MAPPINGS);
      assert.equal(state.tokenMints, 1);
    } finally {
      server.close();
    }
  }));

test("a revoked broker token fails with re-pairing instructions", () =>
  withTempHome(async () => {
    const { server, url } = await startBrokerStub();
    try {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: "fsgtm_revoked",
        baseUrl: url,
        createdAt: now,
        updatedAt: now,
      });
      await assert.rejects(resolveHubspotConnection(), /login --via/);
    } finally {
      server.close();
    }
  }));

test("a direct hubspot login takes precedence over the broker pairing", () =>
  withTempHome(async () => {
    const { server, url, state } = await startBrokerStub();
    try {
      const now = new Date().toISOString();
      storeCredential("broker", {
        kind: "broker",
        accessToken: CLI_TOKEN,
        baseUrl: url,
        createdAt: now,
        updatedAt: now,
      });
      storeCredential("hubspot", {
        kind: "private_app",
        accessToken: "pat-direct",
        createdAt: now,
        updatedAt: now,
      });

      const connection = await resolveHubspotConnection();
      assert.equal(connection?.accessToken, "pat-direct");
      assert.equal(state.tokenMints, 0);
    } finally {
      server.close();
    }
  }));

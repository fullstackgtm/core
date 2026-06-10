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

const CLI_TOKEN = "fsgtm_test_broker_token";
const FIELD_MAPPINGS = { deals: { nextStep: "custom_next_step" } };

/**
 * Stub of a hosted FullStackGTM deployment's CLI broker endpoints. The first
 * poll returns pending (the human is approving in the dashboard), the second
 * returns the minted CLI token.
 */
function startBrokerStub(): Promise<{ server: Server; url: string; state: { polls: number; tokenMints: number } }> {
  const state = { polls: 0, tokenMints: 0 };
  const server = createServer((request, response) => {
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const port = (server.address() as { port: number }).port;
      if (request.url === "/api/cli/auth/start") {
        respond(200, {
          deviceCode: "device-code-1",
          userCode: "ABCD-2345",
          verificationUrl: `http://127.0.0.1:${port}/dashboard/cli-auth?code=ABCD-2345`,
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

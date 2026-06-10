import assert from "node:assert/strict";
import test from "node:test";
import {
  pollSalesforceDeviceLogin,
  refreshSalesforceToken,
  startSalesforceDeviceLogin,
  validateSalesforceToken,
} from "../src/index.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("salesforce device flow starts, polls through pending, and returns tokens", async () => {
  let polls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    assert.match(String(input), /login\.salesforce\.com\/services\/oauth2\/token/);
    if (body.includes("response_type=device_code")) {
      return jsonResponse({
        device_code: "dev-1",
        user_code: "HXRT-4821",
        verification_uri: "https://login.salesforce.com/setup/connect",
        interval: 0.01,
      });
    }
    assert.match(body, /grant_type=device/);
    assert.match(body, /code=dev-1/);
    polls += 1;
    if (polls < 2) return jsonResponse({ error: "authorization_pending" }, 400);
    return jsonResponse({
      access_token: "sf-access",
      refresh_token: "sf-refresh",
      instance_url: "https://org.my.salesforce.com",
    });
  }) as typeof fetch;

  const authorization = await startSalesforceDeviceLogin({ clientId: "consumer-key", fetchImpl });
  assert.equal(authorization.userCode, "HXRT-4821");

  const tokens = await pollSalesforceDeviceLogin({
    clientId: "consumer-key",
    deviceCode: authorization.deviceCode,
    intervalSeconds: authorization.intervalSeconds,
    fetchImpl,
  });
  assert.equal(tokens.accessToken, "sf-access");
  assert.equal(tokens.refreshToken, "sf-refresh");
  assert.equal(tokens.instanceUrl, "https://org.my.salesforce.com");
  assert.equal(polls, 2);
});

test("salesforce device flow surfaces denials instead of looping", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ error: "access_denied", error_description: "User denied" }, 400)) as typeof fetch;

  await assert.rejects(
    pollSalesforceDeviceLogin({
      clientId: "consumer-key",
      deviceCode: "dev-1",
      intervalSeconds: 0.01,
      fetchImpl,
    }),
    /User denied/,
  );
});

test("salesforce refresh works without a client secret (device-flow public client)", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=sf-refresh/);
    assert.doesNotMatch(body, /client_secret/);
    return jsonResponse({
      access_token: "sf-access-2",
      instance_url: "https://org.my.salesforce.com",
    });
  }) as typeof fetch;

  const tokens = await refreshSalesforceToken({
    clientId: "consumer-key",
    refreshToken: "sf-refresh",
    fetchImpl,
  });
  assert.equal(tokens.accessToken, "sf-access-2");
  assert.equal(tokens.refreshToken, "sf-refresh");
});

test("validateSalesforceToken accepts 200s and surfaces rejections", async () => {
  const ok = await validateSalesforceToken(
    "good",
    "https://org.my.salesforce.com",
    (async () => jsonResponse({ user_id: "005A" })) as unknown as typeof fetch,
  );
  assert.equal(ok.ok, true);

  const bad = await validateSalesforceToken(
    "bad",
    "https://org.my.salesforce.com",
    (async () => new Response("Session expired", { status: 401 })) as unknown as typeof fetch,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);
});

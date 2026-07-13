import assert from "node:assert/strict";
import test from "node:test";
import {
  publicHttpGet,
  resolvePublicAddresses,
  type PublicLookup,
  type PublicRequestHop,
} from "../src/publicHttp.ts";

test("public HTTP rejects a hostname with mixed public and private DNS answers", async () => {
  const lookup: PublicLookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(resolvePublicAddresses("mixed.example", lookup), /private\/internal.*127\.0\.0\.1/);
});

test("public HTTP pins the validated DNS result into the socket request", async () => {
  let lookups = 0;
  const lookup: PublicLookup = async () => {
    lookups++;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const requestHop: PublicRequestHop = async (_url, addresses) => {
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    return { status: 200, headers: new Headers(), body: new Uint8Array() };
  };
  await publicHttpGet("https://rebind.example/", { lookup, requestHop });
  assert.equal(lookups, 1, "the transport must not perform an unvalidated second lookup");
});

test("public HTTP validates every redirect before issuing the next request", async () => {
  let requests = 0;
  const lookup: PublicLookup = async (host) => host === "public.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "169.254.169.254", family: 4 }];
  const requestHop: PublicRequestHop = async () => {
    requests++;
    return { status: 302, headers: new Headers({ location: "http://metadata.example/latest" }), body: new Uint8Array() };
  };
  await assert.rejects(publicHttpGet("https://public.example/", { lookup, requestHop }), /private\/internal/);
  assert.equal(requests, 1, "no request may be sent to an unsafe redirect destination");
});

test("public HTTP strips credentials on cross-origin redirects", async () => {
  const seen: Record<string, string>[] = [];
  const lookup: PublicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const requestHop: PublicRequestHop = async (url, _addresses, headers) => {
    seen.push(headers);
    if (url.hostname === "a.example") {
      return { status: 302, headers: new Headers({ location: "https://b.example/" }), body: new Uint8Array() };
    }
    return { status: 200, headers: new Headers(), body: new Uint8Array() };
  };
  await publicHttpGet("https://a.example/", {
    lookup, requestHop,
    headers: { Authorization: "Bearer secret", Cookie: "session=secret", "User-Agent": "test" },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { "User-Agent": "test" });
});

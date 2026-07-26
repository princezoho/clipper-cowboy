const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient, normalizePort } = require("../src/api.js");

test("uses loopback-only URL and optional local token header", async () => {
  const calls = [];
  const client = createClient({
    port: 47474,
    token: "local-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { items: [] };
        },
      };
    },
  });
  await client.listPackages();
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:47474/api/universal-clipper/packages?limit=50"
  );
  assert.equal(
    calls[0].init.headers["x-clipper-api-token"],
    "local-test-token"
  );
});

test("reports Clipper offline and rejects invalid ports", async () => {
  assert.throws(() => normalizePort(0), /between 1 and 65535/);
  const client = createClient({
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });
  await assert.rejects(client.listPackages(), /Clipper is offline/);
});

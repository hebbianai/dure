import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "storage-resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "3" };
const stored = JSON.parse('{"":"","한글 키":"값\\n🚀","__proto__":"literal","constructor":"data"}');

function storageFixture() {
  const calls = [];
  return { calls, run: (args) => collectBrowserCommand({ args, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "storage-proof" } }),
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller: null }, pages: [{ page }] } } };
      assert.equal(body.kind, "query");
      const query = body.query.query;
      return { result: { result: { page, data: Object.hasOwn(query, "key") ? { key: query.key, value: Object.hasOwn(stored, query.key) ? stored[query.key] : null } : { data: stored } } } };
    },
  }) };
}

test("direct and native storage reads with no key preserve every entry without acquiring control", async () => {
  for (const area of ["local", "session"]) for (const args of [
    ["storage", resource.resource_id, area], ["storage", resource.resource_id, area, "get"],
    ["--resource", resource.resource_id, "storage", area, "get"],
    ["exec", resource.resource_id, "--command", `storage ${area}`],
    ["exec", resource.resource_id, "--command", `storage ${area} get`],
  ]) {
    const { run, calls } = storageFixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify({ args, result }));
    assert.deepEqual(result.result.data, { data: stored });
    assert.deepEqual(calls, [{ kind: "observe", resource_id: resource.resource_id }, { kind: "query", page, query: { kind: "data", query: { kind: "storage", area } } }]);
  }
});

test("an explicit empty or named storage key remains a single-key read", async () => {
  for (const area of ["local", "session"]) for (const key of ["", "한글 키", "__proto__", "constructor", "absent"]) for (const args of [
    ["storage", resource.resource_id, area, "get", key],
    ["--resource", resource.resource_id, "storage", area, "get", "--key", key],
  ]) {
    const { run, calls } = storageFixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify({ args, result }));
    assert.deepEqual(result.result.data, { key, value: Object.hasOwn(stored, key) ? stored[key] : null });
    assert.deepEqual(calls.at(-1), { kind: "query", page, query: { kind: "data", query: { kind: "storage", area, key } } });
    assert.equal(calls.some((call) => call.kind === "action" || call.kind === "control"), false);
  }
});

test("optional storage read keys do not admit malformed writes or extra arguments", async () => {
  for (const args of [
    ["storage", resource.resource_id, "invalid"], ["storage", resource.resource_id, "local", "get", "key", "extra"],
    ["storage", resource.resource_id, "local", "set"], ["storage", resource.resource_id, "session", "set", "key"],
    ["--resource", resource.resource_id, "storage", "local", "get", "--value", "unexpected"],
    ["exec", resource.resource_id, "--command", "storage local get --backend peer"],
  ]) {
    let resolutions = 0;
    const result = await collectBrowserCommand({ args, sourceEnvironment: {}, resolveBackend: async () => { resolutions++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify({ args, result }));
    assert.equal(resolutions, 0);
  }
});

test("invalid cookie policy cannot contact a backend with an omitted SameSite value", async () => {
  for (const sameSite of ["constructor", "__proto__", "toString", ""]) {
    let resolved = 0;
    let dispatched = 0;
    const result = await collectBrowserCommand({
      args: ["cookie", "resource", "set", "sample", "value", "--same-site", sameSite],
      resolveBackend: async () => { resolved++; return { profile: { id: "browser-data-test" } }; },
      requestBackend: async () => { dispatched++; throw new Error("unexpected browser request"); },
    });
    assert.equal(resolved, 0, `invalid policy ${sameSite} resolved a backend`);
    assert.equal(dispatched, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser_cookie_invalid");
  }
});

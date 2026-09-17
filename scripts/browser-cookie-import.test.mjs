import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const resource = { resource_id: "cookies-resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "3" };
const lease = { resource, controller_id: "cookie-proof", epoch: "4" };
const authority = ["--page", page.page_id, "--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "cookie-operation"];

function fixture(contents, { loseResponse = false, controller = lease } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-cookie-import-")); roots.push(root);
  writeFileSync(join(root, "cookies.txt"), contents);
  const calls = []; const resolutions = [];
  return { root, calls, resolutions, run: (args, flags = authority) => collectBrowserCommand({ args: [...args, ...flags], cwd: root, sourceEnvironment: {},
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "cookie-backend" } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller, next_command_sequence: "7" }, pages: [{ page }] } } };
      assert.equal(body.kind, "action");
      if (loseResponse) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { [body.action.action.kind === "cookies_clear" ? "cleared" : "set"]: true } } } } };
    },
  }) };
}

const inputs = [
  ['[{"name":"one","value":"a=b","domain":"ignored.test"},{"name":"empty","value":""}]', [{ name: "one", value: "a=b" }, { name: "empty", value: "" }]],
  ["one=a=b; empty=; ignored", [{ name: "one", value: "a=b" }, { name: "empty", value: "" }]],
  ["curl https://example.test \\\n  -H 'COOKIE: one=a=b; empty=' -H 'Authorization: irrelevant'", [{ name: "one", value: "a=b" }, { name: "empty", value: "" }]],
  ['curl https://example.test ^\r\n -b "one=a=b; empty="', [{ name: "one", value: "a=b" }, { name: "empty", value: "" }]],
  ["curl https://example.test --cookie 'one=a=b; empty='", [{ name: "one", value: "a=b" }, { name: "empty", value: "" }]],
  ['[{"name":"literal","value":"$(not-a-shell) $HOME"}]', [{ name: "literal", value: "$(not-a-shell) $HOME" }]],
  ["[]", []],
];

test.each(inputs)("direct and exec import local cookie file %s through one admitted batch", async (contents, expected) => {
  for (const args of [
    ["cookie", resource.resource_id, "set", "--curl", "cookies.txt"],
    ["cookie", "set", "--resource", resource.resource_id, "--curl", "cookies.txt"],
    ["exec", resource.resource_id, "--command", "cookies set --curl cookies.txt"],
  ]) {
    const f = fixture(contents); const result = await f.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls.map((body) => body.kind), ["observe", "action"]);
    assert.deepEqual(f.calls[1].action, { kind: "data", action: { kind: "cookies_set", cookies: expected } });
    assert.deepEqual(f.calls[1].authority, { lease, page, operation_id: "cookie-operation", command_sequence: "7" });
    assert.equal(JSON.stringify(f.calls).includes("cookies.txt"), false);
  }
});

test("import URL and domain come from explicit flags, without forwarding a cURL command", async () => {
  const contents = "curl https://unrequested.test -b 'one=value'";
  const expected = [{ name: "one", value: "value", domain: ".example.test", path: "/", url: "https://example.test/path" }];
  for (const args of [
    ["cookie", resource.resource_id, "set", "--curl", "cookies.txt", "--domain", ".example.test", "--url", "https://example.test/path"],
    ["exec", resource.resource_id, "--command", "cookies set --curl cookies.txt --domain .example.test --url https://example.test/path"],
    ["exec", resource.resource_id, "--command", "cookies set --domain .example.test --curl cookies.txt --url https://example.test/path"],
    ["exec", resource.resource_id, "--command", "cookies set --url https://example.test/path --domain .example.test --curl cookies.txt"],
  ]) {
    const f = fixture(contents); const result = await f.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls[1].action.action.cookies, expected);
    assert.equal(JSON.stringify(f.calls).includes("unrequested.test"), false);
  }
});

test("cookie file import bounds both the entry count and the batch after explicit scope is added", async () => {
  const cookies = Array.from({ length: 256 }, (_, index) => ({ name: `n${index}`, value: "value" }));
  const allowed = fixture(JSON.stringify(cookies));
  assert.equal((await allowed.run(["cookie", resource.resource_id, "set", "--curl=cookies.txt"])).ok, true);
  assert.equal(allowed.calls[1].action.action.cookies.length, 256);
  for (const [values, flags] of [[cookies.concat({ name: "extra", value: "value" }), []], [cookies, ["--domain", "a".repeat(240) + ".test"]]]) {
    const f = fixture(JSON.stringify(values));
    const rejected = await f.run(["cookie", resource.resource_id, "set", "--curl", "cookies.txt", ...flags]);
    assert.equal(rejected.ok, false); assert.deepEqual(f.resolutions, []); assert.deepEqual(f.calls, []);
  }
});

test("cookie clear uses one existing profile action in direct, prefix and exec forms", async () => {
  for (const args of [["cookie", resource.resource_id, "clear"], ["cookie", "clear", "--resource", resource.resource_id], ["exec", resource.resource_id, "--command", "cookies clear"]]) {
    const f = fixture(""); const result = await f.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls[1].action, { kind: "data", action: { kind: "cookies_clear" } });
  }
});

test.each(["clear", "set --curl cookies.txt"])("cookies %s refuses changed control and preserves lost-response identity without replay", async (command) => {
  const stale = fixture("one=value", { controller: { ...lease, epoch: "5" } });
  const denied = await stale.run(["exec", resource.resource_id, "--command", `cookies ${command}`]);
  assert.equal(denied.ok, false); assert.equal(stale.calls.some((body) => body.kind === "action"), false);
  const lost = fixture("one=value", { loseResponse: true });
  const result = await lost.run(["exec", resource.resource_id, "--command", `cookies ${command}`]);
  assert.equal(result.ok, false); assert.equal(result.operation_id, "cookie-operation");
  assert.equal(result.error.code, "browser_response_lost"); assert.equal(lost.calls.filter((body) => body.kind === "action").length, 1);
});

test("bad files, malformed imports and ambiguous options fail before any backend contact without echoing cookie text", async () => {
  for (const contents of ["", " ", "no cookies", "curl https://example.test", "[invalid secret-value", '[{"name":"one","value":42}]', '[{"value":"secret-value"}]', Buffer.from([0xff]), "a=" + "x".repeat(65536)]) {
    const f = fixture(contents); const result = await f.run(["cookie", resource.resource_id, "set", "--curl", "cookies.txt"]);
    assert.equal(result.ok, false); assert.deepEqual(f.resolutions, []); assert.deepEqual(f.calls, []);
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  }
  for (const args of [
    ["cookie", resource.resource_id, "set", "--curl", "missing"], ["cookie", resource.resource_id, "set", "--curl", "."],
    ["cookie", resource.resource_id, "set", "name", "value", "--curl", "cookies.txt"],
    ["cookie", "set", "--resource", resource.resource_id, "--name", "name", "--value", "value", "--curl", "cookies.txt"],
    ["cookie", resource.resource_id, "get", "--curl", "cookies.txt"], ["cookie", resource.resource_id, "clear", "--url", "https://example.test"],
    ["cookie", resource.resource_id, "clear", "extra"], ["cookie", resource.resource_id, "set", "--curl", "cookies.txt", "--path", "/"],
    ["storage", resource.resource_id, "local", "get", "--curl", "cookies.txt"],
    ["exec", resource.resource_id, "--command", "cookies set --curl cookies.txt --backend other"],
  ]) {
    const f = fixture("one=value"); const result = await f.run(args);
    assert.equal(result.ok, false, JSON.stringify({ args, result })); assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
  }
});

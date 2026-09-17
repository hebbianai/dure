import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:snapshot", workspace_id: "workspace:one", generation: "generation:one" };
const page = { resource, page_id: "page:one", document_revision: "3" };
const snapshot = { page, revision: "5" };
function fixture() {
  const calls = [];
  const resolutions = [];
  return { calls, resolutions, run: (args) => collectBrowserCommand({
    args: ["--resource", resource.resource_id, "--idempotency-key", "snapshot-once", ...args], sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "chosen", transport: { kind: "local" } } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      const result = body.kind === "observe" ? { control: { resource, current_page: page }, pages: [{ page }] }
        : { snapshot, data: { snapshot: '- button "한글" [ref=e7]', refs: { e7: { role: "button", name: "한글" } } } };
      return { result: { operation_id: "snapshot-once", result } };
    },
  }) };
}

test.each([
  ["snapshot -i", ["--interactive"], { interactive: true }],
  ["snapshot -i -C", ["--interactive", "--cursor"], { interactive: true }],
  ["snapshot --cursor -c -s main", ["--compact", "--selector", "main", "--cursor"], { compact: true, selector: "main" }],
  ["snapshot --compact", ["--compact"], { compact: true }],
  ["snapshot -d 0", ["--depth", "0"], { depth: 0 }],
  ["snapshot -s '#한글'", ["--selector", "#한글"], { selector: "#한글" }],
  ["snapshot -u", ["--urls"], { urls: true }],
  ["snapshot -i -c -d +0002 -s main -u", ["--interactive", "--compact", "--depth", "2", "--selector", "main", "--urls"], { interactive: true, compact: true, depth: 2, selector: "main", urls: true }],
  ["snapshot --interactive --compact --depth 4 --selector main --urls", ["--interactive", "--compact", "--depth", "4", "--selector", "main", "--urls"], { interactive: true, compact: true, depth: 4, selector: "main", urls: true }],
  ["snapshot -d -1 -i -d 2147483648", ["--interactive"], { interactive: true }],
  ["snapshot -s first -s second -d 3 -d 0 -i -i", ["--selector", "second", "--depth", "0", "--interactive"], { selector: "second", depth: 0, interactive: true }],
  ["snapshot --backend peer --page other -u", ["--urls"], { urls: true }],
  ["snapshot -d invalid -i", ["--interactive"], { interactive: true }],
])("%s observes the exact page with normalized options and encoded refs", async (command, direct, options) => {
  const native = fixture(); const actual = await native.run(["exec", "--command", command]);
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.deepEqual(native.calls, [{ kind: "observe", resource_id: resource.resource_id }, { kind: "snapshot", page, options }]);
  assert.equal(Object.keys(actual.references).length, 1);
  assert.ok(Object.keys(actual.references)[0].startsWith("@br1."));
  const canonical = fixture(); const expected = await canonical.run(["snapshot", ...direct]);
  assert.equal(expected.ok, true, JSON.stringify(expected));
  assert.deepEqual(expected, actual); assert.deepEqual(canonical.calls, native.calls);
});

test("default snapshot preserves the existing request and reference envelope", async () => {
  const f = fixture(); const result = await f.run(["snapshot"]);
  assert.equal(result.ok, true); assert.deepEqual(f.calls.at(-1), { kind: "snapshot", page });
  assert.equal(Object.values(result.references)[0].name, "한글");
});

test.each([
  ["snapshot", "--depth", "-1"], ["snapshot", "--depth", "1.5"], ["snapshot", "--depth", "4294967296"],
  ["snapshot", "--depth", ""], ["snapshot", "--selector", ""], ["snapshot", "--selector", "x\0y"],
  ["show", "--interactive"], ["show", "--compact"], ["show", "--urls"], ["show", "--depth", "1"],
  ["snapshot", "--interactive", "--interactive"], ["snapshot", "--cursor", "--cursor"],
])("invalid or not yet supported snapshot input %j fails before backend selection", async (...args) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, false); assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
});

test.each(["2147483647", "2147483648", "4294967295", "+4294967295"])("direct snapshot depth %s uses the neutral u32 range", async depth => {
  const f = fixture(); const result = await f.run(["snapshot", "--depth", depth]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.at(-1), { kind: "snapshot", page, options: { depth: Number(depth) } });
});

test.each(["2147483648", "4294967295", "4294967296", "-1"])("ordinary native snapshot retains its i32 grammar for %s", async depth => {
  const f = fixture(); const result = await f.run(["exec", "--command", `snapshot -d ${depth}`]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.at(-1), { kind: "snapshot", page });
});

test.each([["snapshot", "--cursor"], ["exec", "--command", "snapshot -C"], ["exec", "--command", "snapshot --cursor"]])("cursor spelling %j retains the default snapshot request", async (...args) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.at(-1), { kind: "snapshot", page });
  assert.equal(Object.values(result.references)[0].name, "한글");
});

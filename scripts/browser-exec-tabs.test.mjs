import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:exec-tabs", generation: "generation:one", workspace_id: "workspace:one" };
const first = { resource, page_id: "page:first", document_revision: "2" };
const second = { resource, page_id: "page:second", document_revision: "4" };
const lease = { resource, controller_id: "agent:one", epoch: "8" };
const control = { resource, current_page: first, controller: lease, next_command_sequence: "12" };
const authority = ["--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "exec-tabs-once"];
function fixture(fault) {
  const calls = []; const resolutions = [];
  return { calls, resolutions, run: (args) => collectBrowserCommand({ args: ["--resource", resource.resource_id, ...authority, ...args], sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "chosen", transport: { kind: "local" } } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control: fault === "lease" ? { ...control, controller: { ...lease, epoch: "9" } } : control, pages: [first, second].map((page) => ({ page })) } } };
      assert.equal(body.kind, "action");
      if (fault === "response") throw new Error("browser_response_lost");
      return { result: { operation_id: body.authority.operation_id, result: { response: { success: true, data: { result: "fixture result" } } } } };
    },
  }) };
}

const cases = [
  ["close", ["disconnect"], first],
  ["tab page:first", ["tab", "switch", "--page", first.page_id], first],
  ["tab page:second", ["tab", "switch", "--page", second.page_id], second],
  ["tab close", ["tab", "close"], first],
  ["tab close page:first", ["tab", "close", "--page", first.page_id], first],
  ["tab close page:second", ["tab", "close", "--page", second.page_id], second],
  ["clipboard", ["clipboard", "read"], first],
  ["clipboard read", ["clipboard", "read"], first],
  ["clipboard copy", ["clipboard", "copy"], first],
  ["clipboard paste", ["clipboard", "paste"], first],
  ["clipboard write 한글 입력", ["clipboard", "--", "write", "한글 입력"], first],
  ["clipboard write '--backend peer --page other'", ["clipboard", "--", "write", "--backend peer --page other"], first],
];

test.each(cases)("exec %s retains the exact selected page, lease and operation", async (command, canonical, page) => {
  const direct = fixture(); const expected = await direct.run(canonical);
  assert.equal(expected.ok, true, JSON.stringify({ canonical, expected }));
  const native = fixture(); const actual = await native.run(["exec", "--command", command]);
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.deepEqual(actual, expected); assert.deepEqual(native.calls, direct.calls);
  const actions = native.calls.filter((body) => body.kind === "action");
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].authority, { lease, page, command_sequence: "12", operation_id: "exec-tabs-once" });
});

test.each(["tab page:second", "tab close page:second"])("exec %s cannot replace a conflicting outer page", async (command) => {
  const f = fixture(); const result = await f.run(["exec", "--command", command, "--page", first.page_id]);
  assert.equal(result.ok, false); assert.equal(result.error.code, "browser_tab_target_mismatch");
  assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
});

test.each(["close", "tab page:second", "tab close page:second", "clipboard read", "clipboard write 한글", "clipboard copy", "clipboard paste"])("exec %s refuses stale control and retains a lost-response receipt without retry", async (command) => {
  const stale = fixture("lease"); const refused = await stale.run(["exec", "--command", command]);
  assert.equal(refused.ok, false); assert.equal(stale.calls.some((body) => body.kind === "action"), false);
  const lost = fixture("response"); const failed = await lost.run(["exec", "--command", command]);
  assert.equal(failed.ok, false); assert.equal(failed.operation_id, "exec-tabs-once");
  assert.equal(lost.calls.filter((body) => body.kind === "action").length, 1);
});

test("exec tab and clipboard reject malformed or unsupported scope before contact", async () => {
  for (const command of ["tab 0", "tab 1", "tab close 0", "tab -1", "tab 128", "tab 00", "tab 1 extra", "tab close 1 extra", "tab close --page other", "tab 1 --backend peer", "clipboard read extra", "clipboard write", "clipboard copy extra", "clipboard paste --backend peer"]) {
    const f = fixture(); const result = await f.run(["exec", "--command", command]);
    assert.equal(result.ok, false, command); assert.deepEqual(f.calls, [], command); assert.deepEqual(f.resolutions, [], command);
  }
});

test("exec cannot select a page absent from the chosen resource", async () => {
  for (const command of ["tab page:peer", "tab close page:peer"]) {
    const f = fixture(); const result = await f.run(["exec", "--command", command]);
    assert.equal(result.ok, false); assert.equal(result.error.code, "browser_page_required");
    assert.deepEqual(f.calls.map((body) => body.kind), ["observe"]);
  }
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { encodeRef } from "../cli/lib/browser-reference.mjs";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "r:exec", generation: "g", workspace_id: "w:exec" };
const page = { resource, page_id: "p:current", document_revision: "7" };
const controller = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller, current_page: page, next_command_sequence: "12" };
const authority = ["--controller", "agent", "--epoch", "8", "--idempotency-key", "exec:once"];
function fixture({ changedResource = resource, missingController = false } = {}) {
  const calls = []; const resolutions = [];
  const run = (args) => collectBrowserCommand({ args, cwd: "/workspace/한글", sourceEnvironment: {},
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "chosen", transport: { kind: "local" } } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      let result = { response: { success: true, data: { value: "result" } } };
      const state = { ...control, resource: changedResource, controller: missingController ? null : controller };
      if (body.kind === "list") result = { workspace_id: resource.workspace_id, resources: [{ resource }], target: { workspace_id: resource.workspace_id, generation: "g", revision: "1", current_resource: resource } };
      if (body.kind === "observe") result = { control: state, pages: [{ page, title: "Current", url: "about:blank", profile_id: "default" }] };
      if (body.kind === "control_state") result = state;
      return { result: { result } };
    },
  });
  return { run, calls, resolutions };
}

const cases = [
  ['find role button click --name "--json"', ["find", "role", "button", "click", "--name=--json"]],
  ['find role button click --name "--page"', ["find", "role", "button", "click", "--name=--page"]],
  ["window new", ["window-new"]],
  ["window new ignored --backend peer", ["window-new"]],
  ["tap button", ["tap", "button"]],
  ["tap button ignored --backend peer", ["tap", "button"]],
  ...["up", "down", "left", "right"].map(direction => [`swipe ${direction}`, ["swipe", direction, "300"]]),
  ["swipe left 0", ["swipe", "left", "0"]],
  ["swipe down 75 ignored --backend peer", ["swipe", "down", "75"]],
  ["swipe right invalid", ["swipe", "right", "300"]],
  ['fill "input[name=title]" "한글 입력"', ["fill", "input[name=title]", "한글 입력"]],
  ["fill input", ["fill", "input", ""]],
  ['fill input "$(touch /tmp/not-a-shell) `date` $HOME"', ["fill", "input", "$(touch /tmp/not-a-shell) `date` $HOME"]],
  ["fill input 'say \"hello\"'", ["fill", "input", 'say "hello"']],
  ['fill input "--backend"', ["fill", "--", "input", "--backend"]],
  ['type input "추가 입력"', ["find", "first", "input", "type", "추가 입력"]],
  ['keyboard inserttext "한글 조합"', ["inserttext", "한글 조합"]],
  ['keyboard type "한글🦉\t다음\n"', ["keyboard", "type", "한글🦉\t다음\n"]],
  ['keyboard type "--backend peer"', ["keyboard", "--", "type", "--backend peer"]],
  ['keyboard type "$(touch /tmp/not-a-shell) `date` $HOME"', ["keyboard", "type", "$(touch /tmp/not-a-shell) `date` $HOME"]],
  ["press Control+A", ["key", "Control+A"]],
  ["keydown Shift", ["keydown", "Shift"]], ["keyup Shift", ["keyup", "Shift"]],
  ["mouse move 12 34", ["mouse", "move", "12", "34"]],
  ["mouse down right", ["mouse", "down", "right"]], ["mouse up right", ["mouse", "up", "right"]],
  ["mouse wheel 30 -2", ["mouse", "wheel", "30", "-2"]],
  ["get title", ["get", "title"]], ["get attr input name", ["get", "attr", "input", "name"]],
  ["is visible input", ["is", "visible", "input"]],
  ["eval 'document.title + \"한글\"'", ["eval", 'document.title + "한글"']],
  ["open https://example.com", ["goto", "https://example.com"]],
  ["navigate https://example.com", ["goto", "https://example.com"]],
  ['addinitscript "window.beforePage = true"', ["init-script", "add", "window.beforePage = true"]],
  ['addinitscript "$(touch /tmp/not-a-shell) `date` $HOME"', ["init-script", "add", "$(touch /tmp/not-a-shell) `date` $HOME"]],
  ["removeinitscript init:v1:eyJmaXh0dXJlIjp0cnVlfQ", ["init-script", "remove", "init:v1:eyJmaXh0dXJlIjp0cnVlfQ"]],
  ["removeinitscript init:v1:eyJmaXh0dXJlIjp0cnVlfQ ignored --backend peer", ["init-script", "remove", "init:v1:eyJmaXh0dXJlIjp0cnVlfQ"]],
  ["pushstate /first /ignored --backend peer", ["pushstate", "/first"]],
  ["pushstate /next?lang=ko#section", ["pushstate", "/next?lang=ko#section"]],
  ["pushstate '../한글 route'", ["pushstate", "../한글 route"]],
  ["pushstate '--backend'", ["pushstate", "--", "--backend"]],
  ["back", ["back"]], ["forward", ["forward"]], ["reload", ["reload"]],
  ...["close", "quit", "exit", "close ignored --backend peer"].map(command => [command, ["disconnect"]]),
  ...["click", "dblclick", "check", "uncheck", "focus", "hover", "highlight", "scrollintoview"].map((name) => [`${name} input`, [name, "input"]]),
  ["select select value", ["select", "select", "value"]],
  ["drag '#one' '#two'", ["drag", "#one", "#two"]],
  ["scroll down 125", ["scroll", "down", "125"]],
  ["wait 0", ["wait", "duration", "0"]],
  ["wait input", ["wait", "selector", "input"]],
  ["wait --text 'Ready' --timeout 20", ["wait", "text", "Ready", "--timeout", "20"]],
  ["set viewport 800 600", ["set", "viewport", "800", "600"]],
  ["set offline off", ["set", "offline", "off"]],
  ["set headers '{\"x-test\":\"한글\"}'", ["set", "headers", '{"x-test":"한글"}']],
  ["storage local set key '저장 값'", ["storage", "local", "set", "key", "저장 값"]],
  ["find role button click --name Save --exact", ["find", "role", "button", "click", "--name", "Save", "--exact"]],
  ["tab", ["tab", "list"]], ["tab list", ["tab", "list"]],
  ["tab new about:blank", ["tab", "create", "about:blank"]],
];

test.each(cases)("exec %s uses the same typed operation and authority", async (command, canonical) => {
  const direct = fixture(); const expected = await direct.run(["--resource", resource.resource_id, ...authority, ...canonical]);
  assert.equal(expected.ok, true, JSON.stringify({ canonical, expected }));
  for (const selector of [[resource.resource_id], ["--resource", resource.resource_id], ["--worktree", "id:w:exec"], []]) {
    const f = fixture(); const result = await f.run(["exec", ...selector, "--command", command, ...authority]);
    assert.equal(result.ok, true, JSON.stringify({ command, selector, result }));
    assert.deepEqual(result, expected);
    assert.deepEqual(f.calls.filter((row) => row.kind !== "list"), direct.calls);
  }
});

test("native session/CDP flags cannot replace the outer selected target", async () => {
  const f = fixture(); const result = await f.run(["exec", resource.resource_id, "--page", page.page_id, "--backend", "chosen", "--command", "--session peer fill input 한글 --cdp=ws://peer --session=peer2 --cdp ws://peer2", ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.resolutions, [{ backend: "chosen", backendSpecified: true }]);
  const action = f.calls.find((row) => row.kind === "action");
  assert.deepEqual(action.authority.page, page);
  assert.equal(action.action.text, "한글");
  const consecutive = fixture();
  assert.equal((await consecutive.run(["exec", resource.resource_id, "--command", "--session --cdp fill input 한글", ...authority])).ok, true);
  assert.equal(consecutive.calls.find((row) => row.kind === "action").action.text, "한글");
});

test("exec rejects routing/control injection, unsupported engine paths and ambiguous outer syntax before contact", async () => {
  for (const command of ["get title --backend peer", "get title --page peer", "get title --controller peer", "get title --epoch 9", "get title --idempotency-key other", "get title --worktree all", "get title --resource peer", "exec --command reload", "connect ws://peer", "record start", "frame main extra", "type input text --delay 3", "", " ", "a\0b"]) {
    const f = fixture(); const result = await f.run(["exec", resource.resource_id, "--command", command, ...authority]);
    assert.equal(result.ok, false, JSON.stringify({ command, result }));
    assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
  }
  for (const args of [["exec", resource.resource_id], ["exec", resource.resource_id, "extra", "--command", "reload"], ["exec", resource.resource_id, "--resource", resource.resource_id, "--command", "reload"], ["reload", resource.resource_id, "--command", "reload"]]) {
    const f = fixture(); assert.equal((await f.run([...args, ...authority])).ok, false); assert.deepEqual(f.calls, []);
  }
});

test.each(["window new", "tap button", "swipe left 50", "close", "quit", "exit", 'addinitscript "window.ready = true"', "removeinitscript init:v1:eyJmaXh0dXJlIjp0cnVlfQ", "pushstate /next", "click input", 'keyboard type "한글\t다음"', 'type input "한글\t다음"'])("exec %s preserves workspace generation validation and never invents input authority", async (command) => {
  const f = fixture({ changedResource: { ...resource, generation: "replaced" } });
  const changed = await f.run(["exec", "--workspace", resource.workspace_id, "--command", command, ...authority]);
  assert.equal(changed.error?.code, "browser_resource_mismatch");
  assert.equal(f.calls.some((row) => row.kind === "action"), false);
  const noLease = fixture({ missingController: true });
  const denied = await noLease.run(["exec", resource.resource_id, "--command", command]);
  assert.equal(denied.ok, false); assert.equal(noLease.calls.some((row) => row.kind === "action" || row.kind === "control"), false);
});

test("window creation keeps resource/workspace selection and admits only an isolated blank page", async () => {
  for (const args of [
    ["window", "new", resource.resource_id, ...authority],
    ["window", "new", "--resource", resource.resource_id, ...authority],
    ["window", "new", "--workspace", resource.workspace_id, ...authority],
  ]) {
    const f = fixture();
    const result = await f.run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls.at(-1).action, { kind: "new_window" });
    assert.deepEqual(f.calls.at(-1).authority.page, page);
  }
  for (const args of [
    ["window"], ["window", "close", resource.resource_id],
    ["window", "new", resource.resource_id, "https://peer.invalid"],
    ["window", "new", resource.resource_id, "--profile", "peer"],
  ]) {
    const f = fixture();
    const result = await f.run([...args, ...authority]);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.resolutions, []);
  }
});

test("init-script validates the action, source byte limit and opaque identifier before contact", async () => {
  for (const args of [["init-script"], ["init-script", "add"], ["init-script", "add", "a", "extra"], ["init-script", "add", "한".repeat(21846)], ["init-script", "unknown", "a"], ["init-script", "remove", ""], ["init-script", "remove", "1"], ["init-script", "remove", "init:v2:abc"], ["init-script", "remove", `init:v1:${"a".repeat(4096)}`], ["exec", "--command", "addinitscript"], ["exec", "--command", 'addinitscript ""'], ["exec", "--command", "removeinitscript"]]) {
    const f = fixture();
    const result = await f.run(["--resource", resource.resource_id, ...authority, ...args]);
    assert.equal(result.ok, false, JSON.stringify({ args, result }));
    assert.deepEqual(f.calls, []);
  }
  for (const script of ["", "a".repeat(64 * 1024)]) {
    const f = fixture();
    assert.equal((await f.run(["init-script", "--resource", resource.resource_id, "add", script, ...authority])).ok, true);
    assert.deepEqual(f.calls.find((row) => row.kind === "action").action, { kind: "init_script", action: { kind: "add", script } });
  }
});

test("keyboard rejects absent, empty or extra operands before backend contact", async () => {
  for (const args of [["keyboard"], ["keyboard", "type"], ["keyboard", "type", ""], ["keyboard", "type", "text", "extra"], ["keyboard", "unknown", "text"]]) {
    const f = fixture();
    const result = await f.run(["--resource", resource.resource_id, ...authority, ...args]);
    assert.equal(result.ok, false, JSON.stringify({ args, result }));
    assert.deepEqual(f.calls, []);
  }
});

test("pushstate URL options retain canonical action authority and bounded relative input", async () => {
  const f = fixture();
  const result = await f.run(["pushstate", "--resource", resource.resource_id, "--url", "../한글", ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const action = f.calls.find((row) => row.kind === "action");
  assert.deepEqual(action.action, { kind: "push_state", url: "../한글" });
  assert.deepEqual(action.authority, { lease: controller, page, command_sequence: "12", operation_id: "exec:once" });
  for (const args of [["pushstate"], ["pushstate", "/one", "/two"], ["pushstate", "한".repeat(2731)], ["exec", "--command", "pushstate"]]) {
    const invalid = fixture();
    assert.equal((await invalid.run(["--resource", resource.resource_id, ...authority, ...args])).ok, false);
    assert.deepEqual(invalid.calls, []);
  }
});


test("touch gestures carry explicit page and reference authority through native spelling", async () => {
  const reference = { snapshot: { page, revision: "17" }, element: "e1" };
  const encoded = encodeRef(reference.snapshot, reference.element);
  const f = fixture();
  const result = await f.run(["tap", resource.resource_id, encoded, ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.at(-1).action, { kind: "tap", target: { kind: "reference", reference } });
});

test("invalid touch directions and distances fail before resolving a backend", async () => {
  for (const values of [[], ["up", "-1"], ["north"], ["up", "NaN"], ["up", "1000001"], ["right", "1000000"], ["down", "1000000"], ["up", "2", "3"]]) {
    const f = fixture();
    const result = await f.run(["swipe", resource.resource_id, ...values, ...authority]);
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(result.error.code, "browser_swipe_invalid");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.resolutions, []);
  }
});

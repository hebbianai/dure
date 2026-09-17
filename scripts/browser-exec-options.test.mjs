import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:exec-options", workspace_id: "workspace:one", generation: "generation:one" };
const page = { resource, page_id: "page:one", document_revision: "3" };
const lease = { resource, controller_id: "agent:one", epoch: "5" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "9" };
const authority = ["--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "exec-options-once"];
const bytes = Buffer.from("saved artifact 한글\n");
const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/octet-stream" };
function fixture(fault) {
  const calls = [];
  const resolutions = [];
  return { calls, resolutions, run: (args) => collectBrowserCommand({ args: ["--resource", resource.resource_id, ...authority, ...args], sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async (selection) => { resolutions.push(selection); return { profile: { id: "chosen", transport: { kind: "local" } } }; },
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      let result;
      if (body.kind === "observe") result = { control, pages: [{ page }] };
      else if (body.kind === "control_state") result = control;
      else if (["network_capture_state", "interception_state", "network_state", "console"].includes(body.kind)) result = { page, recording: true, entries: [] };
      else if (body.kind === "network") result = { page, requests: [] };
      else if (body.kind === "artifact") {
        if (fault === "transfer") throw new Error("browser_response_lost");
        return { result: { artifact, base64: bytes.toString("base64"), offset: 0, eof: true } };
      } else {
        if (fault === "operation") throw new Error("browser_response_lost");
        result = { response: { success: true, data: {} } };
      }
      return { result: { operation_id: "exec-options-once", result } };
    },
  }) };
}
const pairs = [
  ["cookies", ["cookie", "get"]], ["cookies get", ["cookie", "get"]],
  ["cookies clear", ["cookie", "clear"]],
  ["cookies set name value", ["cookie", "set", "name", "value"]],
  ['cookies set name "--controller"', ["cookie", "--", "set", "name", "--controller"]],
  ["cookies set name 'space value' --url https://example.test --httpOnly --secure --sameSite Strict", ["cookie", "set", "name", "space value", "--url", "https://example.test", "--httpOnly", "--secure", "--sameSite", "Strict"]],
  ["storage local", ["storage", "local", "get"]],
  ["storage session", ["storage", "session", "get"]],
  ["storage local get", ["storage", "local", "get"]],
  ["storage session get", ["storage", "session", "get"]],
  ["storage local name", ["storage", "local", "get", "name"]],
  ["storage session '한글 키'", ["storage", "session", "get", "한글 키"]],
  ["network requests", ["network"]], ["network har start", ["capture", "start"]],
  ["network unroute pattern", ["intercept", "remove", "pattern"]],
  ["network requests --clear", ["network", "clear"]],
  ["network har stop", ["capture", "stop"]], ["console --clear", ["console", "clear"]],
  ["screenshot --full", ["full-screenshot"]], ["screenshot -f --screenshot-format jpeg", ["full-screenshot", "--format", "jpeg"]],
  ["screenshot '#entry'", ["screenshot", "--element", "#entry"]],
  ["screenshot --annotate", ["screenshot", "--annotate"]],
  ["screenshot '#entry' --annotate --screenshot-format jpeg --screenshot-quality 30", ["screenshot", "--element", "#entry", "--annotate", "--format", "jpeg", "--quality", "30"]],
  ["wait input --timeout 23", ["wait", "selector", "input", "--timeout", "23"]],
  ["wait --timeout 23 input", ["wait", "selector", "input", "--timeout", "23"]],
  ["wait constructor", ["wait", "selector", "constructor"]], ["wait __proto__", ["wait", "selector", "__proto__"]],
  ["wait 0 --timeout 23", ["wait", "duration", "0"]],
  ["wait 0 --timeout +00023", ["wait", "duration", "0"]],
  ["wait input --timeout +00023", ["wait", "selector", "input", "--timeout", "23"]],
  ["wait 000 --timeout 23", ["wait", "duration", "0"]],
  ["wait -t Ready --timeout 23", ["wait", "text", "Ready", "--timeout", "23"]],
  ["wait -u '**/done' --timeout 23", ["wait", "url", "**/done", "--timeout", "23"]],
  ["wait -l domcontentloaded --timeout 23", ["wait", "load", "domcontentloaded", "--timeout", "23"]],
  ["wait -f 'window.ready === true' --timeout 23", ["wait", "function", "window.ready === true", "--timeout", "23"]],
  ["wait -t '-f' --timeout 23", ["wait", "text", "-f", "--timeout", "23"]],
  ["wait input -t Ready -u '**/done'", ["wait", "url", "**/done"]],
  ["set media dark", ["media", "--color-scheme", "dark", "--reduced-motion", "no-preference"]],
  ["set media light reduced-motion", ["media", "--color-scheme", "light", "--reduced-motion", "reduce"]],
  ["set media light dark reduced-motion", ["media", "--color-scheme", "dark", "--reduced-motion", "reduce"]],
  ["set media", ["media", "--color-scheme", "no-preference", "--reduced-motion", "no-preference"]],
  ["set media reduced-motion", ["media", "--color-scheme", "no-preference", "--reduced-motion", "reduce"]],
  ["set media unknown", ["media", "--color-scheme", "no-preference", "--reduced-motion", "no-preference"]],
  ["set media dark --backend peer --page other", ["media", "--color-scheme", "dark", "--reduced-motion", "no-preference"]],
  ["set viewport 800 600 2", ["set", "viewport", "800", "600", "--scale", "2"]],
  ["set geolocation 37.5 127", ["set", "geo", "37.5", "127"]],
  ["set offline", ["set", "offline", "on"]], ["set offline false", ["set", "offline", "off"]],
  ["set offline true", ["set", "offline", "on"]],
  ["keyboard insertText '한글'", ["inserttext", "한글"]],
  ["scrollinto input", ["scrollintoview", "input"]],
  ...["-b", "--base64"].map((flag) => [`eval ${flag} ${Buffer.from('document.title + "한글"').toString("base64")}`, ["eval", 'document.title + "한글"']]),
];

test.each(pairs)("exec %s reaches the existing consumer with identical page/control authority", async (command, direct) => {
  const canonical = fixture(); const expected = await canonical.run(direct);
  assert.equal(expected.ok, true, JSON.stringify({ direct, expected }));
  const native = fixture(); const actual = await native.run(["exec", "--command", command]);
  assert.equal(actual.ok, true, JSON.stringify({ command, actual }));
  assert.deepEqual(actual, expected); assert.deepEqual(native.calls, canonical.calls);
  assert.ok(native.calls.filter((body) => body.kind === "action").every((body) => body.authority.lease.controller_id === lease.controller_id && body.authority.page.page_id === page.page_id && body.authority.operation_id === "exec-options-once"));
});

test("native numeric waits validate a supplied timeout before ignoring its valid value", async () => {
  for (const timeout of ["nope", "-1", "18446744073709551616"]) {
    const f = fixture(); const result = await f.run(["exec", "--command", `wait 0 --timeout ${timeout}`]);
    assert.equal(result.ok, false, timeout); assert.deepEqual(f.calls, []); assert.deepEqual(f.resolutions, []);
  }
});

test.each(["screenshot", "screenshot --full", "pdf", "download a", "network har stop"])("exec %s saves the verified artifact to its positional path without repeating input", async (command) => {
  const root = await mkdtemp(join(tmpdir(), "dure-exec-artifact-"));
  try {
    const output = join(root, "한글 output.png"); const f = fixture();
    const result = await f.run(["exec", "--command", `${command} '${output}'`]);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.output, output);
    assert.deepEqual(await readFile(output), bytes); assert.deepEqual(await readdir(root), ["한글 output.png"]);
    assert.equal(f.calls.filter((body) => ["action", "capture"].includes(body.kind)).length, 1);
    assert.deepEqual(f.calls.at(-1), { kind: "artifact", operation_id: "exec-options-once", offset: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["operation", "transfer"])("exec artifact %s failure preserves its operation and destination", async (fault) => {
  const root = await mkdtemp(join(tmpdir(), "dure-exec-artifact-fault-"));
  try {
    const output = join(root, "old.pdf"); await writeFile(output, "existing"); const f = fixture(fault);
    const result = await f.run(["exec", "--command", `pdf '${output}'`]);
    assert.equal(result.ok, false); assert.equal(result.operation_id, "exec-options-once");
    assert.equal(await readFile(output, "utf8"), "existing"); assert.deepEqual(await readdir(root), ["old.pdf"]);
    assert.equal(f.calls.filter((body) => body.kind === "action").length, 1);
    assert.equal(f.calls.filter((body) => body.kind === "artifact").length, fault === "operation" ? 0 : 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exec rejects malformed native options and unsupported semantics before selecting a backend", async () => {
  for (const command of ["eval -b !!!!", "eval -b /w==", "eval -b Zg=", "eval -b Zh==", "eval --stdin", "screenshot --screenshot-quality 101", "screenshot --screenshot-quality nope", "screenshot one two three", "screenshot --screenshot-format", "screenshot --full --backend peer", "pdf", "download a", "network requests --clear --clear", "network har start --content all", "network unroute pattern extra", "wait input --timeout", "wait -f", "wait --timeout 5", "wait input extra", "set viewport 800 600 2 extra"] ) {
    const f = fixture(); const result = await f.run(["exec", "--command", command]);
    assert.equal(result.ok, false, JSON.stringify({ command, result })); assert.deepEqual(f.calls, [], command); assert.deepEqual(f.resolutions, [], command);
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "clear", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:current", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller: lease, next_command_sequence: "12", current_page: page };
const flags = ["--controller", "agent", "--epoch", "8"];
const bytes = Buffer.from("named-argument artifact");
const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/octet-stream" };

function fixture({ identity = resource, kind = "local", observed = identity, controller = { ...lease, resource: identity }, failAt } = {}) {
  const calls = [];
  const resolved = [];
  const observedPage = { ...page, resource: observed };
  const state = { ...control, resource: observed, controller, current_page: observedPage };
  return { calls, resolved, run: (args) => collectBrowserCommand({
    args: ["--idempotency-key", "named:once", ...args], cwd: "/tasks/한글/nested",
    resolveBackend: async (selection) => { resolved.push(selection); return { profile: { id: "chosen", transport: { kind } } }; },
    requestBackend: async (_, { body }) => {
      calls.push(body);
      if (body.kind === failAt) throw new Error("browser_response_lost");
      if (body.kind === "artifact") return { result: { artifact, offset: 0, eof: true, base64: bytes.toString("base64") } };
      let result = { response: { success: true } };
      if (body.kind === "list") result = { workspace_id: identity.workspace_id, resources: [{ ...control, resource: identity }] };
      if (body.kind === "observe") result = { control: state, pages: [{ page: observedPage, title: "Current", url: "about:blank", profile_id: "default" }] };
      if (body.kind === "control_state") result = state;
      if (body.kind === "network") result = { page: observedPage, requests: [] };
      if (body.kind === "dialog_state") result = { control: state, page: observedPage, dialog: { identity: { page: observedPage, sequence: "1" } } };
      if (body.kind === "upload_chunk") result = { id: "a".repeat(64), file: body.chunk.file, received: body.chunk.file.size, complete: true };
      return { result: { result } };
    },
  }) };
}

const cases = [
  ...["click", "dblclick", "check", "uncheck", "focus", "clear", "select-all", "hover", "scrollintoview"].map((command) => [[command, "--element", "input"], [command, "input"]]),
  [["fill", "--element", "input", "--value", "한글 값"], ["fill", "input", "한글 값"]],
  [["select", "--element", "select", "--value", ""], ["select", "select", ""]],
  [["type", "--input", "한글"], ["type", "한글"]],
  [["inserttext", "--text", ""], ["inserttext", ""]],
  [["keypress", "--key", "Enter"], ["keypress", "Enter"]],
  [["keydown", "--key", "Shift"], ["keydown", "Shift"]],
  [["keyup", "--key", "Shift"], ["keyup", "Shift"]],
  [["get", "--what", "url"], ["get", "url"]],
  [["get", "--what", "value", "--element", "input"], ["get", "value", "input"]],
  [["is", "--what", "visible", "--element", "input"], ["is", "visible", "input"]],
  [["goto", "--url", "https://example.com"], ["goto", "https://example.com"]],
  [["eval", "--expression", "1 + 2"], ["eval", "1 + 2"]],
  [["scroll", "--direction", "down", "--amount", "240"], ["scroll", "down", "240"]],
  [["drag", "--from", "#one", "--to", "#two"], ["drag", "#one", "#two"]],
  [["highlight", "--selector", "input"], ["highlight", "input"]],
  [["viewport", "--width", "800", "--height", "600", "--scale", "2"], ["viewport", "800", "600", "--scale", "2"]],
  [["geolocation", "--latitude", "37.5", "--longitude", "127", "--accuracy", "3"], ["geo", "37.5", "127", "--accuracy", "3"]],
  [["set", "device", "--name", "iPhone 12"], ["device", "iPhone 12"]],
  [["set", "headers", "--headers", "{}"], ["headers", "{}"]],
  [["set", "offline", "--state", "off"], ["offline", "off"]],
  [["set", "credentials", "--user", "demo", "--pass", ""], ["set", "credentials", "--user", "demo", "--pass", ""]],
  [["mouse", "move", "--x", "2", "--y", "3"], ["mouse", "move", "2", "3"]],
  [["mouse", "down", "--button", "right"], ["mouse", "down", "right"]],
  [["mouse", "up", "--button", "left"], ["mouse", "up", "left"]],
  [["mouse", "wheel", "--dy", "12", "--dx", "-3"], ["mouse", "wheel", "12", "-3"]],
  [["cookie", "get", "--url", "https://example.com"], ["cookie", "get", "--url", "https://example.com"]],
  [["cookie", "set", "--name", "session", "--value", "", "--httpOnly", "--sameSite", "lax"], ["cookie", "set", "session", "", "--http-only", "--same-site", "lax"]],
  [["cookie", "delete", "--name", "session"], ["cookie", "delete", "session"]],
  ...["local", "session"].flatMap((area) => [
    [["storage", area, "get", "--key", "한글"], ["storage", area, "get", "한글"]],
    [["storage", area, "set", "--key", "key", "--value", ""], ["storage", area, "set", "key", ""]],
    [["storage", area, "clear"], ["storage", area, "clear"]],
  ]),
  [["find", "--locator", "role", "--value", "button", "--action", "click", "--name", "Save"], ["find", "role", "button", "click", "--name", "Save"]],
  [["find", "--locator", "label", "--value", "Name", "--action", "fill", "--text", "한글"], ["find", "label", "Name", "fill", "한글"]],
  [["dialog", "accept", "--text", "한글"], ["dialog", "accept", "한글"]],
  [["dialog", "dismiss"], ["dialog", "dismiss"]],
  [["clipboard", "write", "--text", "한글"], ["clipboard", "write", "--text", "한글"]],
  [["wait", "--selector", "input", "--state", "hidden", "--timeout", "20"], ["wait", "selector", "input", "--state", "hidden", "--timeout", "20"]],
  [["wait", "--text", "ready"], ["wait", "text", "ready"]],
  [["wait", "--url", "**/ready"], ["wait", "url", "**/ready"]],
  [["wait", "--load", "domcontentloaded"], ["wait", "load", "domcontentloaded"]],
  [["wait", "--fn", "document.readyState === 'complete'"], ["wait", "function", "document.readyState === 'complete'"]],
  [["wait", "--timeout", "0"], ["wait", "duration", "0"]],
];

test.each(cases)("named %j preserves the existing typed requests", async (named, positional) => {
  const expected = fixture();
  const baseline = await expected.run([...positional, "--resource", resource.resource_id, ...flags]);
  assert.equal(baseline.ok, true, JSON.stringify({ positional, baseline }));
  for (const selector of [["--resource", resource.resource_id], ["--worktree", "current"], []]) {
    const client = fixture();
    const report = await client.run([...named, ...selector, ...flags]);
    assert.equal(report.ok, true, JSON.stringify({ named, selector, report }));
    const scoped = selector[0] !== "--resource";
    if (scoped) assert.deepEqual(client.calls[0], { kind: "list", workspace_path: "/tasks/한글/nested" });
    assert.deepEqual(client.calls.slice(scoped ? 1 : 0), expected.calls);
    assert.deepEqual(report, baseline);
  }
});

test("named file parameters retain real local bytes and awaited artifact cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-browser-named-files-"));
  try {
    const first = join(root, "한글 one.txt");
    const second = join(root, "two.txt");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const upload = fixture();
    const uploaded = await upload.run(["upload", "--element", "input", "--files", `${first}, ${second}`, ...flags]);
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
    assert.deepEqual(upload.calls.filter((call) => call.kind === "upload_chunk").map((call) => Buffer.from(call.chunk.base64, "base64").toString()), ["one", "two"]);
    const output = join(root, "download.txt");
    const download = fixture();
    const downloaded = await download.run(["download", "--selector", "a", "--path", output, ...flags]);
    assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(download.calls.filter((call) => call.kind === "action").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named references keep their original identity without requiring the local cwd", async () => {
  const original = { ...page, page_id: "page:original", document_revision: "2" };
  const ref = encodeRef({ page: original, revision: "3" }, "e1");
  const client = fixture({ kind: "ssh" });
  const report = await client.run(["fill", "--element", ref, "--value", "한글", ...flags]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(client.calls.some((call) => call.kind === "list"), false);
  assert.deepEqual(client.calls.at(-1).authority.page, original);
});

test("default workspace lookup refuses unknown remote cwd and changed controller or resource", async () => {
  const remote = fixture({ kind: "ssh" });
  assert.equal((await remote.run(["get", "--what", "url"])).error?.code, "browser_workspace_required");
  assert.deepEqual(remote.calls, []);
  const stale = fixture({ controller: { ...lease, epoch: "9" } });
  assert.equal((await stale.run(["fill", "--element", "input", "--value", "text", ...flags])).error?.code, "browser_controller_changed");
  const moved = fixture({ observed: { ...resource, generation: "replacement" } });
  assert.equal((await moved.run(["get", "--what", "url"])).error?.code, "browser_resource_mismatch");
  for (const failAt of ["observe", "action"]) {
    const client = fixture({ failAt });
    const result = await client.run(["fill", "--element", "input", "--value", "text", ...flags]);
    assert.equal(result.error?.code, "browser_response_lost");
    assert.equal(result.operation_id, "named:once");
    assert.equal(client.calls.filter((call) => call.kind === failAt).length, 1);
  }
});

test("contradictory or incomplete named parameters fail before backend selection", async () => {
  for (const args of [
    ["fill", "--element", "input"], ["get", "--what", "url", "--element", "input"],
    ["click", "--element", "one", "--element", "two"], ["click", "clear", "one", "--element", "two"],
    ["click", "clear", "--element", "one", "--resource", "other"],
    ["click", "clear", "--element", "one", "--worktree", "current"],
    ["viewport", "--width", "800"], ["snapshot", "--value", "extra"],
    ["cookie", "set", "--name", "n", "--value", "v", "--httpOnly", "--http-only"],
    ["wait", "--selector", "input", "--selector", "duplicate"],
    ["download", "--selector", "a", "--path", "one", "--output", "two"],
    ["upload", "--element", "input", "--files", "one,,two"],
  ]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.ok, false, JSON.stringify(args));
    assert.deepEqual(client.resolved, [], JSON.stringify({ args, report }));
  }
});

test("set keeps legacy resource IDs that are also subcommands", async () => {
  for (const id of ["device", "headers", "offline", "credentials"]) {
    const identity = { ...resource, resource_id: id };
    const explicit = fixture({ identity });
    const legacy = fixture({ identity });
    const suffix = ["--user", "demo", "--pass", "", ...flags];
    const expected = await explicit.run(["set", "credentials", "--resource", id, ...suffix]);
    const actual = await legacy.run(["set", id, "credentials", ...suffix]);
    assert.equal(expected.ok, true, JSON.stringify(expected));
    assert.equal(actual.ok, true, JSON.stringify({ id, actual }));
    assert.deepEqual(legacy.calls, explicit.calls);
    assert.equal(legacy.calls.at(-1).authority.page.resource.resource_id, id);
  }
});

test("inline named values preserve empty, Korean and option-like literals", async () => {
  for (const value of ["", "한글=값", "--help", "--element=input"]) {
    const named = fixture();
    const positional = fixture();
    const expected = await positional.run(["fill", "clear", "input", ...flags, "--", value]);
    const report = await named.run(["fill", "--element=input", `--value=${value}`, "--resource=clear", ...flags]);
    assert.equal(expected.ok, true, JSON.stringify(expected));
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(named.calls, positional.calls);
  }
  for (const args of [
    ["fill", "--element=input", "--value=a", "--value", "b"],
    ["cookie", "set", "--name=n", "--value=v", "--sameSite=lax", "--same-site=strict"],
    ["cookie", "set", "--name=n", "--value=v", "--httpOnly=true"],
    ["get", "--what=url", "--resource=clear", "--worktree=current"],
  ]) {
    const client = fixture();
    assert.equal((await client.run(args)).ok, false, JSON.stringify(args));
    assert.deepEqual(client.resolved, []);
  }
});

test("resource-free commands use current workspace only for complete forms", async () => {
  for (const args of [
    ["show"], ["snapshot"], ["network"], ["get", "--what", "url"], ["tab", "list"], ["tab", "current"],
    ["back", ...flags], ["forward", ...flags], ["reload", ...flags],
    ["control", "--controller", "agent"], ["close"],
    ["tab", "create", "--url", "https://example.com", ...flags],
    ["tab", "switch", "--page", page.page_id, ...flags], ["tab", "close", ...flags],
    ["tab", "show", "--page", page.page_id], ["tab", "profile", "show", "--page", page.page_id],
    ["tab", "profile", "use-default", "--page", page.page_id, ...flags],
    ["tab", "profile", "set", "--profile", "another", "--page", page.page_id, ...flags],
  ]) {
    const current = fixture();
    const explicit = fixture();
    const expected = await explicit.run([...args, "--resource", resource.resource_id]);
    const report = await current.run(args);
    assert.equal(expected.ok, true, JSON.stringify({ args, expected }));
    assert.equal(report.ok, true, JSON.stringify({ args, report }));
    assert.deepEqual(current.calls[0], { kind: "list", workspace_path: "/tasks/한글/nested" });
    assert.deepEqual(current.calls.slice(1), explicit.calls);
    assert.deepEqual(report, expected);
  }
  const noLease = fixture();
  assert.equal((await noLease.run(["fill", "--element", "input", "--value", "text"])).ok, false);
  assert.equal(noLease.calls.some((call) => call.kind === "action" || call.kind === "claim_control"), false);
  const remote = fixture({ kind: "ssh" });
  assert.equal((await remote.run(["get", "--what", "url", "--worktree", `id:${resource.workspace_id}`])).ok, true);
  assert.deepEqual(remote.calls[0], { kind: "list", workspace_id: resource.workspace_id });
});

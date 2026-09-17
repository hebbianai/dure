import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "capture:resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "7" };
const snapshot = { page, revision: "8" };
const reference = encodeRef(snapshot, "e17");
const bytes = Buffer.from("fixture capture bytes");
const artifact = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" };
function fixture(captureSnapshot = snapshot) {
  const calls = [];
  return { calls, run: (args) => collectBrowserCommand({ args: [...args, "--idempotency-key", "capture:once"], cwd: "/fixture", sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "chosen", transport: { kind: "local" } } }),
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "artifact") return { result: { artifact, base64: bytes.toString("base64"), offset: 0, eof: true } };
      const result = body.kind === "observe"
        ? { control: { resource, current_page: page, controller: null }, pages: [{ page }] }
        : { artifact, snapshot: captureSnapshot, annotations: [{ element: "e17", number: 1, role: "button", name: "선택", box: { x: 0, y: 0, width: 80, height: 30 } }] };
      return { result: { result } };
    },
  }) };
}

test.each([
  ["screenshot", "--element", reference],
  ["screenshot", reference],
  ["screenshot", resource.resource_id, "--element", reference],
  ["screenshot", "--resource", resource.resource_id, "--element", reference],
  ["exec", resource.resource_id, "--command", `screenshot ${reference} --annotate --screenshot-quality 0`],
])("capture keeps full reference identity without acquiring input: %j", async (...args) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  const capture = f.calls.find((call) => call.kind === "capture");
  assert.deepEqual(capture.page, page);
  assert.deepEqual(capture.options.target, { kind: "reference", reference: { snapshot, element: "e17" } });
  assert.equal(f.calls.some((call) => ["action", "control"].includes(call.kind)), false);
  assert.equal(result.result.annotations[0].ref, reference);
  assert.deepEqual(result.references, { [reference]: { role: "button", name: "선택" } });
});

test("native selector and literal output path preserve bytes, quality and annotation options", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-element-capture-cli-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "한글 $literal.png"); const f = fixture();
  const result = await f.run(["exec", resource.resource_id, "--command", `screenshot '#entry' '${output}' --annotate --screenshot-format jpeg --screenshot-quality 30`]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.find((call) => call.kind === "capture").options, { full_page: false, format: "jpeg", quality: 30, annotate: true, target: { kind: "css", selector: "#entry" } });
  assert.deepEqual(await readFile(output), bytes);
  assert.equal(f.calls.filter((call) => call.kind === "capture").length, 1);
});

test("capture refuses mixed targets, malformed quality and another page before capture", async () => {
  for (const args of [
    ["screenshot", resource.resource_id, "#one", "--element", "#two"],
    ["screenshot", resource.resource_id, "--element", "#one", "--selector", "#two"],
    ["screenshot", resource.resource_id, "--quality", "-1"],
    ["screenshot", resource.resource_id, "--quality", "101"],
    ["screenshot", resource.resource_id, "--quality", "1.5"],
    ["get", resource.resource_id, "title", "--annotate"],
    ["screenshot", "--element", reference, "--page", "another-page"],
    ["screenshot", "--resource", "another-resource", "--element", reference],
  ]) {
    const f = fixture(); const result = await f.run(args);
    assert.equal(result.ok, false, JSON.stringify({ args, result }));
    assert.equal(f.calls.some((call) => ["capture", "artifact", "action", "control"].includes(call.kind)), false);
  }
});


test("another page's capture metadata cannot issue references or publish a file", async () => {
  const f = fixture({ ...snapshot, page: { ...page, page_id: "another-page" } });
  const result = await f.run(["screenshot", resource.resource_id, "--annotate"]);
  assert.equal(result.error?.code, "browser_response_invalid");
  assert.equal(f.calls.some((call) => call.kind === "artifact"), false);
});

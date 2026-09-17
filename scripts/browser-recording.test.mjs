import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { recordingOutput } from "../cli/lib/browser-recording-output.mjs";

const resource = { resource_id: "r", generation: "g", workspace_id: "w" };
const initialPage = { resource, page_id: "p", document_revision: "1" };
const shared = ["--controller", "agent", "--epoch", "9"];
const profile = { id: "recording-test", expected: { backendId: "backend-test" } };

function fixture(root, fault) {
  let recording = null;
  let sequence = 1;
  let currentResource = resource;
  let page = { ...initialPage };
  const calls = [];
  const bytes = Buffer.from("bounded immutable video bytes");
  const manifest = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "video/mp4", suggestedFilename: "/backend-must-not-choose-output.mp4" };
  const run = (args, environment = { DURE_HOME: root }) => collectBrowserCommand({ args: [...args, ...shared], cwd: root, sourceEnvironment: environment,
    resolveBackend: async () => ({ profile }), requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "artifact") {
        if (fault === "artifact") throw new Error("browser_fixture_artifact_lost");
        return { result: { artifact: manifest, offset: 0, base64: bytes.toString("base64"), eof: true } };
      }
      let result;
      if (body.kind === "control_state") result = { resource: currentResource, current_page: page, controller: { resource: currentResource, controller_id: "agent", epoch: "9" }, next_command_sequence: String(sequence) };
      else if (body.kind === "recording_state") result = { page: fault === "page" ? { ...page, resource: { ...resource, generation: "different" } } : page, operation_id: recording };
      else if (body.kind === "action") {
        assert.equal(body.authority.command_sequence, String(sequence++));
        assert.deepEqual(body.authority.page, page);
        if (body.action.kind === "navigate") {
          page = { ...page, document_revision: "2" };
          if (fault === "navigate") throw new Error("browser_fixture_navigation_reply_lost");
          result = { response: { success: true, data: { page } } };
        } else if (body.action.action === "start") {
          assert.equal(recording, null);
          recording = body.authority.operation_id;
          if (fault === "start") throw new Error("browser_fixture_start_reply_lost");
          result = { response: { success: true, data: { started: true, recording_operation_id: recording } } };
        } else {
          assert.notEqual(recording, null);
          manifest.mimeType = `video/${body.action.format}`;
          result = { response: { success: true, data: { stopped: true, recording_operation_id: recording, artifact: manifest } } };
          recording = null;
          if (fault === "stop") throw new Error("browser_fixture_stop_reply_lost");
          if (fault === "generation") {
            currentResource = { ...resource, generation: "replacement" };
            page = { ...page, resource: currentResource };
          }
        }
      } else throw new Error(`unexpected ${body.kind}`);
      return { result: { result } };
    } });
  return { run, calls, bytes };
}

test("native record start path survives CLI invocations and navigation; stop writes that exact client destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-cli-"));
  try {
    const { run, calls, bytes } = fixture(root);
    const started = await run(["exec", "r", "--command", 'record start "my video.mp4" https://example.test/', "--idempotency-key", "record-start"]);
    assert.equal(started.ok, true, JSON.stringify(started));
    const status = await run(["record", "r", "status"]);
    assert.equal(status.result.operation_id, "record-start");
    const stopped = await run(["record", "r", "stop", "--idempotency-key", "record-stop"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.deepEqual(await readFile(join(root, "my video.mp4")), bytes);
    assert.equal(stopped.result.response.data.recording_operation_id, "record-start");
    assert.equal(calls.filter((call) => call.kind === "action" && call.action.action === "stop").length, 1);
    assert.equal(calls.find((call) => call.kind === "action" && call.action.action === "stop").authority.page.document_revision, "2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("WebM start intent and mixed-format restart choose the admitted stop container", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-formats-"));
  try {
    const { run, calls, bytes } = fixture(root);
    assert.equal((await run(["record", "r", "start", "one.WEBM"])).ok, true);
    const next = await run(["record", "r", "restart", "two.mp4"]);
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.result.previous.artifact.mimeType, "video/webm");
    assert.deepEqual(await readFile(join(root, "one.WEBM")), bytes);
    const stopped = await run(["record", "r", "stop"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.result.artifact.mimeType, "video/mp4");
    assert.deepEqual(calls.filter(call => call.action?.action === "stop").map(call => call.action.format), ["webm", "mp4"]);
    assert.equal((await run(["record", "r", "start", "three.mp4"])).ok, true);
    const override = await run(["record", "r", "stop", "--output", join(root, "three.webm")]);
    assert.equal(override.ok, true, JSON.stringify(override));
    assert.equal(override.result.artifact.mimeType, "video/webm");
    assert.deepEqual(await readFile(join(root, "three.webm")), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart saves the previous artifact before starting a separately recoverable interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-restart-"));
  try {
    const { run, calls, bytes } = fixture(root);
    assert.equal((await run(["record", "r", "start", "one.mp4", "--idempotency-key", "first"])).ok, true);
    const restarted = await run(["exec", "r", "--command", "record restart two.mp4", "--idempotency-key", "second"]);
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    assert.deepEqual(await readFile(join(root, "one.mp4")), bytes);
    assert.equal(restarted.result.response.data.recording_operation_id, "second");
    assert.ok(restarted.result.previous.operation_id.startsWith("record-v1:"));
    assert.equal((await run(["record", "r", "stop"])).ok, true);
    assert.deepEqual(await readFile(join(root, "two.mp4")), bytes);
    assert.deepEqual(calls.filter((call) => call.kind === "action").map((call) => call.action.action), ["start", "stop", "start", "stop"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a different client receives inline bytes unless it explicitly chooses a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-clients-"));
  const other = await mkdtemp(join(tmpdir(), "dure-recording-other-"));
  try {
    const { run, bytes } = fixture(root);
    assert.equal((await run(["record", "r", "start", "private.mp4"])).ok, true);
    const stopped = await run(["record", "r", "stop"], { DURE_HOME: other });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.result.base64, bytes.toString("base64"));
    assert.deepEqual(await readdir(other), []);
    assert.deepEqual(await readdir(root), ["browser-recording-outputs"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("artifact failure preserves an existing file and never repeats stop or starts the replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-artifact-fault-"));
  try {
    const { run, calls } = fixture(root, "artifact");
    await writeFile(join(root, "one.mp4"), "original");
    assert.equal((await run(["record", "r", "start", "one.mp4"])).ok, true);
    const result = await run(["record", "r", "restart", "two.mp4"]);
    assert.equal(result.ok, false);
    assert.ok(result.operation_id.startsWith("record-v1:"));
    assert.equal(result.result.response.data.stopped, true);
    assert.equal(await readFile(join(root, "one.mp4"), "utf8"), "original");
    assert.deepEqual(calls.filter((call) => call.kind === "action").map((call) => call.action.action), ["start", "stop"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lost start response retains destination intent without retrying the recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-start-fault-"));
  try {
    const { run, calls } = fixture(root, "start");
    assert.equal((await run(["record", "r", "start", "recover.mp4", "--idempotency-key", "once"])).ok, false);
    assert.equal(await recordingOutput(profile, resource, "once", undefined, { DURE_HOME: root }), join(root, "recover.mp4"));
    assert.equal(calls.filter((call) => call.kind === "action").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lost optional navigation reply exposes its own receipt and the completed recording start", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-navigation-loss-"));
  try {
    const { run, calls } = fixture(root, "navigate");
    const result = await run(["record", "r", "start", "one.mp4", "https://example.test", "--idempotency-key", "start"]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser_fixture_navigation_reply_lost");
    assert.equal(result.result.response.data.started, true);
    assert.equal(result.result.response.data.recording_operation_id, "start");
    const operations = calls.filter((call) => call.kind === "action");
    assert.equal(operations.length, 2);
    assert.equal(result.operation_id, operations[1].authority.operation_id);
    assert.notEqual(result.operation_id, "start");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart preserves the stop receipt on response loss and cannot cross a replaced resource generation", async () => {
  for (const fault of ["stop", "generation"]) {
    const root = await mkdtemp(join(tmpdir(), "dure-recording-restart-loss-"));
    try {
      const { run, calls } = fixture(root, fault);
      assert.equal((await run(["record", "r", "start", "one.mp4", "--idempotency-key", "first"])).ok, true);
      const result = await run(["record", "r", "restart", "two.mp4", "--idempotency-key", "second"]);
      assert.equal(result.ok, false);
      const operations = calls.filter((call) => call.kind === "action");
      assert.deepEqual(operations.map((call) => call.action.action), ["start", "stop"]);
      assert.equal(result.operation_id, operations[1].authority.operation_id);
      assert.notEqual(result.operation_id, "second");
      assert.equal(result.error.code, fault === "stop" ? "browser_fixture_stop_reply_lost" : "browser_resource_mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("local recording intent rejects path replacement and symlink substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-recording-intent-"));
  try {
    const env = { DURE_HOME: root };
    assert.equal(await recordingOutput(profile, resource, "once", "one.mp4", env, root), join(root, "one.mp4"));
    await assert.rejects(recordingOutput(profile, resource, "once", "different.mp4", env, root), /browser_recording_output_conflict/);
    assert.equal(await recordingOutput(profile, { ...resource, generation: "other" }, "once", undefined, env), undefined);
    const dir = join(root, "browser-recording-outputs");
    const [name] = await readdir(dir);
    await rm(join(dir, name));
    await symlink(join(root, "victim"), join(dir, name));
    await assert.rejects(recordingOutput(profile, resource, "once", undefined, env));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid recording syntax and foreign page identity cannot dispatch an action", async () => {
  for (const args of [["start"], ["restart", ""], ["stop", "extra"], ["status", "--output", "x.mp4"], ["start", "x.mp4", "javascript:alert(1)"]]) {
    let contacted = false;
    const result = await collectBrowserCommand({ args: ["record", "r", ...args, ...shared], resolveBackend: async () => { contacted = true; } });
    assert.equal(result.ok, false);
    assert.equal(contacted, false);
  }
  const root = await mkdtemp(join(tmpdir(), "dure-recording-identity-"));
  try {
    const { run, calls } = fixture(root, "page");
    assert.equal((await run(["record", "r", "start", "one.mp4"])).ok, false);
    assert.equal(calls.some((call) => call.kind === "action"), false);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

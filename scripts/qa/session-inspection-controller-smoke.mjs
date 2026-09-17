import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../lib/process-identity.mjs";
import { inspectionBackendFixture } from "./lib/session-inspection-backend.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const hmux = realpathSync(process.argv[2] ?? join(repository, "hmux/target/debug/hmux"));
const runtime = realpathSync(process.argv[3] ?? join(repository, "hmux/target/debug/hmux-runtime"));
const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-inspection-controller-")));
const discovery = join(root, "hmux-discovery");
const home = join(root, "home");
mkdirSync(home);
const environment = {
  PATH: process.env.PATH,
  HOME: home,
  SHELL: "/bin/sh",
  DURE_HOME: join(root, "dure"),
  DURE_APP_CHANNEL: "stable",
  HMUX_DISCOVERY_ROOT: discovery,
  HMUX_RUNTIME: runtime,
  DURE_HMUX_BIN: hmux,
};
const backend = process.argv[4] ? inspectionBackendFixture({
  root, environment, executable: realpathSync(process.argv[4]), hmux, runtime,
}) : null;
const sockets = [];
const processes = [];
let created;
let descriptor;
let fence;
let passed = false;

function command(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: home, env: environment, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, "QA command transport");
  assert.equal(result.status, 0, `QA command failed: ${result.stderr} ${result.status === 0 ? "" : result.stdout}`);
  return JSON.parse(result.stdout);
}

function native(args) {
  return command(hmux, ["--discovery-root", discovery, "--json", ...args]);
}

function readManifest(directory = discovery, depth = 0) {
  assert.ok(depth <= 8, "bounded QA manifest traversal");
  if (!existsSync(directory)) return null;
  const entries = readdirSync(directory, { withFileTypes: true });
  assert.ok(entries.length <= 32, "bounded QA manifest directory");
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const value = readManifest(path, depth + 1);
      if (value) return value;
    } else if (entry.name === "manifest.json" && entry.isFile()) {
      const bytes = readFileSync(path);
      assert.ok(bytes.length <= 64 * 1024, "bounded QA manifest");
      const value = JSON.parse(bytes.toString("utf8")).manifest;
      if (created) {
        assert.equal(value.common.lifetime.session_id, created.sessionId);
        assert.equal(value.common.lifetime.workspace_id, created.workspaceId);
      }
      return value;
    }
  }
  return null;
}

function manifestFence(manifest) {
  return {
    ...manifest.common.lifetime,
    channel_epoch: String(manifest.common.lifetime.channel_epoch),
    host_instance_id: manifest.common.host_instance_id,
    terminal_epoch: manifest.terminal_epoch,
  };
}

async function attach(mode, token) {
  const socket = createConnection(descriptor.endpoint.address);
  sockets.push(socket);
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  const pending = [];
  let metadata;
  let failure;
  socket.on("error", (error) => { failure = error; });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1024 * 1024) {
      failure = new Error("QA frame buffer exceeded its bound");
      socket.destroy();
      return;
    }
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      try {
        const { body } = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        if (body.kind === "screen_snapshot") {
          metadata = {
            executionLocation: body.payload.execution_location,
            agentIdentity: body.payload.agent_identity,
          };
        }
        if (["hello_ack", "input_receipt", "agent_state_report_receipt", "error"].includes(body.kind)) {
          pending.push(body);
          assert.ok(pending.length <= 16, "bounded QA receipt queue");
        }
      } catch (error) { failure = error; socket.destroy(); }
      buffer = buffer.subarray(4 + length);
    }
  });
  await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
  const send = (kind, payload) => {
    const body = Buffer.from(JSON.stringify({
      protocol_version: { major: 1, minor: 0 }, frame_id: String(++sequence),
      body: { kind, payload },
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  const receive = async (kind) => {
    const deadline = performance.now() + 5000;
    for (;;) {
      if (failure) throw failure;
      const body = pending.shift();
      if (body) {
        if (body.kind === "error") throw new Error(`QA Host refusal: ${body.payload.code}: ${body.payload.message}`);
        assert.equal(body.kind, kind, "Host returned the expected receipt kind");
        return body.payload;
      }
      assert.ok(performance.now() < deadline, `bounded QA wait for ${kind}`);
      await delay(10);
    }
  };
  send("hello", {
    supported_versions: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
    requested_capabilities: ["screen_snapshot", "terminal_input", "agent_state_report_v1",
      "execution_location_projection_v1", "agent_identity_projection_v1"],
    expected_fence: fence, requested_mode: mode, reconnect_cursor: null,
    capability_token: token, authorization_proof_reference: null, initial_snapshot_profile: null,
  });
  const ack = await receive("hello_ack");
  const deadline = performance.now() + 5000;
  while (!metadata) {
    if (failure) throw failure;
    assert.ok(performance.now() < deadline, "bounded initial metadata observation");
    await delay(10);
  }
  return { socket, send, receive, ack, metadata };
}

try {
  created = native(["new", "--name", "inspection-qa", "--runtime", runtime, "--",
    "/bin/sh", "-c", "while IFS= read -r line; do printf 'qa-ack\\n'; done"]);
  descriptor = native(["session", "show", created.sessionId, "--workspace", created.workspaceId]);
  fence = Object.fromEntries([
    "workspace_id", "session_id", "runner_principal", "runner_instance", "channel_epoch",
    "host_instance_id", "terminal_epoch",
  ].map((field) => [field, descriptor[field]]));
  for (const proof of [descriptor.host_process, descriptor.provider_process]) {
    const identity = processIdentity(proof.process_id);
    assert.ok(identity, "exact owned process generation is observable");
    processes.push({ pid: proof.process_id, identity });
  }
  const token = readManifest().capability_token;
  assert.ok(token, "owned Host capability is present");
  const controller = await attach("controller", token);
  assert.equal(controller.metadata.executionLocation.location.kind, "local");
  assert.equal(controller.metadata.agentIdentity.agent, null, "Host positively identifies the ordinary shell");
  const generation = controller.ack.controller_generation;
  const reporter = await attach("observer", token);
  assert.equal(reporter.ack.controller_generation, generation);
  mkdirSync(environment.DURE_HOME, { recursive: true, mode: 0o700 });
  const profiles = [null, ...(backend ? await backend.start() : [])];
  const observations = [];
  for (const profile of profiles) {
    for (let repetition = 0; repetition < 3; repetition++) {
      const observationId = `${profile ?? "direct-hmux"}-${repetition}`;
      reporter.send("agent_state_report", {
        request_id: `qa-state-${observationId}`, activity: "waiting", attention: "approval_required",
        turn_completed: false,
      });
      assert.equal((await reporter.receive("agent_state_report_receipt")).outcome, "applied");
      const observed = native(["session", "show", descriptor.session_id, "--workspace", descriptor.workspace_id]);
      assert.equal(observed.executionLocation?.location.kind, "local", "metadata inspection preserves the Host execution boundary");
      assert.equal(observed.agentIdentity?.agent, null, "metadata inspection preserves positive ordinary-shell identity");
      const state = observed.agentRuntimeState;
      assert.equal(state.attention, "approval_required", "native Host received the synthetic QA report");
      const report = command(process.execPath, [join(repository, "cli/dure.mjs"),
        "sessions", "show", descriptor.session_id, "--workspace", descriptor.workspace_id,
        "--deadline-ms", "10000", "--json", ...(profile ? ["--backend", profile] : [])]);
      assert.equal(report.kind, "dure.sessions.show");
      const session = report.session;
      assert.equal(session.sessionId, descriptor.session_id);
      assert.equal(session.workspaceId, descriptor.workspace_id);
      assert.equal(session.runtime.sessionClass, "standalone");
      assert.equal(session.runtime.generation.hostInstanceId, fence.host_instance_id);
      assert.equal(session.runtime.generation.terminalEpoch, fence.terminal_epoch);
      assert.equal(session.liveness.exactGeneration, true);
      assert.equal(session.liveness.health, "healthy");
      assert.equal(session.cwd, home);
      assert.equal(session.runtime.executionLocation.location.kind, "local");
      assert.equal(session.runtime.agentIdentity.agent, null);
      for (const fact of [session.runtime.executionLocation, session.runtime.agentIdentity]) {
        assert.equal(fact.terminalEpoch, fence.terminal_epoch);
        assert.equal(fact.source, "process_inspection");
        assert.ok(BigInt(fact.observedThroughOutputSeq) <= BigInt(session.runtime.outputSequence));
      }
      assert.deepEqual(session.runtime.agentRuntimeState, {
        terminalEpoch: state.terminal_epoch, revision: state.revision,
        observedThroughOutputSeq: state.observed_through_output_seq,
        lifecycle: state.lifecycle, activity: state.activity, attention: state.attention,
        attentionId: state.attention_id, source: state.source, turnCompletedCount: state.turn_completed_count,
      });
      const observer = await attach("observer", token);
      assert.equal(observer.ack.controller_generation, generation);
      observer.send("detach", { reason: "qa-inspection-complete" });
      observer.socket.end();
      const requestId = `controller-after-inspection-${observationId}`;
      controller.send("input", {
        request_id: requestId, controller_generation: generation,
        bytes: Buffer.from("qa-input\n").toString("base64"),
      });
      const receipt = await controller.receive("input_receipt");
      assert.equal(receipt.request_id, requestId);
      assert.equal(receipt.state, "written_to_pty");
      assert.equal(receipt.controller_generation, generation);
      observations.push({ profile: profile ?? "direct-hmux", repetition, controllerGeneration: generation, inputState: receipt.state });
    }
  }
  console.log(JSON.stringify({ scenario: "CLI inspection with active native controller", observations }));
  passed = true;
} catch (error) {
  console.error(`QA inspection failed in ${root}: ${error.stack}`);
  throw error;
} finally {
  for (const socket of sockets) socket.destroy();
  try {
    // Discover only the unique QA root, including a create whose stdout was lost.
    // Cleanup keeps the exact native fence; it never selects by a PID or name.
    const manifest = readManifest();
    if (manifest) {
      const cleanupFence = fence ?? manifestFence(manifest);
      for (const proof of [manifest.common.host_process, manifest.provider_process]) {
        assert.ok(proof, `QA process authority incomplete; evidence retained at ${root}`);
        if (!processes.some(({ pid }) => pid === proof.process_id)) {
          processes.push({ pid: proof.process_id, identity: processIdentity(proof.process_id) });
        }
      }
      native(["kill", cleanupFence.session_id, "--workspace", cleanupFence.workspace_id,
        "--expected-fence-json", JSON.stringify(cleanupFence), "--timeout-ms", "10000"]);
    }
    const deadline = performance.now() + 10_000;
    while (processes.some(({ pid }) => processIdentity(pid) !== null)) {
      assert.ok(performance.now() < deadline, `QA process cleanup incomplete; evidence retained at ${root}`);
      await delay(50);
    }
  } finally {
    if (backend) await backend.stop();
  }
  if (passed) {
    rmSync(root, { recursive: true });
    console.log("QA owned generations absent; isolated root removed");
  } else {
    console.error(`QA failed; isolated evidence retained at ${root}`);
  }
}

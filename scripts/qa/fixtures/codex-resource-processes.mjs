import assert from "node:assert/strict";
import { on, once } from "node:events";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";
import {
  observeProcessMembers,
  processMemberFromObservation,
  requireNativeProcessGroupSupport,
} from "../../lib/process-identity.mjs";

const [mode, directory, generation, endpoint, threadId, codexExecutable] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(basename(root), "codex-resources");
assert.ok(basename(dirname(root)).startsWith("dure-hmux-test."));
assert.equal(
  root,
  realpathSync(join(process.env.DURE_HMUX_TEST_STATE_ROOT, "codex-resources")),
);
assert.match(generation, /^(?:[1-9]|10)$/u);
if (mode === "prepare") {
  await requireNativeProcessGroupSupport();
  process.stdout.write(`${JSON.stringify({ mode, generation, prepared: true })}\n`);
} else if (["call", "call-blocked", "call-blocked-detach", "call-refused", "call-idle", "call-idle-activate", "call-reload", "descendant"].includes(mode)) {
  assert.equal(dirname(dirname(realpathSync(endpoint))), root);
  assert.match(basename(dirname(endpoint)), /^dure-codex-/u);
  assert.equal(basename(endpoint), "client.sock");
  assert.match(threadId, /^[a-zA-Z0-9-]+$/u);
  const socket = new WebSocket(`ws+unix://${endpoint}:/`);
  const timeout = setTimeout(() => socket.terminate(), 30000);
  try {
    await once(socket, "open");
    let sequence = 0;
    async function call(method, params) {
      const id = ++sequence;
      const responses = on(socket, "message", { close: ["close"] });
      socket.send(JSON.stringify({ id, method, params }));
      for await (const [bytes] of responses) {
        const message = JSON.parse(bytes.toString());
        if (message.id !== id) continue;
        assert.equal(message.error, undefined, JSON.stringify(message.error));
        return message.result;
      }
      throw new Error("resource fixture connection closed before response");
    }
    await call("initialize", {
      clientInfo: { name: "dure_resource_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    if (mode === "descendant") {
      const { observeActiveDescendant } = await import("./codex-resource-descendants.mjs");
      const observed = await observeActiveDescendant(call, threadId);
      process.stdout.write(`${JSON.stringify({ mode, generation, observed })}\n`);
    } else {
      const history = await call("thread/turns/list", {
        threadId, limit: 10, sortDirection: "asc", itemsView: "full",
      });
      assert.equal(history.nextCursor, null);
      assert.equal(history.data.length, Number(generation));
      assert.equal(new Set(history.data.map((turn) => turn.id)).size, Number(generation));
      const prompts = JSON.parse(readFileSync(join(root, "expected-prompts.json"), "utf8"));
      const retainedTurns = history.data.map((turn, index) => {
        const prompt = prompts[index];
        assert.equal(typeof prompt, "string");
        assert.equal(turn.status, "completed");
        assert.ok(turn.items.some((item) => item.type === "userMessage" &&
          item.content.some((content) => content.type === "text" && content.text === prompt)),
        `persisted user input from turn ${index + 1} was not retained`);
        return { id: turn.id, prompt };
      });
      if (Number(generation) > 1) {
        assert.deepEqual(retainedTurns.slice(0, -1),
          JSON.parse(readFileSync(join(root, `history-${Number(generation) - 1}.json`), "utf8")));
      }
      writeFileSync(join(root, `history-${generation}.json`), JSON.stringify(retainedTurns));
      if (mode === "call-reload") {
        const { verifyCodexMcpReload } = await import("./codex-mcp-reload.mjs");
        await verifyCodexMcpReload({ call, root, threadId, history });
        process.stdout.write(`${JSON.stringify({ mode, generation, verified: true })}\n`);
      } else if (mode === "call-idle" || mode === "call-idle-activate") {
        const { verifyCodexIdleWorker } = await import("./codex-idle-worker.mjs");
        await verifyCodexIdleWorker({
          call, threadId, history, codexExecutable,
          reportPath: join(root, `idle-worker-${generation}.json`),
          activateExisting: mode === "call-idle-activate",
        });
        process.stdout.write(`${JSON.stringify({ mode, generation, verified: true })}\n`);
      } else {
        const pending = call("mcpServer/tool/call", {
          threadId,
          server: "resource_fixture",
          tool: "counter",
          arguments: { hold: mode.startsWith("call-blocked") },
        });
        if (mode === "call-blocked-detach") {
          const observed = pending.then(() => "completed", () => "disconnected");
          await once(process.stdin, "data");
          process.stdin.pause();
          socket.terminate();
          assert.equal(await observed, "disconnected");
          process.stdout.write(`${JSON.stringify({ mode, generation, detached: true })}\n`);
        } else if (mode === "call-refused") {
          await assert.rejects(pending, /Dure could not admit this request/u);
          process.stdout.write(`${JSON.stringify({ mode, generation, refused: true })}\n`);
        } else {
          const result = await pending;
          assert.notEqual(result.isError, true, JSON.stringify(result));
          assert.deepEqual(result.content, [{ type: "text", text: "resource-counter-1" }]);
          process.stdout.write(`${JSON.stringify({ mode, generation, result })}\n`);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    socket.terminate();
  }
} else if (mode === "verify-idle-exit") {
  const captured = JSON.parse(readFileSync(join(root, `idle-worker-${generation}.json`), "utf8"));
  assert.equal(captured.ok, true);
  const members = [captured.provider, captured.relay, ...captured.workers,
    ...(captured.activation ? [captured.activation.previousWorker, captured.activation.keep] : [])];
  const observation = await observeProcessMembers({ kind: "point", pids: members.map((member) => member.pid) });
  assert.equal(observation.status, "complete", JSON.stringify(observation));
  for (const member of members) {
    const current = processMemberFromObservation(member.pid, observation);
    assert.ok(current.status === "departed" ||
      (current.status === "present" && current.member.processIdentity !== member.processIdentity),
    `exact idle-worker fixture process ${member.pid} survived managed stop`);
  }
  process.stdout.write(`${JSON.stringify({ mode, generation, observation })}\n`);
} else {
  assert.ok(["capture", "verify-exit", "verify-live"].includes(mode));
  const file = join(root, `processes-${generation}.json`);
  const records = readFileSync(join(root, "mcp-events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const started = records.filter((record) => record.event === "started");
  const expected = started[Number(generation) - 1];
  assert.ok(expected);
  // Recheck every earlier recorded generation before guardian cleanup, not
  // just the newest source. These points are not a full descendant census.
  const captured = mode === "capture" ? null : {
    members: Array.from({ length: Number(generation) }, (_, index) =>
      JSON.parse(readFileSync(join(root, `processes-${index + 1}.json`), "utf8")).members
        .map((member) => ({ ...member, generation: index + 1 })),
    ).flat(),
  };
  const pids = captured
    ? captured.members.map((member) => member.pid)
    : [expected.pid, expected.parentPid];
  const observation = await observeProcessMembers({ kind: "point", pids });
  process.stdout.write(`${JSON.stringify({ mode, generation, expectedMembers: captured?.members, observation })}\n`);
  assert.equal(observation.status, "complete", JSON.stringify(observation));
  if (mode === "capture") {
    const members = pids.map((pid) => {
      const current = processMemberFromObservation(pid, observation);
      assert.equal(current.status, "present");
      return current.member;
    });
    assert.equal(members[0].parentPid, members[1].pid);
    writeFileSync(file, JSON.stringify({ members, fixture: expected }), {
      flag: "wx", mode: 0o600,
    });
  } else {
    for (const member of captured.members) {
      const current = processMemberFromObservation(member.pid, observation);
      if (mode === "verify-live" && member.generation === Number(generation)) {
        assert.equal(current.status, "present");
        assert.equal(current.member.processIdentity, member.processIdentity,
          "backend replacement must retain the same native provider and MCP generations");
        continue;
      }
      assert.ok(
        current.status === "departed" ||
          (current.status === "present" && current.member.processIdentity !== member.processIdentity),
        `exact fixture process ${member.pid} survived managed stop`,
      );
    }
  }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessMembers, processMemberFromObservation } from "../../lib/process-identity.mjs";
import { managedRuntimeOperation } from "../lib/managed-runtime-rpc.mjs";

function reply(response, model, content, stopReason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const [index, block] of content.entries()) {
    send("content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    send("content_block_delta", { index, delta: block.type === "text" ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } });
  send("message_stop", {});
  response.end();
}

async function until(read, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Both real app ingress and the direct execution-side hook run the same
// native provider/Host scenario, within their existing QA owner's namespace.
export async function runNativeClaudeBackgroundWork({ ownerRoot, discoveryRoot, cli, runtime, claude,
  hookCommand, appHome, appChannel = "stable", evidenceRoot = ownerRoot, delayedCompletion = false }) {
  ownerRoot = fs.realpathSync(ownerRoot);
  discoveryRoot = fs.realpathSync(discoveryRoot);
  assert.ok(path.basename(ownerRoot).startsWith("dure-") && discoveryRoot.startsWith(`${ownerRoot}/`));
  assert.ok(appHome === undefined || fs.realpathSync(appHome).startsWith(`${ownerRoot}/`));
  const root = fs.mkdtempSync(path.join(ownerRoot, "claude-background-"));
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, "claude-background-evidence-"));
  const temporaryRoot = path.join(ownerRoot, "tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  for (const directory of ["home", "config", "dure"]) fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  const records = path.join(evidence, "hooks.jsonl");
  const heldStopPath = path.join(root, "held-stop.json");
  const recorder = path.join(root, "record-hook.mjs");
  fs.writeFileSync(recorder, `import fs from "node:fs";
import {spawnSync} from "node:child_process";
const raw=fs.readFileSync(0); const body=JSON.parse(raw);
const held=${JSON.stringify(delayedCompletion)} && body.hook_event_name === "Stop"
  && body.background_tasks?.length === 0 && body.session_crons?.length === 0 && !fs.existsSync(${JSON.stringify(heldStopPath)});
if(held)fs.writeFileSync(${JSON.stringify(heldStopPath)},raw,{flag:"wx",mode:0o600});
const result=held ? {status:0,signal:null} : spawnSync("/bin/sh",["-c",${JSON.stringify(hookCommand)}],{input:raw,env:process.env,timeout:3000});
fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({at:Date.now(),body,code:result.status,signal:result.signal,held})+"\\n",{mode:0o600});
process.exitCode=result.status ?? 1;
`, { flag: "wx", mode: 0o600 });
  const settings = path.join(root, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(
    ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification"].map(event => [event,
      [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(recorder)}`, timeout: 4 }] }]]),
  ) }), { flag: "wx", mode: 0o600 });
  const childReceipt = path.join(evidence, "provider-child.json");
  const bridge = path.join(root, "input-bridge.mjs");
  fs.writeFileSync(bridge, `import fs from "node:fs";
import {spawn} from "node:child_process";
const child=spawn(process.argv[2],process.argv.slice(3),{stdio:["pipe","pipe","pipe"]});
fs.writeFileSync(${JSON.stringify(childReceipt)},JSON.stringify({pid:child.pid,parentPid:process.pid}),{flag:"wx",mode:0o600});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on("error",()=>{});
child.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:"Delegate the isolated task and finish your parent response."}})+"\\n");
child.on("close",code=>{process.exitCode=code ?? 1;process.stdin.destroy();});
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on("data",bytes=>child.stdin.write(bytes.toString().replaceAll("\\r","\\n")));
`, { flag: "wx", mode: 0o600 });
  let held;
  let heldParent;
  let holdNewParent = false;
  let released = false;
  let parentCalls = 0;
  let childCalls = 0;
  const errors = [];
  const releaseChild = () => {
    if (!held || released) return;
    released = true;
    reply(held.response, held.model, [{ type: "text", text: "CHILD_FINISHED" }], "end_turn");
  };
  const releaseParent = () => {
    holdNewParent = false;
    if (heldParent && !heldParent.response.destroyed) {
      reply(heldParent.response, heldParent.model, [{ type: "text", text: "NEW_PARENT_FINISHED" }], "end_turn");
    }
    heldParent = undefined;
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", bytes => { raw += bytes; if (raw.length > 4 * 1024 * 1024) request.destroy(); });
    request.on("end", () => {
      try {
        if (request.url?.startsWith("/v1/messages/count_tokens")) {
          response.writeHead(200).end(JSON.stringify({ input_tokens: 1 }));
          return;
        }
        if (!request.url?.startsWith("/v1/messages")) { response.writeHead(200).end("{}"); return; }
        assert.equal(request.headers["x-api-key"], "qa-no-real-provider-access");
        const body = JSON.parse(raw);
        if (JSON.stringify(body.system).includes("DURE_NATIVE_BACKGROUND_CHILD_890")) {
          assert.equal(++childCalls, 1);
          held = { response, model: body.model };
          return;
        }
        if (holdNewParent) {
          assert.equal(heldParent, undefined);
          heldParent = { response, model: body.model };
          return;
        }
        if (++parentCalls === 1) {
          assert.ok(body.tools.some(tool => tool.name === "Agent"));
          reply(response, body.model, [{ type: "tool_use", id: "toolu_fixture_child", name: "Agent", input: {
            description: "Isolated background lifecycle", prompt: "Finish the isolated child task.",
            subagent_type: "fixture-child", run_in_background: true,
          } }], "tool_use");
        } else reply(response, body.model, [{ type: "text", text: "PARENT_FINISHED" }], "end_turn");
      } catch (error) {
        errors.push(error.message);
        response.writeHead(500).end("{}");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const environment = {
    PATH: "/usr/bin:/bin", HOME: path.join(root, "home"), DURE_HOME: appHome ?? path.join(root, "dure"),
    CLAUDE_CONFIG_DIR: path.join(root, "config"), HMUX_DISCOVERY_ROOT: discoveryRoot,
    CLAUDE_CODE_TMPDIR: temporaryRoot,
    DURE_APP_CHANNEL: appChannel, TMPDIR: temporaryRoot, TERM: "xterm-256color", LANG: "en_US.UTF-8", CI: "1",
    DURE_HMUX_TEST_STATE_ROOT: ownerRoot,
    ANTHROPIC_API_KEY: "qa-no-real-provider-access", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
  const readRecords = () => fs.existsSync(records) ? fs.readFileSync(records, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const command = args => JSON.parse(execFileSync(cli, ["--discovery-root", discoveryRoot, "--json", ...args],
    { env: environment, cwd: root, timeout: 10000, encoding: "utf8" }));
  const operation = (name, request) => managedRuntimeOperation({ runtime, cwd: root, environment }, name, request);
  const sessionId = `claude-background-${path.basename(root)}`;
  const workspaceId = "claude-background-workspace";
  try {
    const created = await operation("create", {
      schema: "hmux-managed-create-v1", schemaVersion: 1, idempotencyKey: sessionId,
      sessionId, workspaceId, providerId: "claude", permissionMode: "default", providerCwd: root,
      command: [process.execPath, bridge, claude, "--print", "--verbose", "--input-format", "stream-json",
        "--output-format", "stream-json", "--model", "claude-sonnet-4-6", "--tools", "Agent", "--allowedTools", "Agent",
        "--permission-mode", "dontAsk", "--no-chrome", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--settings", settings, "--system-prompt", "You are the isolated parent lifecycle fixture.", "--agents",
        JSON.stringify({ "fixture-child": { description: "Isolated child lifecycle", tools: [],
          prompt: "DURE_NATIVE_BACKGROUND_CHILD_890. Finish the fixture request." } })],
      initialRows: 40, initialColumns: 120,
    });
    fs.writeFileSync(path.join(evidence, "create.json"), JSON.stringify(created), { flag: "wx", mode: 0o600 });
    assert.equal(created.state, "completed", JSON.stringify(created));
    const session = command(["ls"]).find(item => item.session_id === sessionId);
    assert.ok(session);
    const snapshot = () => command(["session", "snapshot", sessionId, "--workspace", workspaceId]);
    const firstStop = await until(() => readRecords().find(record => record.body.hook_event_name === "Stop"), "Native parent Stop not observed");
    assert.equal(firstStop.code, 0);
    assert.ok(firstStop.body.background_tasks?.some(task => task.type === "subagent"));
    assert.equal(childCalls, 1);
    assert.equal(released, false);
    // Let both the completion-settlement deadline and the native Host event
    // loop run. A pre-settlement snapshot also passes on the broken reporter.
    await delay(2000);
    const working = snapshot();
    fs.writeFileSync(path.join(evidence, "parent-stop-snapshot.json"), JSON.stringify(working), { flag: "wx", mode: 0o600 });
    assert.equal(working.agentRuntimeState.activity, "working", "Parent Stop incorrectly published quiescence while child was active");
    const processReceipt = JSON.parse(fs.readFileSync(childReceipt));
    const pids = [processReceipt.pid, processReceipt.parentPid];
    const before = await observeProcessMembers({ kind: "point", pids });
    assert.equal(before.status, "complete");
    const members = pids.map(pid => {
      const observed = processMemberFromObservation(pid, before);
      assert.equal(observed.status, "present"); return observed.member;
    });
    assert.equal(members[0].parentPid, members[1].pid);
    fs.writeFileSync(path.join(evidence, "owned-provider-generations.json"), JSON.stringify(members), { flag: "wx", mode: 0o600 });
    const stop = (id, observed) => operation("stop", {
      schema: "hmux-managed-stop-v1", schemaVersion: 5, stopId: id, sessionId, workspaceId,
      expectedRunnerPrincipal: session.runner_principal, expectedRunnerInstance: session.runner_instance,
      expectedChannelEpoch: Number(session.channel_epoch), expectedHostInstanceId: session.host_instance_id,
      expectedTerminalEpoch: session.terminal_epoch,
      expectedQuiescence: { terminalEpoch: observed.agentRuntimeState.terminal_epoch,
        runtimeRevision: Number(observed.agentRuntimeState.revision), observedThroughOutputSeq: Number(observed.sequenceThrough) },
      expectedConversation: { providerId: "claude", conversationId: firstStop.body.session_id },
    });
    const protectedSnapshot = snapshot();
    assert.equal(protectedSnapshot.agentRuntimeState.activity, "working");
    const refused = await stop("background-child-must-stay-alive", protectedSnapshot);
    assert.equal(refused.state, "refused", JSON.stringify(refused));
    assert.equal(refused.payload.code, "hmux_managed_stop_unavailable");
    assert.equal(released, false);
    releaseChild();
    const lastStop = await until(() => readRecords().find(record => record.body.hook_event_name === "Stop"
      && record.body.background_tasks?.length === 0 && record.body.session_crons?.length === 0), "Final empty native registry not observed");
    assert.equal(lastStop.code, 0);
    let delayed;
    if (delayedCompletion) {
      assert.equal(lastStop.held, true);
      holdNewParent = true;
      const fence = Object.fromEntries(["workspace_id", "session_id", "runner_principal", "runner_instance",
        "channel_epoch", "host_instance_id", "terminal_epoch"].map(key => [key, session[key]]));
      command(["command-input", "--target", sessionId, "--workspace", workspaceId,
        "--expected-fence-json", JSON.stringify(fence), "--text", JSON.stringify({ type: "user",
          message: { role: "user", content: "Perform the next isolated parent turn." } }), "--submit"]);
      await until(() => heldParent, "New native parent model request not observed");
      const newPrompt = await until(() => readRecords().find(record => record.body.hook_event_name === "UserPromptSubmit"
        && record.at > lastStop.at), "New native UserPromptSubmit not observed");
      assert.equal(newPrompt.code, 0);
      assert.notEqual(newPrompt.body.prompt_id, lastStop.body.prompt_id);
      const beforeDelivery = snapshot();
      assert.equal(beforeDelivery.agentRuntimeState.activity, "working");
      const replayEnvironment = { ...environment, ...Object.fromEntries(Object.entries(fence)
        .map(([key, value]) => [`HMUX_${key.toUpperCase()}`, String(value)])) };
      execFileSync("/bin/sh", ["-c", hookCommand], { env: replayEnvironment, cwd: root,
        input: fs.readFileSync(heldStopPath), timeout: 3000 });
      await delay(2000);
      const afterDelivery = snapshot();
      const refusedNewWork = await stop("delayed-completion-must-not-stop-new-work", afterDelivery);
      const afterStop = await observeProcessMembers({ kind: "point", pids });
      delayed = { oldPromptId: lastStop.body.prompt_id, newPromptId: newPrompt.body.prompt_id,
        beforeDelivery, afterDelivery, refusedNewWork, before, afterStop, newModelResponseReleased: false };
      fs.writeFileSync(path.join(evidence, "delayed-completion.json"), JSON.stringify(delayed, null, 2), { flag: "wx", mode: 0o600 });
      assert.equal(afterDelivery.agentRuntimeState.activity, "working", "Delayed completion overrode a newer native turn");
      assert.equal(refusedNewWork.state, "refused", JSON.stringify(refusedNewWork));
      assert.equal(refusedNewWork.payload.code, "hmux_managed_stop_unavailable");
      releaseParent();
      await until(() => readRecords().find(record => record.body.hook_event_name === "Stop"
        && record.body.prompt_id === newPrompt.body.prompt_id && record.code === 0), "New native turn did not complete");
    }
    const settled = await until(() => { const value = snapshot(); return value.agentRuntimeState.activity === "waiting" && value; }, "Host did not settle after child completion");
    assert.equal(settled.agentRuntimeState.turn_completed_count, "1");
    assert.ok(readRecords().every(record => record.code === 0));
    const stopped = await stop("background-complete-release", settled);
    assert.equal(stopped.state, "completed", JSON.stringify(stopped));
    assert.equal(stopped.payload.outcome, "stopped");
    const after = await until(async () => {
      const point = await observeProcessMembers({ kind: "point", pids });
      if (point.status !== "complete") return false;
      return members.every(member => {
        const observed = processMemberFromObservation(member.pid, point);
        return observed.status === "departed" || (observed.status === "present" && observed.member.processIdentity !== member.processIdentity);
      }) && point;
    }, "Owned native provider survived product stop");
    assert.deepEqual(errors, []);
    const result = { ok: true, sourceRoot: root, evidence, parentCalls, childCalls, working, protectedSnapshot, refused, settled, stopped, delayed,
      before, after, claudeSha256: digest(claude), runtimeSha256: digest(runtime), realCredentialsUsed: false,
      caveat: "Actual native Claude and Hmux provider release before guardian cleanup. Loopback model, disposable data; not natural24h or authenticated provider proof." };
    fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence, parentCalls, childCalls, releasedOwnedProcesses: members.length }));
    return result;
  } finally {
    releaseChild();
    releaseParent();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // The surrounding existing QA guardian owns exact Host cleanup on failure.
    // Keep all evidence and do not add a second numeric-PID cleanup writer.
  }
}

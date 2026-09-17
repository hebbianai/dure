import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeRegistry } from "./lib/dure-session-test-fixture.mjs";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const structuredProfile = { schemaVersion: 1, kind: "structured_protocol", backendProfileId: "local", interactionSessionId: "interaction-1" };

async function fixture({ refused = false, structured = false, wrongReceipt = false, panelId = "agent:agent-1", lostResponse = false, omitPaneId = false, inputPatch = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-send-input-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ path: request.url, authorization: request.headers.authorization, payload });
    if (lostResponse) { response.destroy(); return; }
    response.writeHead(refused ? 409 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(refused
      ? { ok: false, error: { code: "stale_generation", message: "stale_generation" } }
      : structured ? { ok: true, input: {
        agentId: "agent-1", name: "worker", ...(omitPaneId ? {} : { panelId }),
        sessionId: wrongReceipt ? "wrong-interaction" : "interaction-1", enter: payload.enter,
        byteLength: Buffer.byteLength(payload.text, "utf8") + Number(payload.enter),
        receipt: { kind: "structured_chat", delivery: payload.enter ? "sent" : "drafted" },
        ...inputPatch,
      } } : { ok: true, input: {
        sessionId: "session-1", workspaceId: "workspace-1",
        receipt: { terminalEpoch: "epoch-1",
          text: { recordId: "41", state: "written_to_pty" },
          submit: payload.enter ? { recordId: "42", state: "written_to_pty" } : null },
      } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(root, "server.json"), JSON.stringify({ port: server.address().port, token: "fixture-token" }));
  writeRegistry(root, [{ id: "agent-1", name: "worker", project: "fixture", sessionId: "session-1",
    ...(structured ? { interactionProfile: structuredProfile } : {
      runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local",
        sessionId: "session-1", workspaceId: "workspace-1" },
    }) }]);
  const run = (args, stdin = "") => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "send", ...args], {
      env: { PATH: process.env.PATH, HOME: root, DURE_HOME: root,
        DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: join(root, "no-hmux"),
        HMUX_DISCOVERY_ROOT: join(root, "discovery") },
      stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
  return { root, run, requests };
}

describe("scriptable dure send input", () => {
  it.each([true, false])("routes structured chat through the app broker with enter=%s", async (enter) => {
    const { run, requests } = await fixture({ structured: true });
    const text = "  캡처 설명\n검토 후 수정해 주세요.\n";
    const result = await run(["worker", "--stdin", "--json", "--idempotency-key", "chat-input-1", "--window-label", "win-100-2", ...(enter ? [] : ["--no-enter"])], text);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual([{ path: "/agent/input", authorization: "Bearer fixture-token", payload: {
      name: "agent-1", sessionId: "session-1",
      expectedInteractionProfile: structuredProfile, text, enter,
      idempotencyKey: "chat-input-1", windowLabel: "win-100-2",
    } }]);
    expect(JSON.parse(result.stdout)).toEqual({ apiVersion: "dure.send/v1", ok: true,
      target: { agentId: "agent-1", sessionId: "interaction-1" },
      receipt: { kind: "structured_chat", delivery: enter ? "sent" : "drafted" },
    });
    expect(result.stdout).not.toContain(text);
  });

  it.each(["pane:stable-slot", "launcher:previous", "agent:previous"])("accepts the actual draft pane receipt %s without guessing a pane target", async (panelId) => {
    const { run, requests } = await fixture({ structured: true, panelId });
    const result = await run(["worker", "draft", "--no-enter", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).not.toHaveProperty("targetPanelId");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, receipt: { delivery: "drafted" } });
  });

  it.each(["sent", "steered", "queued"].flatMap(delivery =>
    ["pane:stable-slot", "launcher:previous", "agent:previous", undefined].map(panelId => ({ delivery, panelId })),
  ))("accepts $delivery for the selected conversation independently of pane metadata ($panelId)", async ({ delivery, panelId }) => {
    const { run, requests } = await fixture({ structured: true, panelId, omitPaneId: panelId === undefined,
      inputPatch: { receipt: { kind: "structured_chat", delivery } },
    });
    const result = await run(["worker", "hello", "--json", "--idempotency-key", "submit-1"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).not.toHaveProperty("targetPanelId");
    expect(requests[0].payload).toMatchObject({ name: "agent-1", expectedInteractionProfile: structuredProfile, idempotencyKey: "submit-1", enter: true });
    expect(JSON.parse(result.stdout)).toEqual({ apiVersion: "dure.send/v1", ok: true,
      target: { agentId: "agent-1", sessionId: "interaction-1" },
      receipt: { kind: "structured_chat", delivery },
    });
  });

  it.each([
    { agentId: "other-agent" },
    { sessionId: "other-conversation" },
    { enter: false },
    { byteLength: 0 },
    { receipt: { kind: "terminal", delivery: "sent" } },
    { receipt: { kind: "structured_chat", delivery: "drafted" } },
    { receipt: { kind: "structured_chat", delivery: "unknown" } },
  ])("does not accept a mismatched submitted receipt or retry it: %j", async (inputPatch) => {
    const { run, requests } = await fixture({ structured: true, inputPatch });
    const result = await run(["worker", "hello", "--json", "--idempotency-key", "submit-conflict"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("structured input receipt");
    expect(result.stderr).toContain("submit-conflict");
    expect(requests).toHaveLength(1);
  });

  it.each([undefined, null, "", 42])("refuses a missing or malformed draft pane receipt %s without retry", async (panelId) => {
    const { run, requests } = await fixture({ structured: true, panelId, omitPaneId: panelId === undefined });
    const result = await run(["worker", "draft", "--no-enter", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("structured input receipt");
    expect(requests).toHaveLength(1);
  });

  it.each([true, false])("does not retry uncertain structured input after the HTTP response is lost (enter=%s)", async (enter) => {
    const { run, requests } = await fixture({ structured: true, lostResponse: true });
    const result = await run(["worker", "message", ...(enter ? [] : ["--no-enter"]), "--json", "--idempotency-key", "lost-receipt"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("lost-receipt");
    expect(requests).toHaveLength(1);
  });

  it("reports an uncertain structured receipt without retrying or claiming success", async () => {
    const { run, requests } = await fixture({ structured: true, wrongReceipt: true });
    const result = await run(["worker", "draft", "--no-enter", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("structured input receipt");
    expect(requests).toHaveLength(1);
  });

  it("retains a structured broker refusal without retrying", async () => {
    const { run, requests } = await fixture({ structured: true, refused: true });
    const result = await run(["worker", "draft", "--no-enter", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stale_generation");
    expect(requests).toHaveLength(1);
  });

  it.each(["file", "stdin"])("preserves exact %s text and emits a delivery receipt", async (source) => {
    const { root, run, requests } = await fixture();
    const text = "\uFEFF  한글 👋\r\n--help --no-enter\n$HOME `literal`\n\n";
    const file = join(root, "prompt.txt");
    writeFileSync(file, text);
    const args = source === "file" ? ["--file", file] : ["--stdin"];
    const result = await run(["worker", ...args, "--json", "--idempotency-key", "send-1"], text);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual([{ path: "/hmux/input", authorization: "Bearer fixture-token", payload: {
      target: { schemaVersion: 1, targetPanelId: "agent:agent-1", hostId: "local",
        sessionId: "session-1", workspaceId: "workspace-1" },
      text, enter: true, idempotencyKey: "send-1",
    } }]);
    expect(JSON.parse(result.stdout)).toEqual({ apiVersion: "dure.send/v1", ok: true,
      target: { agentId: "agent-1", sessionId: "session-1", workspaceId: "workspace-1" },
      receipt: { terminalEpoch: "epoch-1", text: { recordId: "41", state: "written_to_pty" },
        submit: { recordId: "42", state: "written_to_pty" } },
    });
    expect(result.stdout).not.toContain("literal");
  });

  it("does not submit or trim whitespace with --no-enter", async () => {
    const { run, requests } = await fixture();
    const result = await run(["worker", "--stdin", "--no-enter", "--json"], " \n\t");
    expect(result.code).toBe(0);
    expect(requests[0].payload).toMatchObject({ text: " \n\t", enter: false });
    expect(JSON.parse(result.stdout).receipt.submit).toBeNull();
  });

  it.each([
    ["--stdin", "literal"], ["--file", "missing", "literal"],
    ["--stdin", "--file", "missing"], ["--stdin", "--stdin"],
    ["--file", "first", "--file", "second"], ["--file"],
    ["--file", "--json"],
  ])("rejects conflicting or missing sources before delivery: %j", async (...args) => {
    const { run, requests } = await fixture();
    const result = await run(["worker", ...args], "input");
    expect(result.code).not.toBe(0);
    expect(requests).toEqual([]);
  });

  it.each(["", Buffer.from([0xff]), "a".repeat(64 * 1024 + 1)])(
    "rejects empty, invalid UTF-8, or oversized stdin without delivering a prefix",
    async (input) => {
      const { run, requests } = await fixture();
      const result = await run(["worker", "--stdin"], input);
      expect(result.code).not.toBe(0);
      expect(requests).toEqual([]);
    },
  );

  it("preserves literal source-option names after --", async () => {
    const { run, requests } = await fixture();
    const result = await run(["worker", "--", "--stdin", "--file", "--json"]);
    expect(result.code).toBe(0);
    expect(requests[0].payload.text).toBe("--stdin --file --json");
  });

  it.each(["missing", "directory", "invalid-utf8", "oversized", "empty"])(
    "rejects a %s file without contacting the input broker", async (kind) => {
      const { root, run, requests } = await fixture();
      const file = kind === "directory" ? root : join(root, "prompt.txt");
      if (kind === "invalid-utf8") writeFileSync(file, Buffer.from([0xff]));
      if (kind === "oversized") writeFileSync(file, "한".repeat(22_000));
      if (kind === "empty") writeFileSync(file, "");
      const result = await run(["worker", "--file", file]);
      expect(result.code).not.toBe(0);
      expect(requests).toEqual([]);
    },
  );

  it("accepts exactly 64 KiB without silently truncating input", async () => {
    const { run, requests } = await fixture();
    const text = "a".repeat(64 * 1024);
    const result = await run(["worker", "--stdin", "--no-enter"], text);
    expect(result.code).toBe(0);
    expect(requests[0].payload.text).toBe(text);
  });

  it("does not turn a refused delivery into success or retry it", async () => {
    const { run, requests } = await fixture({ refused: true });
    const result = await run(["worker", "--stdin", "--json"], "hello");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stale_generation");
    expect(requests).toHaveLength(1);
  });
});

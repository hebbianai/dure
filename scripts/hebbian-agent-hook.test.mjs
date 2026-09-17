import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const hook = path.resolve("cli/hebbian-agent-hook.py");
const temporaryHomes = [];
const HOOK_FIXTURE_TIMEOUT_MS = 10_000;
const HOOK_SUBPROCESS_TIMEOUT_MS = 5_000;

async function hookPayload(extraEnvironment) {
  const home = await mkdtemp(path.join(tmpdir(), "hebbian-hook-test-"));
  temporaryHomes.push(home);
  await mkdir(path.join(home, ".dure"));

  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(204).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await writeFile(
    path.join(home, ".dure", "server.json"),
    JSON.stringify({ port: address.port, reportToken: "test-report-token" }),
  );

  const child = spawn("python3", [hook, "codex", "Stop", "--terminal-events"], {
    env: scriptTestEnvironment({
      HOME: home,
      HMUX: "1",
      HMUX_SESSION_ID: "session-1",
      ...extraEnvironment,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: "conversation+1",
    }),
  );
  const stderr = [];
  const stdout = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  let timedOut = false;
  const childTimeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, HOOK_SUBPROCESS_TIMEOUT_MS);
  const [code] = await once(child, "close");
  clearTimeout(childTimeout);
  const serverClosed = once(server, "close");
  server.close();
  server.closeIdleConnections();
  await serverClosed;
  if (timedOut) {
    throw new Error(
      `hook fixture subprocess timed out after ${HOOK_SUBPROCESS_TIMEOUT_MS}ms`,
    );
  }
  if (code !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
  return {
    payload: requests.find((request) => request.path === "/hooks")?.payload,
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true })),
  );
});

describe("hebbian agent hook Hmux fence forwarding", () => {
  it(
    "forwards one complete inherited Host fence",
    async () => {
      const { payload, stdout } = await hookPayload({
        HMUX_SESSION_ID: "session+1",
        HMUX_WORKSPACE_ID: "workspace+1",
        HMUX_RUNNER_PRINCIPAL: "local-user",
        HMUX_RUNNER_INSTANCE: "runner-1",
        HMUX_CHANNEL_EPOCH: "2",
        HMUX_HOST_INSTANCE_ID: "host-1",
        HMUX_TERMINAL_EPOCH: "terminal-1",
      });

      expect(payload.sessionFence).toEqual({
        workspaceId: "workspace+1",
        sessionId: "session+1",
        runnerPrincipal: "local-user",
        runnerInstance: "runner-1",
        channelEpoch: "2",
        hostInstanceId: "host-1",
        terminalEpoch: "terminal-1",
      });
      expect(payload.conversationId).toBe("conversation+1");
      expect(payload).toMatchObject({
        state: "done",
        event: "Stop",
        provider: "codex",
        terminalEvents: true,
      });
      expect(stdout).toBe("{}\n");
    },
    HOOK_FIXTURE_TIMEOUT_MS,
  );

  it(
    "marks a partial current fence malformed instead of downgrading it",
    async () => {
      const { payload } = await hookPayload({
        HMUX_WORKSPACE_ID: "workspace-1",
        HMUX_TERMINAL_EPOCH: "terminal-1",
      });

      expect(payload).toHaveProperty("sessionFence", null);
    },
    HOOK_FIXTURE_TIMEOUT_MS,
  );

  it(
    "omits the fence only for a Host with no generation environment",
    async () => {
      const { payload } = await hookPayload({
        HMUX_WORKSPACE_ID: "workspace-1",
      });

      expect(payload).not.toHaveProperty("sessionFence");
    },
    HOOK_FIXTURE_TIMEOUT_MS,
  );
});

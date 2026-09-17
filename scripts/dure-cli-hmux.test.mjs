import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function isolatedEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.DURE_APP_CHANNEL;
  delete environment.DURE_HOME;
  delete environment.DURE_HMUX_BIN;
  delete environment.HEBBIAN_APP_CHANNEL;
  delete environment.HEBBIAN_HMUX_BIN;
  return { ...environment, ...overrides };
}

// Like isolatedEnvironment, but with the color toggles removed so the CLI
// renders its plain human-readable output.
function colorCapableEnvironment(overrides = {}) {
  const environment = isolatedEnvironment(overrides);
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  return environment;
}

// Starts a disposable app-server fixture (closed by afterEach) and returns
// the TCP port it listens on.
async function startAppServer(handle) {
  const server = createServer(handle);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server has no TCP port");
  }
  return address.port;
}

// Wraps a request handler so it runs with the fully accumulated UTF-8 body.
function withBody(handle) {
  return (incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", () => handle(incoming, response, body));
  };
}

function respondJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

// The method/url/authorization identity of a broker request.
function requestIdentity(incoming) {
  return {
    method: incoming.method,
    url: incoming.url,
    authorization: incoming.headers.authorization,
  };
}

// Creates an isolated HOME with a ~/.dure directory, registered for cleanup.
function isolatedHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(home);
  const dureDir = join(home, ".dure");
  mkdirSync(dureDir, { recursive: true });
  return { home, dureDir };
}

function writeServerConfig(directory, port, token, capabilities) {
  writeFileSync(
    join(directory, "server.json"),
    JSON.stringify({
      port,
      token,
      ...(capabilities ? { capabilities } : {}),
    }),
  );
}

// Isolated HOME whose ~/.dure/server.json points at the fixture server.
function homeWithServer(prefix, port, token, capabilities) {
  const { home, dureDir } = isolatedHome(prefix);
  writeServerConfig(dureDir, port, token, capabilities);
  return { home, dureDir };
}

// Registry with one managed agent bound to an exact local Hmux runtime.
function writeManagedAgentRegistry(directory, agentOverrides = {}) {
  writeFileSync(
    join(directory, "agents.json"),
    JSON.stringify({
      agents: [
        {
          id: "agent-1",
          name: "hebbian-frontend",
          project: "HebbianIDE",
          provider: "codex",
          sessionId: "managed-session-1",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source: "local",
            hostId: "local",
            sessionId: "managed-session-1",
            workspaceId: "workspace-1",
          },
          ...agentOverrides,
        },
      ],
    }),
  );
}

describe("Dure Hmux IDE CLI", () => {
  it.each([
    [
      "canonical Dure input",
      {
        DURE_APP_CHANNEL: "dev-feature-a1b2c3d4",
        HEBBIAN_APP_CHANNEL: "dev-legacy-decoy-a1b2c3d4",
      },
    ],
    [
      "legacy fallback",
      { HEBBIAN_APP_CHANNEL: "dev-feature-a1b2c3d4" },
    ],
  ])(
    "routes a development channel through %s",
    async (_label, channelEnvironment) => {
      let request;
      const port = await startAppServer((incoming, response) => {
        request = requestIdentity(incoming);
        respondJson(response, {
          ok: true,
          pane: {
            desktopId: "desktop-dev",
            panelId: "term:dev",
            sessionId: "session-dev",
            workspaceId: "workspace-dev",
          },
        });
      });

      const { home, dureDir } = isolatedHome("dure-cli-channel-");
      const channelDir = join(dureDir, "channels", "dev-feature-a1b2c3d4");
      mkdirSync(channelDir, { recursive: true });
      writeServerConfig(dureDir, 1, "stable-decoy");
      writeServerConfig(channelDir, port, "dev-token");

      const result = await runCli(
        ["hmux", "attach", "--name", "dev-session"],
        isolatedEnvironment({
          HOME: home,
          ...channelEnvironment,
        }),
      );

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("desktop-dev/term:dev");
      expect(request).toEqual({
        method: "POST",
        url: "/hmux/attach",
        authorization: "Bearer dev-token",
      });
    },
  );

  it("attaches by exact name without reading the agent registry", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          pane: {
            desktopId: "desktop-1",
            panelId: "term:standalone-1",
            sessionId: "standalone-1",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer("hebbian-cli-hmux-", port, "test-token");
    const result = await runCli(
      ["hmux", "attach", "--name", "hmux-spawn-reliability"],
      colorCapableEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "hmux-spawn-reliability → desktop-1/term:standalone-1",
    );
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/attach",
      authorization: "Bearer test-token",
      body: { name: "hmux-spawn-reliability" },
    });
  });

  it("targets a canonical Space while sending an equal legacy alias", async () => {
    const requests = [];
    const port = await startAppServer(
      withBody((_incoming, response, body) => {
        requests.push(JSON.parse(body));
        respondJson(response, {
          ok: true,
          pane: {
            spaceId: "space-a",
            desktopId: "space-a",
            panelId: "term:standalone-a",
            sessionId: "standalone-a",
            workspaceId: "workspace-a",
          },
        });
      }),
    );

    const { home } = homeWithServer("dure-cli-hmux-space-", port, "space-token");
    const result = await runCli(
      ["hmux", "attach", "--name", "space-session", "--space-id", "space-a"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("space-a/term:standalone-a");
    expect(requests).toEqual([
      {
        name: "space-session",
        spaceId: "space-a",
        desktopId: "space-a",
      },
    ]);

    const conflict = await runCli(
      [
        "hmux",
        "attach",
        "--name",
        "space-session",
        "--space-id",
        "space-a",
        "--desktop-id",
        "space-b",
      ],
      isolatedEnvironment({ HOME: home }),
    );
    expect(conflict.code).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it.each(["status", "--help", "-h"])("sends %s through the authenticated semantic app broker", async (text) => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          input: {
            sessionId: "managed-session-1",
            workspaceId: "workspace-1",
            receipt: {
              terminalEpoch: "terminal-epoch-1",
              text: { recordId: "9", state: "written_to_pty" },
              submit: { recordId: "10", state: "written_to_pty" },
            },
          },
        });
      }),
    );

    const { home, dureDir } = homeWithServer(
      "hebbian-cli-hmux-send-",
      port,
      "managed-token",
    );
    writeManagedAgentRegistry(dureDir);

    const result = await runCli(
      ["send", "hebbian-frontend", text],
      colorCapableEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("receipt 10");
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/input",
      authorization: "Bearer managed-token",
      body: {
        target: {
          schemaVersion: 1,
          targetPanelId: "agent:agent-1",
          hostId: "local",
          sessionId: "managed-session-1",
          workspaceId: "workspace-1",
        },
        text,
        enter: true,
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
    });
  });

  it("does not retry after the app claims semantic input and times out", async () => {
    const requests = [];
    const port = await startAppServer(
      withBody((_incoming, response, body) => {
        requests.push(JSON.parse(body));
        respondJson(
          response,
          {
            ok: false,
            error: {
              code: "frontend_timeout",
              deliveryState: "claimed",
              requestId: "input_retry-safe-1",
              message: "HebbianIDE claimed but did not complete the pane request",
            },
          },
          504,
        );
      }),
    );

    const { home, dureDir } = homeWithServer(
      "hebbian-cli-hmux-send-retry-",
      port,
      "managed-token",
    );
    writeManagedAgentRegistry(dureDir);

    const result = await runCli(
      [
        "send",
        "hebbian-frontend",
        "status",
        "--idempotency-key",
        "retry-safe-1",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "HebbianIDE claimed but did not complete the pane request",
    );
    expect(result.stderr).toContain("idempotency key: retry-safe-1");
    expect(requests).toEqual([
      {
        target: {
          schemaVersion: 1,
          targetPanelId: "agent:agent-1",
          hostId: "local",
          sessionId: "managed-session-1",
          workspaceId: "workspace-1",
        },
        text: "status",
        enter: true,
        idempotencyKey: "retry-safe-1",
      },
    ]);
  });

  it("does not retry a dropped semantic-input response", async () => {
    const requests = [];
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        requests.push(JSON.parse(body));
        if (requests.length === 1) {
          incoming.socket.destroy();
          return;
        }
        respondJson(response, {
          ok: true,
          input: {
            receipt: {
              requestId: "controller-input-after-drop",
              controllerGeneration: "3",
              state: "written_to_pty",
            },
          },
        });
      }),
    );

    const { home, dureDir } = homeWithServer(
      "hebbian-cli-hmux-send-drop-",
      port,
      "managed-token",
    );
    writeManagedAgentRegistry(dureDir);

    const result = await runCli(
      [
        "send",
        "hebbian-frontend",
        "status",
        "--idempotency-key",
        "dropped-response-1",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("idempotency key: dropped-response-1");
    expect(requests).toHaveLength(1);
    expect(requests[0].idempotencyKey).toBe("dropped-response-1");
  });

  it("routes an SSH Hmux Agent through the same exact pane API instead of legacy SSH send", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = {
          url: incoming.url,
          authorization: incoming.headers.authorization,
          body: JSON.parse(body),
        };
        respondJson(response, {
          ok: true,
          input: {
            hostId: "host-remote",
            sessionId: "remote-session-1",
            workspaceId: "remote-workspace-1",
            receipt: {
              terminalEpoch: "remote-terminal-epoch-1",
              text: { recordId: "41", state: "written_to_pty" },
              submit: { recordId: "42", state: "written_to_pty" },
            },
          },
        });
      }),
    );

    const { home, dureDir } = homeWithServer(
      "dure-cli-hmux-remote-send-",
      port,
      "remote-token",
    );
    writeManagedAgentRegistry(dureDir, {
      id: "agent-remote",
      name: "remote-codex",
      project: "Remote",
      provider: "codex",
      kind: "ssh",
      sessionId: "remote-session-1",
      remoteTmux: "legacy-decoy",
      runtimeBinding: {
        runtime: "hmux_managed_v1",
        source: "ssh",
        hostId: "host-remote",
        sessionId: "remote-session-1",
        workspaceId: "remote-workspace-1",
        createIdempotencyKey: "create-remote-1",
        commandBridgeNonce: "bridge-remote",
      },
    });

    const result = await runCli(
      ["send", "remote-codex", "status"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("receipt 42");
    expect(request).toEqual({
      url: "/hmux/input",
      authorization: "Bearer remote-token",
      body: {
        target: {
          schemaVersion: 1,
          targetPanelId: "agent:agent-remote",
          hostId: "host-remote",
          sessionId: "remote-session-1",
          workspaceId: "remote-workspace-1",
        },
        text: "status",
        enter: true,
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
    });
  });

  it("refuses non-interactive hmux stop without --yes and sends no request", async () => {
    let requested = false;
    const port = await startAppServer((_incoming, response) => {
      requested = true;
      respondJson(response, { ok: true });
    });

    const { home } = homeWithServer("hebbian-cli-hmux-stop-", port, "stop-token");
    // runCli는 stdin을 ignore로 열기 때문에 비대화형 경로가 실행된다.
    const result = await runCli(
      ["hmux", "stop", "--name", "victim"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--yes");
    expect(requested).toBe(false);
  });

  it("confirms hmux stop with --yes by sending confirm to the destructive route", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { url: incoming.url, body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          agent: { name: "victim" },
          stop: {
            outcome: "stopped",
            sessionId: "session-1",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "hebbian-cli-hmux-stop-yes-",
      port,
      "stop-token",
    );
    const result = await runCli(
      ["hmux", "stop", "--name", "victim", "--yes"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(request).toEqual({
      url: "/hmux/stop",
      body: { name: "victim", confirm: true },
    });
  });

  it("reports exact cleanup when the managed provider already exited", async () => {
    const port = await startAppServer((incoming, response) => {
      incoming.resume();
      incoming.on("end", () => {
        respondJson(response, {
          ok: true,
          agent: { name: "dure-orch" },
          cleanup: {
            outcome: "cleaned",
            sourceState: "retired",
            sessionId: "agent-old",
            workspaceId: "workspace-1",
          },
        });
      });
    });

    const { home } = homeWithServer(
      "dure-cli-hmux-cleanup-exited-",
      port,
      "cleanup-token",
    );
    const result = await runCli(
      ["hmux", "stop", "--name", "agent-old", "--yes"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("dure-orch exited registration cleaned");
    expect(result.stdout).toContain("retired, agent-old, workspace-1");
  });

  it("adopts an exact legacy terminal without overloading an Agent name", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          adoption: {
            outcome: "adopted",
            conversationId: "11111111-2222-4333-8444-555555555555",
          },
          pane: {
            desktopId: "desktop-1",
            panelId: "agent:agent-hmux-deadbeef",
            sessionId: "hmux_recovery_deadbeef",
            workspaceId: "project-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "dure-cli-legacy-terminal-",
      port,
      "adopt-token",
    );
    const result = await runCli(
      [
        "hmux",
        "adopt",
        "--from-session",
        "term-legacy-cli",
        "--target-panel-id",
        "term:term-legacy-cli",
        "--provider",
        "claude",
        "--agent-name",
        "legacy-claude",
        "--confirm-restart",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("term-legacy-cli");
    expect(result.stdout).toContain("conversation 11111111");
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/adopt",
      authorization: "Bearer adopt-token",
      body: {
        name: "",
        targetPanelId: "term:term-legacy-cli",
        agentName: "legacy-claude",
        sourceSessionId: "term-legacy-cli",
        providerId: "claude",
        confirmRestart: true,
      },
    });
  });

  it("rehosts a managed Agent with an exact pane and restart confirmation", async () => {
    let request;
    const conversationId = "019fa342-4698-78b2-a47d-784690b3c756";
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          rehost: {
            outcome: "rehosted",
            conversationId,
          },
          pane: {
            desktopId: "desktop-1",
            panelId: "agent:agent-1",
            sessionId: "hmux_recovery_1234",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "hebbian-cli-hmux-rehost-",
      port,
      "rehost-token",
    );
    const result = await runCli(
      [
        "hmux",
        "rehost",
        "--name",
        "HebbianIDE/hebbian-frontend",
        "--target-panel-id",
        "agent:agent-1",
        "--conversation-id",
        conversationId,
        "--operation-id",
        "fix_main_stalled_output_20260813_v1",
        "--confirm-restart",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("rehosted");
    expect(result.stdout).toContain(`conversation ${conversationId}`);
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/rehost",
      authorization: "Bearer rehost-token",
      body: {
        name: "HebbianIDE/hebbian-frontend",
        targetPanelId: "agent:agent-1",
        conversationId,
        operationId: "fix_main_stalled_output_20260813_v1",
        confirmRestart: true,
      },
    });
  });

  it.each([
    [["--confirm-restart"], "rehost_name_projection_unavailable"],
    [["--operation-id", "existing-operation"], "rehost_backend_execution_unavailable"],
    [["--fresh", "--confirm-restart"], "rehost_backend_execution_unavailable"],
    [["--permission-mode", "default"], "rehost_backend_execution_unavailable"],
  ])("does not route backend-selected rehost options %j into the app authority", async (extra, expectedError) => {
    let requests = 0;
    const port = await startAppServer((_incoming, response) => {
      requests++;
      respondJson(response, { ok: false, error: { message: "wrong authority" } });
    });
    const { home } = homeWithServer("dure-rehost-route-", port, "fixture-token");
    const result = await runCli(
      ["hmux", "rehost", "--name", "worker", "--backend", "another-backend", ...extra],
      isolatedEnvironment({ HOME: home }),
    );
    expect(result.code).toBe(1);
    expect(requests).toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it("reports a committed rehost while pane projection is still converging", async () => {
    const conversationId = "019fa342-4698-78b2-a47d-784690b3c756";
    const port = await startAppServer((_incoming, response) => {
      respondJson(response, {
        ok: true,
        rehost: {
          outcome: "rehosted",
          presentation: "pending",
          conversationId,
          replacementSession: {
            sessionId: "hmux_recovery_1234",
            workspaceId: "workspace-1",
          },
        },
      });
    });

    const { home } = homeWithServer(
      "hebbian-cli-hmux-rehost-pending-",
      port,
      "rehost-pending-token",
    );
    const result = await runCli(
      [
        "hmux",
        "rehost",
        "--name",
        "HebbianIDE/hebbian-frontend",
        "--target-panel-id",
        "agent:agent-1",
        "--confirm-restart",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("runtime rehost committed");
    expect(result.stdout).toContain("pane projection pending");
    expect(result.stdout).toContain("hmux_recovery_1234, workspace-1");
    expect(result.stdout).toContain(`conversation ${conversationId}`);
  });

  it("requests an explicit fresh managed replacement without conversation identity", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          rehost: {
            action: "replace_ai_provider_with_fresh_conversation",
            outcome: "rehosted_fresh",
          },
          pane: {
            desktopId: "desktop-1",
            panelId: "agent:agent-1",
            sessionId: "session-fresh",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "dure-cli-hmux-fresh-rehost-",
      port,
      "fresh-rehost-token",
    );
    const result = await runCli(
      [
        "hmux",
        "rehost",
        "--name",
        "generation-conflict",
        "--target-panel-id",
        "agent:agent-1",
        "--fresh",
        "--confirm-restart",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("rehosted_fresh");
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/rehost",
      authorization: "Bearer fresh-rehost-token",
      body: {
        name: "generation-conflict",
        targetPanelId: "agent:agent-1",
        freshStart: true,
        confirmRestart: true,
      },
    });
  });

  it("relaunches a managed Agent permission mode through the versioned rehost receipt", async () => {
    let request;
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body: JSON.parse(body) };
        respondJson(response, {
          ok: true,
          permissionModeRelaunch: {
            schema: "dure-agent-permission-mode-relaunch-v1",
            schemaVersion: 1,
            outcome: "relaunched",
            currentMode: "default",
            targetMode: "skip_permissions",
            restartImpact: "provider_process_restarted",
            sourceSessionId: "session-old",
            sourceWorkspaceId: "workspace-1",
            targetSessionId: "session-new",
            replayed: false,
          },
          pane: {
            desktopId: "desktop-1",
            panelId: "agent:agent-1",
            sessionId: "session-new",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "dure-cli-permission-relaunch-",
      port,
      "permission-token",
    );
    const result = await runCli(
      [
        "hmux",
        "rehost",
        "--name",
        "HebbianIDE/hebbian-frontend",
        "--target-panel-id",
        "agent:agent-1",
        "--permission-mode",
        "skip_permissions",
        "--confirm-restart",
        "--json",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "dure-agent-permission-mode-relaunch-v1",
      schemaVersion: 1,
      outcome: "relaunched",
      currentMode: "default",
      targetMode: "skip_permissions",
    });
    expect(request).toEqual({
      method: "POST",
      url: "/hmux/rehost",
      authorization: "Bearer permission-token",
      body: {
        name: "HebbianIDE/hebbian-frontend",
        targetPanelId: "agent:agent-1",
        permissionMode: "skip_permissions",
        confirmRestart: true,
      },
    });
  });

  it("forwards an exact existing managed writer handoff without restart authority", async () => {
    let request;
    const conversationId = "019fa9b6-9907-70f2-877b-5f07907bd2ba";
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = {
          url: incoming.url,
          authorization: incoming.headers.authorization,
          body: JSON.parse(body),
        };
        respondJson(response, {
          ok: true,
          rehost: {
            outcome: "existing_writer_handoff",
            conversationId,
          },
          pane: {
            desktopId: "desktop-1",
            panelId: "agent:agent-1",
            sessionId: "session-existing",
            workspaceId: "workspace-1",
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "dure-cli-hmux-handoff-",
      port,
      "handoff-token",
    );
    const result = await runCli(
      [
        "hmux",
        "rehost",
        "--name",
        "HebbianIDE/uiux-scroll-probe",
        "--target-panel-id",
        "agent:agent-1",
        "--conversation-id",
        conversationId,
        "--existing-session",
        "session-existing",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("existing_writer_handoff");
    expect(request).toEqual({
      url: "/hmux/rehost",
      authorization: "Bearer handoff-token",
      body: {
        name: "HebbianIDE/uiux-scroll-probe",
        targetPanelId: "agent:agent-1",
        conversationId,
        existingSessionId: "session-existing",
      },
    });
  });

  it("previews an Hmux class conversion without restart confirmation", async () => {
    let request;
    const conversationId = "019fa9b6-9907-70f2-877b-5f07907bd2ba";
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = {
          url: incoming.url,
          authorization: incoming.headers.authorization,
          body: JSON.parse(body),
        };
        respondJson(response, {
          ok: true,
          preview: true,
          conversion: {
            outcome: "refused",
            reason: "update_requires_confirmation",
            requiresConfirmation: true,
            targetClass: "managed",
            conversationId,
          },
        });
      }),
    );

    const { home } = homeWithServer(
      "hebbian-cli-hmux-convert-",
      port,
      "convert-token",
    );
    const result = await runCli(
      [
        "hmux",
        "convert",
        "--name",
        "standalone-session",
        "--target-panel-id",
        "agent:agent-1",
        "--to",
        "managed",
        "--agent-name",
        "managed-codex",
      ],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("preview: standalone-session → managed");
    expect(result.stdout).toContain(`conversation ${conversationId}`);
    expect(result.stdout).toContain("--confirm-restart");
    expect(request).toEqual({
      url: "/hmux/convert",
      authorization: "Bearer convert-token",
      body: {
        name: "standalone-session",
        targetPanelId: "agent:agent-1",
        to: "managed",
        agentName: "managed-codex",
      },
    });
  });

  it("dumps the workspace performance report as JSON", async () => {
    let request;
    const report = { sampleCount: 3, totals: { transitions: 3 } };
    // report의 형제 키 — 프레임 예산 스케줄러 레인 계측은 언랩에서 떨어지면
    // 안 된다(2026-08-04: 언랩이 키를 버려 실측이 앱 서버 직접 질의로 우회됨).
    const frameBudget = { catchup: { unitsRun: 2, msSpent: 1 } };
    const multiWindow = {
      complete: true,
      totals: { terminalSurfaces: 1, terminalModelBytes: 512 },
    };
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body };
        respondJson(response, {
          ok: true,
          report,
          frameBudget,
          multiWindow,
        });
      }),
    );

    const { home } = homeWithServer("hebbian-cli-perf-", port, "perf-token");
    const result = await runCli(["perf", "report", "--json"], isolatedEnvironment({
      HOME: home,
    }));

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ...report,
      frameBudget,
      multiWindow,
      terminalGeometry: null,
      generatedAtMs: null,
    });
    expect(request).toEqual({
      method: "POST",
      url: "/perf/report",
      authorization: "Bearer perf-token",
      body: "{}",
    });
  });

  it("requests only the terminal-input performance projection", async () => {
    let request;
    const report = {
      schemaVersion: 1,
      projection: "terminal-input",
      complete: true,
      expectedWindowLabels: ["main"],
      missingWindowLabels: [],
      windows: [],
    };
    const port = await startAppServer(
      withBody((incoming, response, body) => {
        request = { ...requestIdentity(incoming), body };
        respondJson(response, {
          ok: true,
          projection: "terminal-input",
          report,
          generatedAtMs: 1_728_000_000_000,
        });
      }),
    );

    const { home } = homeWithServer(
      "hebbian-cli-perf-input-",
      port,
      "perf-input-token",
      ["performance_report.terminal_input_v1"],
    );
    const result = await runCli(
      ["perf", "report", "--projection", "terminal-input", "--json"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ...report,
      generatedAtMs: 1_728_000_000_000,
    });
    expect(request).toEqual({
      method: "POST",
      url: "/perf/report",
      authorization: "Bearer perf-input-token",
      body: JSON.stringify({ projection: "terminal-input" }),
    });
  });

  it("fails closed when a running app ignores the requested projection", async () => {
    let requestCount = 0;
    const port = await startAppServer((_incoming, response) => {
      requestCount += 1;
      respondJson(response, {
        ok: true,
        report: { sampleCount: 3 },
      });
    });
    const { home } = homeWithServer(
      "hebbian-cli-perf-old-app-",
      port,
      "perf-old-app-token",
    );

    const result = await runCli(
      ["perf", "report", "--projection", "terminal-input", "--json"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "running app does not advertise terminal-input performance reports",
    );
    expect(requestCount).toBe(0);
  });

  it("rejects a missing projection value before contacting the app", async () => {
    let requestCount = 0;
    const port = await startAppServer((_incoming, response) => {
      requestCount += 1;
      respondJson(response, { ok: true, report: {} });
    });
    const { home } = homeWithServer(
      "hebbian-cli-perf-missing-projection-",
      port,
      "perf-missing-projection-token",
    );

    const result = await runCli(
      ["perf", "report", "--projection"],
      isolatedEnvironment({ HOME: home }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--projection must be terminal-input");
    expect(requestCount).toBe(0);
  });

  it("reads a managed agent through an exact observer-only Hmux identity", async () => {
    const { home, dureDir } = isolatedHome("hebbian-cli-hmux-read-");
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const argumentsPath = join(home, "hmux-arguments.json");
    const hmuxPath = join(binDir, "hmux");
    writeFileSync(
      hmuxPath,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    cliVersion: "0.1.4",
    capabilities: ["managed_screen_read_v1"],
  }));
} else if (args[0] === "--version") {
  process.stdout.write("hmux 0.1.4\\n");
} else {
  writeFileSync(process.env.HMUX_TEST_ARGUMENTS, JSON.stringify(args));
  process.stdout.write("managed screen\\n");
}
`,
    );
    chmodSync(hmuxPath, 0o755);
    writeManagedAgentRegistry(dureDir);
    const environment = isolatedEnvironment({
      DURE_HMUX_BIN: hmuxPath,
      HOME: home,
      HMUX_TEST_ARGUMENTS: argumentsPath,
    });

    const result = await runCli(
      ["read", "hebbian-frontend", "--lines", "7"],
      environment,
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: "managed screen\n",
      stderr: "",
    });
    expect(JSON.parse(readFileSync(argumentsPath, "utf8"))).toEqual([
      "read",
      "managed-session-1",
      "--workspace",
      "workspace-1",
      "--lines",
      "7",
      "--deadline-ms",
      "2500",
    ]);
  });

  it("uses the channel-pinned Hmux binary for a development channel", async () => {
    const home = mkdtempSync(join(tmpdir(), "dure-cli-channel-hmux-"));
    temporaryRoots.push(home);
    const channel = "dev-uiux-fixture";
    const channelRoot = join(home, ".dure", "channels", channel);
    const channelBinRoot = join(
      home,
      ".local",
      "share",
      "hmux",
      "channels",
      channel,
      "bin",
    );
    const staleBinRoot = join(home, "stale-bin");
    mkdirSync(channelRoot, { recursive: true });
    mkdirSync(channelBinRoot, { recursive: true });
    mkdirSync(staleBinRoot, { recursive: true });
    writeManagedAgentRegistry(channelRoot, {
      id: "agent-channel",
      name: "channel-agent",
      project: "Dure",
      provider: "codex",
      sessionId: "managed-channel-session",
      runtimeBinding: {
        runtime: "hmux_managed_v1",
        source: "local",
        hostId: "local",
        sessionId: "managed-channel-session",
        workspaceId: "workspace-channel",
      },
    });
    const channelHmux = join(channelBinRoot, "hmux");
    writeFileSync(
      channelHmux,
      `#!/usr/bin/env node
process.stdout.write("channel hmux screen\\n");
`,
    );
    chmodSync(channelHmux, 0o755);
    const staleMarker = join(home, "stale-hmux-called");
    const staleHmux = join(staleBinRoot, "hmux");
    writeFileSync(
      staleHmux,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.STALE_HMUX_MARKER, "called");
process.stdout.write("stale PATH hmux screen\\n");
`,
    );
    chmodSync(staleHmux, 0o755);

    const result = await runCli(
      ["read", "channel-agent"],
      isolatedEnvironment({
        DURE_APP_CHANNEL: channel,
        HEBBIAN_HMUX_BIN: staleHmux,
        HOME: home,
        PATH: `${staleBinRoot}:${process.env.PATH}`,
        STALE_HMUX_MARKER: staleMarker,
      }),
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: "channel hmux screen\n",
      stderr: "",
    });
    expect(existsSync(staleMarker)).toBe(false);
  });

  it("diagnoses an older Hmux binary missing the bounded-read capability", async () => {
    const { home, dureDir } = isolatedHome("hebbian-cli-old-hmux-");
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const readAttemptPath = join(home, "unexpected-read");
    const hmuxPath = join(binDir, "hmux");
    writeFileSync(
      hmuxPath,
      `#!/bin/sh
case "$1" in
  capabilities)
    echo "unrecognized subcommand 'capabilities'" >&2
    exit 2
    ;;
  --version)
    echo "hmux 0.1.4"
    ;;
  *)
    printf 'called' >"$HMUX_TEST_READ_ATTEMPT"
    echo "unexpected argument '--workspace'" >&2
    exit 2
    ;;
esac
`,
    );
    chmodSync(hmuxPath, 0o755);
    writeManagedAgentRegistry(dureDir);

    const result = await runCli(["read", "hebbian-frontend"], isolatedEnvironment({
      HEBBIAN_HMUX_BIN: hmuxPath,
      HOME: home,
      HMUX_TEST_READ_ATTEMPT: readAttemptPath,
    }));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("bounded_screen_read_v1");
    expect(result.stderr).toContain("hmux >= 0.2.2");
    expect(result.stderr).toContain("installed version 0.1.4");
    expect(result.stderr).toContain("pnpm hmux:install");
    expect(result.stderr).toContain("unexpected argument '--workspace'");
    expect(readFileSync(readAttemptPath, "utf8")).toBe("called");
  });

  it("resolves self via HMUX_SESSION_ID when HEBBIAN_SESSION is absent (managed agent, UC-16)", async () => {
    const { home, dureDir } = isolatedHome("hebbian-cli-self-");
    writeFileSync(
      join(dureDir, "agents.json"),
      JSON.stringify({ agents: [{ name: "codex-1", sessionId: "sess-xyz", project: "p" }] }),
    );
    const environment = colorCapableEnvironment({ HOME: home });
    for (const key of ["HEBBIAN_SESSION", "HEBBIAN_AGENT", "HMUX_SESSION_ID"]) {
      delete environment[key];
    }
    // A managed Hmux runtime provides only the provider-neutral session identity.
    environment.HMUX_SESSION_ID = "sess-xyz";

    const result = await runCli(["whoami", "--json"], environment);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      displayName: "codex-1",
      sessionId: "sess-xyz",
    });
  });

  it("fails self-resolution when no session env is present at all", async () => {
    const { home } = isolatedHome("hebbian-cli-noself-");
    const environment = isolatedEnvironment({ HOME: home });
    for (const key of ["HEBBIAN_SESSION", "HEBBIAN_AGENT", "HMUX_SESSION_ID"]) {
      delete environment[key];
    }
    const result = await runCli(["whoami", "--json"], environment);
    expect(result.code).not.toBe(0);
  });
});

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requestAppControl } from "../cli/lib/app-control-client.mjs";
import { parseClientPresentationCommand } from "../cli/lib/client-presentation-command.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";
import { dispatchCliPaneActionRequest } from "../src/lib/cli/cliPaneActions";
import { chatPaneActionEntry } from "../src/lib/workspace/pane/chatPaneActions";
import { registerPaneActions } from "../src/lib/workspace/pane/paneActionRegistry";

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

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "dure-client-pane-"));
  temporaryRoots.push(home);
  const environment = { ...process.env, HOME: home };
  delete environment.DURE_APP_CHANNEL;
  delete environment.HEBBIAN_APP_CHANNEL;
  delete environment.DURE_HOME;
  delete environment.DURE_BACKEND_PROFILE;
  delete environment.HMUX_SESSION_ID;
  delete environment.HMUX_WORKSPACE_ID;
  return { home, environment };
}

async function fixtureClient(handler, capabilities = ["pane_actions.arguments_results_v1", "terminal_pane.create_v1", "project_registration.add_v1", "unopened_agents.visibility_v1"]) {
  const requests = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", async () => {
      requests.push({
        method: incoming.method,
        url: incoming.url,
        authorization: incoming.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      const result = (await handler?.(requests.at(-1))) ?? {
        status: 200,
        body: { ok: true },
      };
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture client has no TCP port");
  }
  const fixture = isolatedHome();
  const controlRoot = join(fixture.home, ".dure");
  mkdirSync(controlRoot, { recursive: true });
  writeFileSync(
    join(controlRoot, "server.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiVersion: 1,
      packageVersion: "0.1.4",
      buildId: "0.1.4+fixture",
      port: address.port,
      token: "client-control-token",
      channel: "stable",
      generation: "client-generation-1",
      capabilities,
      processId: 42,
    }),
  );
  return { ...fixture, requests };
}

function terminalSpaces(fixture, names = ["First", "Selected"]) {
  const spaces = names.map((name, index) => ({
    id: `space-${index}`, name, kind: "desktop", windowLabel: index ? "win-100-2" : "main",
    panes: [{ id: `term:source-${index}`, type: "terminal", component: "terminal", agentId: null, title: "Terminal",
      binding: { schemaVersion: 1, runtime: "hmux_standalone_v1", source: "local", hostId: "local", sessionId: `source-${index}`, workspaceId: "native-source" } }],
  }));
  writeFileSync(join(fixture.home, ".dure", "agents.json"), JSON.stringify({ updatedAt: 1, agents: [], clientPresentation: {
    schemaVersion: 3, complete: true, spaces,
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 },
  } }));
}

describe("Dure Chat failed-message action", () => {
  it.each(["sent", "refused", "unavailable"])("runs the real CLI through the shared action handler (%s)", async (outcome) => {
    let calls = 0;
    const paneId = "pane-retained-message";
    const remove = registerPaneActions({
      ...chatPaneActionEntry(
        { paneId, agentId: "agent-resend", interactionSessionId: "chat-resend" },
        { phase: "ready", reconnecting: false, activeTurn: undefined, interrupting: false, locked: false, error: undefined },
        { interrupt: async () => {}, ...(outcome === "unavailable" ? {} : { resendLastMessage: {
          failureId: "failure-retained",
          run: async () => {
            calls++;
            if (outcome === "refused") throw new Error("agent_chat_turn_already_pending");
          },
        } }) },
      ), owner: {},
    });
    try {
      const fixture = await fixtureClient(async ({ body }) => {
        let response;
        await dispatchCliPaneActionRequest({ reqId: "resend-process", action: "pane.act", params: body }, {
          claim: async () => true, complete: async (_id, result) => { response = result; },
          isFallbackWindow: () => false, delay: async () => {},
        });
        return { status: 200, body: response };
      });
      const result = await runCli(["client", "pane", "act", paneId, "resend_last_message", "--idempotency-key", "resend-exact-1", "--json"], fixture.environment);
      expect(fixture.requests).toEqual([expect.objectContaining({ url: "/pane/act", body: {
        targetPanelId: paneId, actionId: "resend_last_message", idempotencyKey: "resend-exact-1",
      } })]);
      expect(calls).toBe(outcome === "unavailable" ? 0 : 1);
      if (outcome === "sent") {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).pane).toMatchObject({ paneId, invoked: "resend_last_message" });
      } else {
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr).error.code).toBe(outcome === "refused" ? "pane_action_failed" : "pane_action_unavailable");
      }
    } finally { remove(); }
  });
});

describe("Dure unopened-agent visibility CLI", () => {
  it("rejects a mismatched or non-durable receipt and never retries a refused change", async () => {
    const fixture = await fixtureClient(({ body }) => ({ status: 200, body: {
      ok: true, visibility: { schemaVersion: 1, agentId: "wrong-agent", placement: "unopened",
        episode: body.expectedEpisode, hidden: true, changed: true, persisted: false },
    } }));
    const result = await runCli(["client", "unopened", "hide", "exact", "--expected-episode", "0", "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "client_response_invalid" } });
    expect(fixture.requests).toHaveLength(1);
    const refused = await fixtureClient(() => ({ status: 200, body: { ok: false, error: { code: "visibility_observation_stale", message: "Attention changed" } } }));
    const refusal = await runCli(["client", "unopened", "hide", "exact", "--expected-episode", "0", "--json"], refused.environment);
    expect(refusal.code).toBe(2);
    expect(JSON.parse(refusal.stderr)).toMatchObject({ error: { code: "visibility_observation_stale" } });
    expect(refused.requests).toHaveLength(1);
  });
  it("inspects, hides and restores one exact agent without a runtime request", async () => {
    const fixture = await fixtureClient(({ body }) => ({ status: 200, body: {
      ok: true, visibility: { schemaVersion: 1, agentId: body.agentId, placement: "unopened",
        episode: 7, hidden: body.operation === "hide", changed: body.operation !== "get", persisted: true },
    } }));
    for (const operation of ["get", "hide", "restore"]) {
      const args = ["client", "unopened", operation, "agent-exact", ...(operation === "get" ? [] : ["--expected-episode", "7"]), "--json"];
      const result = await runCli(args, fixture.environment);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "dure.client_unopened.visibility", action: operation,
        visibility: { agentId: "agent-exact", hidden: operation === "hide", persisted: true } });
      expect(fixture.requests.at(-1)).toMatchObject({ url: "/agents/unopened/visibility", body: {
        schemaVersion: 1, operation, agentId: "agent-exact", ...(operation === "get" ? {} : { expectedEpisode: 7 }),
      } });
    }
    expect(fixture.requests).toHaveLength(3);
  });

  it("refuses missing/stale-protocol input and older apps without sending requests", async () => {
    const fixture = await fixtureClient(undefined, []);
    for (const tail of [["hide", "agent-exact"], ["restore", "agent-exact", "--expected-episode", "-1"],
      ["hide", "agent-exact", "--expected-episode", "1.5"], ["get", "agent-exact", "--expected-episode", "7"]]) {
      expect((await runCli(["client", "unopened", ...tail, "--json"], fixture.environment)).code).toBe(2);
    }
    const result = await runCli(["client", "unopened", "get", "agent-exact", "--json"], fixture.environment);
    expect(JSON.parse(result.stderr)).toMatchObject({ kind: "dure.client_unopened.error", error: { code: "client_capability_missing" } });
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("Dure connected-client SSH host registration", () => {
  const host = { id: "host-ec2", name: "ec2-106", host: "example.test", port: 22, user: "ec2-user", auth: "key", keyPath: "~/.ssh/key.pem" };
  const registration = { host, created: true, persisted: true };

  it("registers a config alias through authenticated app control and returns its host ID", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }), ["ssh_hosts.add_v1"]);
    const result = await runCli(["client", "host", "add", "ec2-106", "--json"], fixture.environment);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "dure.client_host.add", registration });
    expect(fixture.requests).toEqual([expect.objectContaining({
      url: "/ssh/hosts/add", authorization: "Bearer client-control-token",
      body: { sshConfigAlias: "ec2-106" },
    })]);
  });

  it("registers an explicit SSH destination and identity file without creating a pane", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }), ["ssh_hosts.add_v1"]);
    const result = await runCli(["client", "host", "add", "--hostname", "example.test", "--user", "ec2-user",
      "--port", "2222", "--identity-file", "~/.ssh/key.pem", "--name", "ec2-106", "--json"], fixture.environment);
    expect(result.code).toBe(0);
    expect(fixture.requests).toEqual([expect.objectContaining({ url: "/ssh/hosts/add",
      body: { host: "example.test", user: "ec2-user", port: 2222, keyPath: "~/.ssh/key.pem", name: "ec2-106" } })]);
  });

  it("rejects ambiguous or malformed registration before mutation and checks app support", async () => {
    const fixture = await fixtureClient(undefined, ["ssh_hosts.add_v1"]);
    for (const tail of [[], ["alias", "--hostname", "example.test", "--user", "u"],
      ["--hostname", "example.test"], ["--hostname", "example.test", "--user", "u", "--port", "65536"],
      ["alias", "--identity-file", "/key"], ["alias", "--password", "secret"]]) {
      const result = await runCli(["client", "host", "add", ...tail, "--json"], fixture.environment);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ kind: "dure.client_host.error", error: { code: "invalid_request" } });
    }
    expect(fixture.requests).toHaveLength(0);
    const old = await fixtureClient(undefined, []);
    const result = await runCli(["client", "host", "add", "ec2-106", "--json"], old.environment);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "client_capability_missing" } });
    expect(old.requests).toHaveLength(0);
  });

  it("resolves an identity file against the invoking CLI directory", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }), ["ssh_hosts.add_v1"]);
    const keyPath = "./keys/EC2 key.pem";
    const result = await runCli(["client", "host", "add", "--hostname", "example.test", "--user", "ec2-user",
      "--identity-file", keyPath, "--json"], fixture.environment);
    expect(result.code).toBe(0);
    expect(fixture.requests[0].body.keyPath).toBe(resolve(keyPath));
  });

  it("does not report an unpersisted host as registered", async () => {
    const fixture = await fixtureClient(() => ({ status: 200,
      body: { ok: true, registration: { ...registration, persisted: false } } }), ["ssh_hosts.add_v1"]);
    const result = await runCli(["client", "host", "add", "ec2-106", "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "client_response_invalid" } });
    expect(fixture.requests).toHaveLength(1);
  });
});

describe("Dure connected-client project registration", () => {
  const registration = { project: { id: "proj-one", name: "plain", path: "/plain", kind: "local", isRepo: false },
    spaceId: "space-1", hostId: "local", scope: "app", persisted: true };

  it("shares the CLI/MCP registration transaction and exact Space selection", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }));
    terminalSpaces(fixture);
    const result = await runCli(["client", "project", "add", "./plain", "--space", "Selected", "--json"], fixture.environment);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "dure.client_project.add", registration });
    const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
      name: "app_project_add", arguments: { path: "./plain", space: "Selected" },
    } }, { DURE_HOME: join(fixture.home, ".dure"), DURE_BACKEND_PROFILE: "runtime-backend" });
    expect(mcp.isError).toBe(false);
    expect(mcp.structuredContent).toEqual(JSON.parse(result.stdout));
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]).toEqual(fixture.requests[1]);
    expect(fixture.requests[0]).toMatchObject({ url: "/project/add", body: { path: join(process.cwd(), "plain"), spaceId: "space-1", hostId: "local" } });
  });

  it("defaults to local cwd and leaves unknown invoking Space to the app", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }));
    const result = await runCli(["client", "project", "add", "--json"], fixture.environment);
    expect(result.code).toBe(0);
    expect(fixture.requests[0].body).toEqual({ hostId: "local", path: process.cwd() });
  });

  it("uses the invoking pane's Space through the shared selector", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }));
    terminalSpaces(fixture);
    const environment = { ...fixture.environment, HMUX_SESSION_ID: "source-1", HMUX_WORKSPACE_ID: "native-source" };
    expect((await runCli(["client", "project", "add", "/plain", "--json"], environment)).code).toBe(0);
    expect(fixture.requests[0].body.spaceId).toBe("space-1");
  });

  it("preserves remote paths and exact IDs without a saved projection", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, registration } }));
    const result = await runCli(["client", "project", "add", "C:\\Work\\plain", "--host", "ssh-1", "--space-id", "space-1", "--json"], fixture.environment);
    expect(result.code).toBe(0);
    expect(fixture.requests[0].body).toEqual({ hostId: "ssh-1", path: "C:\\Work\\plain", spaceId: "space-1" });
  });

  it.each([
    ["--host", "ssh-1"],
    ["--space", "A", "--space-id", "B"],
    ["--backend", "remote"],
  ])("refuses incomplete or conflicting input without registration: %j", async (...options) => {
    const fixture = await fixtureClient();
    expect((await runCli(["client", "project", "add", ...options, "--json"], fixture.environment)).code).toBe(2);
    expect(fixture.requests).toHaveLength(0);
  });

  it("preserves an uncertain registration error without automatic resubmission", async () => {
    const error = { code: "request_timeout", message: "Registration completion is unknown", nextAction: "Inspect the app before retrying." };
    const fixture = await fixtureClient(() => ({ status: 504, body: { ok: false, error } }));
    const result = await runCli(["client", "project", "add", "/plain", "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ kind: "dure.client_project.error", error });
    expect(fixture.requests).toHaveLength(1);
  });

  it("does not submit to an app without project registration capability", async () => {
    const fixture = await fixtureClient(undefined, ["terminal_pane.create_v1"]);
    const result = await runCli(["client", "project", "add", "/plain", "--json"], fixture.environment);
    expect(JSON.parse(result.stderr).error.code).toBe("client_capability_missing");
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("Dure connected-client pane CLI", () => {
  it("creates a terminal through the same CLI and MCP transaction without a reference pane", async () => {
    const pane = { panelId: "term:shell-1", sessionId: "shell-1", workspaceId: "native-1",
      spaceId: "space-current", hostId: "local", cwd: "/qa/plain-folder", attachment: { state: "attached" } };
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, pane } }));
    const result = await runCli(["client", "pane", "create", "--cwd", pane.cwd, "--json"], fixture.environment);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "dure.client_pane.create", pane });
    const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
      name: "app_pane_create", arguments: { cwd: pane.cwd },
    } }, { DURE_HOME: join(fixture.home, ".dure") });
    expect(mcp.isError).toBe(false);
    expect(mcp.structuredContent).toEqual(JSON.parse(result.stdout));
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]).toEqual(fixture.requests[1]);
    expect(fixture.requests[0]).toMatchObject({ url: "/hmux/create", body: { cwd: pane.cwd, hostId: "local" } });
  });

  it("does not let an older app silently create locally for an SSH request", async () => {
    const fixture = await fixtureClient(undefined, []);
    const result = await runCli(["client", "pane", "create", "--host", "ssh-1", "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("client_capability_missing");
    expect(fixture.requests).toHaveLength(0);
  });

  it.each(["space-1", "Selected", null])("selects the requested or invoking Space, not the first: %s", async (space) => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, pane: { panelId: "term:new" } } }));
    terminalSpaces(fixture);
    const environment = { ...fixture.environment, HMUX_SESSION_ID: "source-1", HMUX_WORKSPACE_ID: "native-source" };
    const result = await runCli(["client", "pane", "create", ...(space ? ["--space", space] : []), "--cwd", "./plain", "--json"], environment);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].body).toEqual({ hostId: "local", cwd: join(process.cwd(), "plain"), spaceId: "space-1" });
  });

  it("keeps an explicit ID usable without a saved Space projection", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, pane: { panelId: "term:new" } } }));
    const result = await runCli(["client", "pane", "create", "--space-id", "space-remote", "--host", "ssh-1", "--cwd", "/srv/plain", "--json"], fixture.environment);
    expect(result.code).toBe(0);
    expect(fixture.requests[0].body).toEqual({ spaceId: "space-remote", hostId: "ssh-1", cwd: "/srv/plain" });
    const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
      name: "app_pane_create", arguments: { spaceId: "space-remote", hostId: "ssh-1", cwd: "/srv/plain" },
    } }, { DURE_HOME: join(fixture.home, ".dure"), DURE_BACKEND_PROFILE: "runtime-backend" });
    expect(mcp.isError).toBe(false);
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
  });

  it.each([
    ["Selected", ["Same", "Same"], "client_space_not_found"],
    ["Same", ["Same", "Same"], "client_space_ambiguous"],
  ])("refuses an unresolved Space before any create: %s", async (space, names, code) => {
    const fixture = await fixtureClient();
    terminalSpaces(fixture, names);
    const result = await runCli(["client", "pane", "create", "--space", space, "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe(code);
    expect(fixture.requests).toHaveLength(0);
  });

  it("preserves the remote default cwd and an actionable refusal without retry", async () => {
    const error = { code: "remote_hmux_host_not_registered", message: "Host missing", nextAction: "Register the SSH host in Dure." };
    const fixture = await fixtureClient(() => ({ status: 409, body: { ok: false, error } }));
    const result = await runCli(["client", "pane", "create", "--host", "ssh-missing", "--json"], fixture.environment);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual(error);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].body).toEqual({ hostId: "ssh-missing" });
  });

  it("rejects unsupported backend options and conflicting Space options", async () => {
    const fixture = await fixtureClient();
    for (const options of [["--backend", "remote"], ["--space", "A", "--space-id", "B"]]) {
      const result = await runCli(["client", "pane", "create", ...options, "--json"], fixture.environment);
      expect(result.code).toBe(2);
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it("keeps app presentation independent of the invoking agent's backend profile", async () => {
    const fixture = await fixtureClient(() => ({ status: 200, body: { ok: true, pane: { panelId: "term:new", hostId: "ssh-1" } } }));
    const environment = { ...fixture.environment, DURE_BACKEND_PROFILE: "runtime-backend" };
    const result = await runCli(["client", "pane", "create", "--host", "ssh-1", "--json"], environment);
    expect(result.code).toBe(0);
    expect(fixture.requests[0].body).toEqual({ hostId: "ssh-1" });
  });

  it("preserves arguments and refused outcomes through both CLI and MCP", async () => {
    const result = { outcome: "refused", error: { code: "source_retained", message: "The source is busy.", retryable: true } };
    const fixture = await fixtureClient(() => ({ status: 200, body: {
      ok: true, pane: { paneId: "agent:agent-1", invoked: "settings.effort", result },
    } }));
    const args = { value: "high", expectedSourceRevision: 12, expectedConversationId: "conversation-original" };
    const cli = await runCli(["client", "pane", "act", "agent:agent-1", "settings.effort", "--args-json", JSON.stringify(args), "--idempotency-key", "edit-1", "--json"], fixture.environment);
    expect(cli.code).toBe(2);
    expect(JSON.parse(cli.stdout).pane.result).toEqual(result);
    const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
      name: "app_pane_act", arguments: { paneId: "agent:agent-1", actionId: "settings.effort", arguments: args, idempotencyKey: "edit-1" },
    } }, { DURE_HOME: join(fixture.home, ".dure") });
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent).toEqual(JSON.parse(cli.stdout));
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]).toEqual(fixture.requests[1]);
    expect(fixture.requests[0].body).toEqual({ targetPanelId: "agent:agent-1", actionId: "settings.effort", arguments: args, idempotencyKey: "edit-1" });
  });

  it("rejects malformed arguments and missing MCP retry identity before dispatch", async () => {
    const fixture = await fixtureClient();
    const cli = await runCli(["client", "pane", "act", "agent:agent-1", "settings.effort", "--args-json", "[]", "--json"], fixture.environment);
    expect(cli.code).toBe(2);
    const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
      name: "app_pane_act", arguments: { paneId: "agent:agent-1", actionId: "settings.effort" },
    } }, { DURE_HOME: join(fixture.home, ".dure") });
    expect(mcp.structuredContent.error.code).toBe("invalid_request");
    expect(fixture.requests).toHaveLength(0);
  });

  it("discovers exact pane IDs across windows without exposing the raw agent registry", async () => {
    const fixture = await fixtureClient();
    writeFileSync(join(fixture.home, ".dure", "agents.json"), JSON.stringify({
      updatedAt: 123, agents: [{ credential: "private-fixture-value" }],
      clientPresentation: {
        schemaVersion: 3, complete: true,
        spaces: ["main", "popout-1"].map((windowLabel) => ({
          id: `space-${windowLabel}`, name: windowLabel, kind: windowLabel === "main" ? "desktop" : "popout", windowLabel,
          panes: [{ id: `agent:${windowLabel}`, type: "agent", component: "agent", agentId: windowLabel, title: "Task", binding: null }],
        })),
        limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
        truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 },
      },
    }));
    const cli = await runCli(["client", "observe", "--json"], fixture.environment);
    expect(cli).toMatchObject({ code: 0, stderr: "" });
    const report = JSON.parse(cli.stdout);
    expect(report.presentation.spaces.flatMap((space) => space.panes.map((pane) => pane.id))).toEqual(["agent:main", "agent:popout-1"]);
    expect(report.presentation.source).toBe("saved_client_projection");
    expect(report.presentation.ageMs).toBeGreaterThan(0);
    expect(cli.stdout).not.toContain("private-fixture-value");
    expect(fixture.requests[0]).toMatchObject({ method: "GET", url: "/ping" });
  });
  it("opens one exact pane workspace through the connected client", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        workspace: {
          spaceId: "space-a",
          panelId: "agent:agent-1",
          kind: "agent",
          canonicalPath: "/repo/.worktrees/agent-1",
          targetId: "cursor",
        },
      },
    }));

    const result = await runCli(
      [
        "client",
        "workspace",
        "open",
        "agent:agent-1",
        "--space-id",
        "space-a",
        "--target",
        "cursor",
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiVersion: "dure.client-presentation/v1",
      kind: "dure.client_workspace.open",
      workspace: {
        spaceId: "space-a",
        panelId: "agent:agent-1",
        canonicalPath: "/repo/.worktrees/agent-1",
        targetId: "cursor",
      },
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url: "/workspace/open-external",
        authorization: "Bearer client-control-token",
        body: {
          panelId: "agent:agent-1",
          spaceId: "space-a",
          desktopId: "space-a",
          targetId: "cursor",
        },
      },
    ]);
  });

  it("keeps help as an exact identity outside a help position", () => {
    expect(
      parseClientPresentationCommand([
        "pane",
        "split",
        "help",
        "--cwd",
        "help",
      ]),
    ).toMatchObject({
      help: false,
      action: "split",
      body: {
        referenceSessionId: "help",
        cwd: "help",
      },
    });
  });

  it("times out a stalled app-control request", async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

    await expect(
      requestAppControl({
        descriptor: { port: 1, token: "fixture-token" },
        path: "/pane/create",
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "client_request_timeout" });
  });

  it.each(["ECONNREFUSED", "ECONNRESET"])(
    "preserves the transport cause and makes only one request for %s",
    async (code) => {
      const cause = new TypeError("fetch failed", {
        cause: Object.assign(new Error("private cause detail"), { code }),
      });
      let attempts = 0;
      const error = await requestAppControl({
        descriptor: { port: 43210, token: "fixture-token" },
        path: "/pane/create",
        fetchImpl: async () => {
          attempts += 1;
          throw cause;
        },
      }).catch((failure) => failure);

      expect(error).toMatchObject({ code: "client_request_failed", cause });
      expect(attempts).toBe(1);
      expect(error.message).not.toContain("private cause detail");
      expect(error.message).not.toContain("fixture-token");
      if (code === "ECONNREFUSED") {
        expect(error.message).toContain("ECONNREFUSED");
        expect(error.message).toContain("127.0.0.1:43210");
      } else {
        expect(error.message).toContain(cause.message);
      }
    },
  );

  it("documents the connected-client boundary without loading app state", async () => {
    const fixture = isolatedHome();

    const result = await runCli(
      ["client", "pane", "--help"],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("dure client pane split");
    expect(result.stdout).toContain("dure client pane close");
    expect(result.stdout).toContain("dure client workspace open");
    expect(result.stdout).toContain("client_unavailable");
  });

  it("splits through the existing correlated pane route", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        pane: {
          spaceId: "space-a",
          desktopId: "space-a",
          panelId: "term:new",
          referencePanelId: "agent:source",
          direction: "right",
        },
      },
    }));

    const result = await runCli(
      [
        "client",
        "pane",
        "split",
        "session-source",
        "--reference-panel-id",
        "agent:source",
        "--direction",
        "right",
        "--cwd",
        "/repo",
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.client-pane/v1",
      kind: "dure.client_pane.split",
      client: {
        channel: "stable",
        generation: "client-generation-1",
      },
      pane: { panelId: "term:new", direction: "right" },
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url: "/pane/create",
        authorization: "Bearer client-control-token",
        body: {
          referenceSessionId: "session-source",
          referencePanelId: "agent:source",
          direction: "right",
          cwd: "/repo",
        },
      },
    ]);
  });

  it("reads one pane's registered state through the client", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        pane: {
          paneId: "agent:agent-1",
          status: "attach_failed",
          error: "connect to Hmux Host failed",
          context: "agent=agent-1 pane=agent:agent-1",
          actions: ["resume"],
        },
      },
    }));

    const result = await runCli(
      ["client", "pane", "state", "agent:agent-1", "--json"],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.client_pane.state",
      pane: { paneId: "agent:agent-1", status: "attach_failed" },
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url: "/pane/state",
        authorization: "Bearer client-control-token",
        body: { targetPanelId: "agent:agent-1" },
      },
    ]);
  });

  it("invokes one named pane action through the exact UI handler route", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        pane: { paneId: "agent:agent-1", invoked: "resume", status: "attached" },
      },
    }));

    const result = await runCli(
      ["client", "pane", "act", "agent:agent-1", "resume", "--json"],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.client_pane.act",
      pane: { paneId: "agent:agent-1", invoked: "resume" },
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url: "/pane/act",
        authorization: "Bearer client-control-token",
        body: { targetPanelId: "agent:agent-1", actionId: "resume" },
      },
    ]);
  });

  it("relays typed pane-action refusals with machine guidance", async () => {
    const fixture = await fixtureClient(() => ({
      status: 409,
      body: {
        ok: false,
        error: {
          code: "pane_action_unavailable",
          message: "pane agent:agent-1 does not offer action explode",
          retryable: false,
          nextAction: "available actions: resume",
        },
      },
    }));

    const result = await runCli(
      ["client", "pane", "act", "agent:agent-1", "explode", "--json"],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "dure.client_pane.error",
      error: {
        code: "pane_action_unavailable",
        retryable: false,
        nextAction: "available actions: resume",
      },
    });
  });

  it("refuses a destructive close before client I/O without confirmation", async () => {
    const fixture = await fixtureClient();

    const result = await runCli(
      ["client", "pane", "close", "term:a", "--json"],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "dure.client_pane.error",
      action: "close",
      error: { code: "confirmation_required" },
    });
    expect(fixture.requests).toEqual([]);
  });

  it("closes one exact pane and preserves canonical Space identity", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        closed: {
          panelId: "term:a",
          spaceId: "space-a",
          desktopId: "space-a",
          mode: "live",
        },
      },
    }));

    const result = await runCli(
      [
        "client",
        "pane",
        "close",
        "term:a",
        "--space-id",
        "space-a",
        "--yes",
        "--json",
      ],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.client_pane.close",
      pane: { panelId: "term:a", spaceId: "space-a", mode: "live" },
    });
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        url: "/pane/close",
        authorization: "Bearer client-control-token",
        body: {
          targetPanelId: "term:a",
          spaceId: "space-a",
          desktopId: "space-a",
          confirm: true,
        },
      },
    ]);
  });

  it("requires an exact Space before a confirmed close reaches the client", async () => {
    const fixture = await fixtureClient();

    const result = await runCli(
      ["client", "pane", "close", "term:a", "--yes", "--json"],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      action: "close",
      error: { code: "invalid_request" },
    });
    expect(result.stderr).toContain("--space-id");
    expect(fixture.requests).toEqual([]);
  });

  it("reports a missing connected client as a typed error", async () => {
    const fixture = isolatedHome();

    const result = await runCli(
      ["client", "pane", "split", "session-source", "--json"],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "dure.client_pane.error",
      action: "split",
      error: { code: "client_unavailable" },
    });
  });

  it("rejects a missing option value before loading client state", async () => {
    const fixture = isolatedHome();

    const result = await runCli(
      [
        "client",
        "pane",
        "split",
        "session-source",
        "--direction",
        "--json",
      ],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      action: "split",
      error: { code: "invalid_request" },
    });
    expect(result.stderr).toContain("--direction");
  });

  it("preserves a typed refusal from the existing pane transaction", async () => {
    const fixture = await fixtureClient(() => ({
      status: 404,
      body: {
        ok: false,
        error: { code: "pane_not_found", message: "exact pane is absent" },
      },
    }));

    const result = await runCli(
      [
        "client",
        "pane",
        "close",
        "term:absent",
        "--space-id",
        "space-a",
        "--yes",
        "--json",
      ],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      action: "close",
      error: { code: "pane_not_found", message: "exact pane is absent" },
    });
    expect(result.stderr).not.toContain("client-control-token");
    expect(fixture.requests).toHaveLength(1);
  });

  it("bounds a client response while reading its body", async () => {
    const fixture = await fixtureClient(() => ({
      status: 200,
      body: {
        ok: true,
        pane: { padding: "x".repeat(1024 * 1024) },
      },
    }));

    const result = await runCli(
      ["client", "pane", "split", "session-source", "--json"],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      action: "split",
      error: { code: "client_response_too_large" },
    });
    expect(result.stderr).not.toContain("client-control-token");
  });

  it("rejects conflicting Space aliases before client I/O", async () => {
    const fixture = await fixtureClient();

    const result = await runCli(
      [
        "client",
        "pane",
        "close",
        "term:a",
        "--space-id",
        "space-a",
        "--desktop-id",
        "space-b",
        "--yes",
        "--json",
      ],
      fixture.environment,
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "client_space_identity_conflict" },
    });
    expect(fixture.requests).toEqual([]);
  });
});

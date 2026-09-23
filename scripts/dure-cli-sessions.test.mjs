import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { LocalBackendError } from "../cli/lib/local-backend.mjs";
import { collectSessionQuery } from "../cli/lib/session-query.mjs";
import { sessionCursor } from "../cli/lib/session-cursor.mjs";
import { collectSessionRead } from "../cli/lib/session-read.mjs";
import {
  hmuxSession,
  hostGeneration,
  installHmuxStub,
  installRemoteBackendFixture,
  runSessionCli as runCli,
  writeRegistry,
} from "./lib/dure-session-test-fixture.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-sessions-"));
  temporaryRoots.push(root);
  return root;
}

function agentPresentation(paneId, agentId = "agent-1", source = "local", hostId = "local") {
  return {
    schemaVersion: 2,
    complete: true,
    spaces: [{
      id: "space-a", name: "Work", kind: "desktop", windowLabel: "main",
      panes: [{
        id: paneId, type: "agent", component: "agent", agentId,
        binding: {
          schemaVersion: 1, runtime: "hmux_managed_v1", source, hostId,
          workspaceId: "workspace-1", sessionId: "session-1",
        },
      }],
    }],
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: { spaces: false, panes: false, omittedSpaceCount: 0, omittedPaneCount: 0 },
  };
}

describe("dure sessions list/show/read", () => {
  it("enumerates 300 backend Sessions in bounded pages without a client registry", () => {
    const root = temporaryRoot();
    const payload = Array.from({ length: 300 }, (_, i) => hmuxSession(i + 1));
    const hmux = installHmuxStub(root, payload, { capabilities: [
      "bounded_session_catalog_query_v1", "bounded_session_catalog_pagination_v1",
    ] });
    const ids = [];
    let cursor = "start";
    for (let page = 0; page < 4 && cursor; page++) {
      const result = runCli(root, hmux, ["ls", "--cursor", cursor, "--json"]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.sessions.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
      ids.push(...report.sessions.map((session) => session.sessionId));
      expect(report.truncation.omittedCount).toBe(300 - ids.length);
      expect(report.inventoryComplete).toBe(ids.length === 300);
      cursor = report.pagination.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(300);
  });

  it("rejects cursors before transport and requires pagination capability", async () => {
    const root = temporaryRoot();
    const markerPath = join(root, "invoked");
    const hmux = installHmuxStub(root, [], { markerPath });
    const invalid = runCli(root, hmux, ["ls", "--cursor", "invalid", "--json"]);
    expect(JSON.parse(invalid.stdout).error.code).toBe("dure_session_cursor_invalid");
    expect(existsSync(markerPath)).toBe(false);
    const unsupported = runCli(root, hmux, ["ls", "--cursor", "start", "--json"]);
    expect(JSON.parse(unsupported.stdout).error).toMatchObject({
      code: "dure_session_hmux_incompatible", capability: "bounded_session_catalog_pagination_v1",
    });
  });

  it.each(["local", "ssh"])("passes ordered continuation to the %s backend and validates advancement", async (kind) => {
    const cursor = sessionCursor({ workspaceId: "workspace-1", sessionId: "session-1" });
    let request;
    const collect = (sessions) => collectSessionQuery({
      action: "list", cursor,
      backend: { profile: { id: "test", transport: { kind }, expected: { capabilities: ["sessions.list"] } } },
      requestBackend: async (_profile, value) => {
        request = value;
        return { backend: {}, result: { schemaVersion: 1, complete: true, sessions } };
      },
    });
    const report = await collect([hmuxSession(2)]);
    expect(request.requiredCapabilities).toContain("sessions.list.pagination_v1");
    expect(request.body.page.after).toEqual({ workspaceId: "workspace-1", sessionId: "session-1" });
    expect(report.pagination.nextCursor).toBeNull();
    expect((await collect([hmuxSession(1)])).error.code).toBe("dure_session_page_invalid");
  });

  it.each([
    ["inspect", "--help"], ["inspect", "-h"],
    ["sessions", "show", "--help"], ["sessions", "list", "--help"],
    ["ls", "--help"], ["list", "-h"],
  ])("shows help for %j without looking up a session or backend", (...args) => {
    const root = temporaryRoot();
    const result = runCli(root, join(root, "absent-hmux"), args);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Usage: dure");
    expect(result.stderr).toBe("");
  });

  it("reads fenced runtime facts without app server.json and separates client projection", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession()]);
    writeRegistry(root, [
      {
        id: "agent-1",
        name: "codex-1",
        displayName: "Codex 1",
        project: "Dure",
        sessionId: "session-1",
        provider: "codex",
        worktree: "/repo/worktree",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          ...hostGeneration(),
          conversationIdentity: {
            ...hostGeneration(),
            providerId: "codex",
            conversationId: "conversation-1",
          },
        },
      },
    ]);

    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.sessions/v1",
      kind: "dure.sessions.list",
      complete: true,
      partial: false,
      source: { kind: "local_hmux", appDaemonRequired: false },
    });
    expect(report.sessions[0]).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      forkedFrom: null,
      cwd: "/repo/worktree",
      provider: {
        id: "codex",
        pid: 202,
        process: { startMarker: "provider-start-1" },
      },
      liveness: { state: "alive", health: "healthy", exactGeneration: true },
      clientProjection: {
        state: "current",
        agents: [
          {
            id: "agent-1",
            pane: { id: null, state: "unavailable" },
          },
        ],
      },
    });
    expect(result.stdout).not.toContain("/private/runtime.sock");
  });

  it.each(["slot", "pane-neutral", "launcher:previous", "term:previous", "agent:previous", "agent:agent-1"])(
    "reports the observed Agent pane %s independently of runtime identity",
    (paneId) => {
      const root = temporaryRoot();
      const hmux = installHmuxStub(root, hmuxSession());
      const presentation = agentPresentation(paneId);
      writeRegistry(root, [{
        id: "agent-1", name: "Codex",
        runtimeBinding: { ...presentation.spaces[0].panes[0].binding, ...hostGeneration() },
      }], presentation);
      const result = runCli(root, hmux, ["sessions", "show", "session-1", "--json"]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).session).toMatchObject({
        sessionId: "session-1", workspaceId: "workspace-1",
        clientProjection: {
          state: "current",
          agents: [{ id: "agent-1", pane: { id: paneId, state: "observed" } }],
        },
      });
    },
  );

  it.each([
    ["closed", (value) => { value.spaces[0].panes = []; }],
    ["changed content", (value) => { value.spaces[0].panes[0].component = "terminal"; }],
    ["wrong explicit Agent", (value) => { value.spaces[0].panes[0].agentId = "agent-other"; }],
    ["missing binding", (value) => { value.spaces[0].panes[0].binding = null; }],
    ...["runtime", "source", "hostId", "workspaceId", "sessionId"].map((field) => [
      `changed ${field}`,
      (value) => { value.spaces[0].panes[0].binding[field] = field === "runtime" ? "hmux_standalone_v1" : field === "source" ? "ssh" : "other"; },
    ]),
    ["incomplete", (value) => {
      value.complete = false;
      value.truncation.panes = true;
      value.truncation.omittedPaneCount = 1;
    }],
    ["invalid", (value) => { value.schemaVersion = 999; }],
    ["ambiguous", (value) => {
      value.spaces.push({ ...structuredClone(value.spaces[0]), id: "space-b" });
    }],
  ])("keeps runtime observation when the optional pane is %s", (_name, change) => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, hmuxSession());
    const presentation = agentPresentation("agent:agent-1");
    const agent = {
      id: "agent-1", name: "Codex",
      runtimeBinding: { ...presentation.spaces[0].panes[0].binding, ...hostGeneration() },
    };
    change(presentation);
    writeRegistry(root, [agent], presentation);
    const result = runCli(root, hmux, ["sessions", "show", "session-1", "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).session).toMatchObject({
      sessionId: "session-1", workspaceId: "workspace-1",
      liveness: { state: "alive", exactGeneration: true },
      clientProjection: {
        state: "current",
        agents: [{ id: "agent-1", pane: { id: null, state: "unavailable" } }],
      },
    });
  });

  it("requests a client-prioritized Hmux catalog below the one MiB capture boundary", async () => {
    const calls = [];
    const session = hmuxSession();
    const registry = {
      state: "available",
      clientId: "client:test",
      updatedAtMs: 1,
      agents: [
        {
          id: "agent-1",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source: "local",
            hostId: "local",
            ...hostGeneration(),
          },
        },
      ],
    };
    const report = await collectSessionQuery({
      action: "list",
      registry,
      probeBudgetMs: 0,
      execute: async (argv, options) => {
        calls.push({ argv, options });
        if (argv.includes("capabilities")) {
          return {
            kind: "success",
            stdout: JSON.stringify({
              schemaVersion: 2,
              capabilities: ["bounded_session_catalog_query_v1"],
            }),
            stderr: "",
          };
        }
        return {
          kind: "success",
          stdout: JSON.stringify({
            schemaVersion: 1,
            complete: true,
            prioritizedItems: 1,
            sessions: [session],
            truncation: { items: false, omittedCount: 0 },
          }),
          stderr: "",
        };
      },
    });

    expect(report.kind).toBe("dure.sessions.list");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      argv: ["hmux", "capabilities", "--json"],
      options: { maxCaptureBytes: 64 * 1024 },
    });
    expect(calls[1].options.maxCaptureBytes).toBe(1024 * 1024);
    expect(calls[1].options.timeoutMs).toBeLessThanOrEqual(2_500);
    const queryArgument = calls[1].argv.indexOf("--catalog-query-json");
    expect(queryArgument).toBeGreaterThan(0);
    expect(JSON.parse(calls[1].argv[queryArgument + 1])).toEqual({
      schemaVersion: 1,
      maxItems: 128,
      maxOutputBytes: 960 * 1024,
      prioritized: [{ sessionId: "session-1", workspaceId: "workspace-1" }],
    });
  });

  it("does not send the bounded catalog flag to an older direct Hmux", async () => {
    const calls = [];
    const report = await collectSessionQuery({
      action: "list",
      execute: async (argv, options) => {
        calls.push({ argv, options });
        return {
          kind: "success",
          stdout: JSON.stringify({ schemaVersion: 2, capabilities: [] }),
          stderr: "",
        };
      },
    });

    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      complete: false,
      error: {
        code: "dure_session_hmux_incompatible",
        capability: "bounded_session_catalog_query_v1",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["hmux", "capabilities", "--json"]);
    expect(calls[0].options).toMatchObject({
      timeoutMs: 2_500,
      maxCaptureBytes: 64 * 1024,
    });
  });

  it.each([["sessions", "show"], ["inspect"]])("queries one session through %j with exact workspace selection", (...command) => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, hmuxSession(), {
      requiredArguments: ["show", "session-1", "--workspace", "workspace-1"],
    });

    const result = runCli(root, hmux, [
      ...command,
      "session-1",
      "--workspace",
      "workspace-1",
      "--json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.show",
      complete: true,
      session: { sessionId: "session-1", workspaceId: "workspace-1" },
    });
  });

  it("projects the canonical exited failure through the existing show surface", () => {
    const root = temporaryRoot();
    const failure = {
      correlation_id: "failure_0123456789abcdef",
      session_id: "session-1",
      workspace_id: "workspace-1",
      terminal_epoch: "terminal-1",
      code: "provider_exited_before_conversation_identity",
      phase: "conversation_identity",
      summary:
        "Managed provider exited with status 1 before conversation identity was established.",
      exit_kind: "provider_error",
      exit_code: 1,
      occurred_unix_ms: "3000",
      retry_posture: "never",
    };
    const hmux = installHmuxStub(
      root,
      hmuxSession(1, {
        lifecycle: "exited",
        manifestLifecycle: "exited",
        effectiveLifecycle: "exited",
        health: "exited",
        exit: {
          exit_code: 1,
          platform_status: null,
          reason: "provider exited with status 1",
          kind: "providererror",
        },
        failure,
        providerConversationIdentity: null,
      }),
    );

    const json = runCli(root, hmux, [
      "sessions",
      "show",
      "session-1",
      "--workspace",
      "workspace-1",
      "--json",
    ]);
    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    expect(JSON.parse(json.stdout).session.failure).toEqual({
      correlationId: "failure_0123456789abcdef",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      terminalEpoch: "terminal-1",
      code: "provider_exited_before_conversation_identity",
      phase: "conversation_identity",
      summary:
        "Managed provider exited with status 1 before conversation identity was established.",
      exitKind: "provider_error",
      exitCode: 1,
      occurredUnixMs: "3000",
      retryPosture: "never",
    });

    const text = runCli(root, hmux, [
      "sessions",
      "show",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);
    expect(text.status, `${text.stdout}\n${text.stderr}`).toBe(0);
    expect(text.stdout).toContain(
      "provider_exited_before_conversation_identity (failure_0123456789abcdef)",
    );
  });

  it("fails closed on mismatched projections and reports bounded truncation", () => {
    const root = temporaryRoot();
    const sessions = Array.from({ length: 130 }, (_, index) =>
      hmuxSession(index + 1, {
        providerConversationIdentity: {
          ...hmuxSession(index + 1).providerConversationIdentity,
          terminal_epoch: "replacement-terminal",
        },
      }),
    );
    const hmux = installHmuxStub(root, sessions);
    writeRegistry(root, [
      {
        id: "stale-agent",
        name: "stale",
        displayName: "Stale",
        sessionId: "session-1",
        provider: "codex",
        worktree: "/stale",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          ...hostGeneration({ terminalEpoch: "replacement-terminal" }),
        },
      },
    ]);

    const producer = spawnSync(hmux, ["--json", "session", "list"], {
      encoding: "utf8",
    });
    expect(producer.status, producer.stderr).toBe(0);
    expect(JSON.parse(producer.stdout)).toHaveLength(130);
    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.sessions).toHaveLength(128);
    expect(report).toMatchObject({
      complete: true,
      partial: true,
      truncation: { items: true, omittedCount: 2 },
    });
    expect(report.sessions[0]).toMatchObject({
      conversationId: null,
      clientProjection: { state: "stale" },
    });
  });

  it("retains current client bindings when unrelated history exceeds the bounded result", () => {
    const root = temporaryRoot();
    const sessions = Array.from({ length: 130 }, (_, index) =>
      hmuxSession(index + 1, {
        branch: "x".repeat(8_192),
        ...(index === 129
          ? { effectiveLifecycle: "unprobed", health: "unprobed" }
          : {}),
      }),
    );
    const hmux = installHmuxStub(root, sessions, {
      probeStatuses: { "session-130": "healthy" },
    });
    writeRegistry(root, [
      {
        id: "current-agent",
        name: "current",
        displayName: "Current",
        sessionId: "session-130",
        provider: "codex",
        worktree: "/current",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          ...hostGeneration({
            sessionId: "session-130",
            workspaceId: "workspace-130",
          }),
        },
      },
    ]);

    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      complete: true,
      partial: true,
      truncation: { items: true },
    });
    expect(report.sessions.length).toBeLessThanOrEqual(128);
    expect(report.truncation.omittedCount).toBe(130 - report.sessions.length);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(report.sessions[0]).toMatchObject({
      sessionId: "session-130",
      workspaceId: "workspace-130",
      clientProjection: { state: "current" },
    });
  });

  it("keeps the safe census partial when exact batch probing is unavailable", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(
      root,
      [
        hmuxSession(1, {
          effectiveLifecycle: "unprobed",
          health: "unprobed",
        }),
      ],
      { probeBatchStatus: 9 },
    );
    writeRegistry(root, [
      {
        id: "current-agent",
        name: "current",
        displayName: "Current",
        sessionId: "session-1",
        provider: "codex",
        worktree: "/current",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          ...hostGeneration(),
        },
      },
    ]);

    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: true,
      partial: true,
      sessions: [
        {
          sessionId: "session-1",
          liveness: { exactGeneration: false, health: "unprobed" },
          clientProjection: { state: "runtime_unknown" },
        },
      ],
    });
  });

  it("returns a stable typed error when the Hmux producer fails", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "untrusted detail" }, { status: 9 });

    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.error",
      complete: false,
      error: { code: "hmux_session_query_failed" },
    });
    expect(result.stdout).not.toContain("untrusted detail");
  });

  it("does not certify a matching client binding when runtime probing is incomplete", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        effectiveLifecycle: "unprobed",
        health: "unprobed",
      }),
    ]);
    writeRegistry(root, [
      {
        id: "agent-1",
        name: "codex-1",
        displayName: "Codex 1",
        sessionId: "session-1",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "local",
          hostId: "local",
          ...hostGeneration(),
        },
      },
    ]);

    const result = runCli(root, hmux, ["sessions", "list", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ partial: true });
    expect(report.sessions[0]).toMatchObject({
      conversationId: null,
      cwd: null,
      liveness: { state: "unknown", exactGeneration: false },
      clientProjection: { state: "runtime_unknown" },
    });
  });

  it("queries a selected SSH backend without app state or local Hmux fallback", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession()]);
    writeRegistry(root, [
      {
        id: "remote-agent-1",
        name: "remote-codex-1",
        displayName: "Remote Codex 1",
        project: "Dure",
        sessionId: "session-1",
        provider: "codex",
        worktree: "/repo/worktree",
        runtimeBinding: {
          runtime: "hmux_managed_v1",
          source: "ssh",
          hostId: "remote-build",
          ...hostGeneration(),
        },
      },
    ]);

    const result = runCli(root, hmux, [
      "sessions",
      "list",
      "--backend",
      "remote-build",
      "--json",
    ], {
      PATH: `${remote.bin}:${process.env.PATH}`,
      DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      DURE_SESSION_REQUEST_LOG: remote.requestLog,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.list",
      source: {
        kind: "backend_profile",
        appDaemonRequired: false,
        profileId: "remote-build",
        transport: "ssh",
        backend: {
          id: "remote-backend",
          generation: "remote-generation-1",
        },
      },
      sessions: [
        {
          sessionId: "session-1",
          runtime: { generation: { hostInstanceId: "host-1" } },
          clientProjection: {
            state: "current",
            agents: [{ id: "remote-agent-1" }],
          },
        },
      ],
    });
    const listRequests = readFileSync(remote.requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]).toMatchObject({
      operation: "sessions.list",
      body: {
        schemaVersion: 1,
        maxItems: 128,
        prioritized: [
          { sessionId: "session-1", workspaceId: "workspace-1" },
        ],
      },
    });

    const shown = runCli(root, hmux, [
      "sessions",
      "show",
      "session-1",
      "--workspace",
      "workspace-1",
      "--backend",
      "remote-build",
      "--json",
    ], {
      PATH: `${remote.bin}:${process.env.PATH}`,
      DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
    });
    expect(shown.status, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      kind: "dure.sessions.show",
      session: { sessionId: "session-1", workspaceId: "workspace-1" },
    });
  });

  it("reads an exact SSH-backed managed session without app or local Hmux state", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession()]);

    const result = runCli(
      root,
      hmux,
      [
        "read",
        "session-1",
        "--workspace",
        "workspace-1",
        "--backend",
        "remote-build",
      ],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
        DURE_SESSION_REQUEST_LOG: remote.requestLog,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("remote managed screen\n");
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    const requests = readFileSync(remote.requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "sessions.read",
      expected: { requiredCapabilities: ["sessions.read"] },
      body: {
        schemaVersion: 1,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        lines: 20,
      },
    });
  });

  it("does not let stale client registry aliases override an exact backend read", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession()]);
    writeRegistry(root, [
      { id: "stale-1", name: "old-1", project: "Dure", sessionId: "session-1" },
      { id: "stale-2", name: "old-2", project: "Dure", sessionId: "session-1" },
    ]);

    const result = runCli(
      root,
      hmux,
      [
        "read",
        "session-1",
        "--workspace",
        "workspace-1",
        "--backend",
        "remote-build",
      ],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("remote managed screen\n");
  });

  it("rejects an invalid backend read identity before transport", async () => {
    let transportCalls = 0;
    const report = await collectSessionRead({
      backend: {
        profile: { id: "remote-build", transport: { kind: "ssh" } },
      },
      requestBackend: async () => {
        transportCalls += 1;
        throw new Error("transport must not execute");
      },
      sessionId: "session with space",
      workspaceId: "workspace-1",
    });

    expect(transportCalls).toBe(0);
    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      action: "read",
      error: { code: "dure_session_read_invalid" },
    });
  });

  it("rejects a backend read response for a different exact identity", async () => {
    const report = await collectSessionRead({
      backend: {
        profile: { id: "remote-build", transport: { kind: "ssh" } },
      },
      requestBackend: async () => ({
        backend: {
          id: "remote-backend",
          generation: "remote-generation-1",
          protocol: { major: 1, minor: 0 },
          capabilities: ["sessions.read"],
          observedAtMs: Date.now(),
        },
        result: {
          schemaVersion: 1,
          sessionId: "session-other",
          workspaceId: "workspace-1",
          sequenceThrough: "12",
          lines: ["wrong screen"],
        },
      }),
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      action: "read",
      error: {
        code: "dure_session_backend_payload_invalid",
        profileId: "remote-build",
      },
    });
  });

  it("keeps one remote Host identity while clients project independent panes", () => {
    const payload = [hmuxSession()];
    const queryClient = (clientId, agentId, hostId = "remote-build") => {
      const root = temporaryRoot();
      const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
      const remote = installRemoteBackendFixture(root, payload);
      writeRegistry(root, [
        {
          id: agentId,
          name: agentId,
          displayName: agentId,
          project: "Dure",
          sessionId: "session-1",
          provider: "codex",
          worktree: "/repo/worktree",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source: "ssh",
            hostId,
            ...hostGeneration(),
          },
        },
      ], agentPresentation(`slot-${clientId}`, agentId, "ssh", hostId));
      const result = runCli(
        root,
        hmux,
        ["sessions", "list", "--backend", "remote-build", "--json"],
        {
          PATH: `${remote.bin}:${process.env.PATH}`,
          DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
          DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
          DURE_CLIENT_ID: clientId,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      return JSON.parse(result.stdout);
    };

    const first = queryClient("desktop-a", "agent-a");
    const second = queryClient("desktop-b", "agent-b");
    expect(first.source.backend).toMatchObject({
      id: second.source.backend.id,
      generation: second.source.backend.generation,
      protocol: second.source.backend.protocol,
      capabilities: second.source.backend.capabilities,
    });
    expect(first.sessions[0].runtime).toMatchObject(second.sessions[0].runtime);
    expect(first.sessions[0].clientProjection).toMatchObject({
      clientId: "client:desktop-a",
      agents: [{ id: "agent-a", pane: { id: "slot-desktop-a", state: "observed" } }],
    });
    expect(second.sessions[0].clientProjection).toMatchObject({
      clientId: "client:desktop-b",
      agents: [{ id: "agent-b", pane: { id: "slot-desktop-b", state: "observed" } }],
    });
    const differentHost = queryClient(
      "desktop-c",
      "agent-c",
      "different-remote",
    );
    expect(differentHost.sessions[0].clientProjection).toMatchObject({
      state: "absent",
      clientId: "client:desktop-c",
      agents: [],
    });
  });

  it.each([
    {
      profileId: "local",
      transportKind: "local",
      bindingSource: "local",
      bindingHostId: "local",
    },
    {
      profileId: "remote-build",
      transportKind: "ssh",
      bindingSource: "ssh",
      bindingHostId: "remote-build",
    },
  ])(
    "passes exact client priorities to a capable $transportKind backend",
    async ({ profileId, transportKind, bindingSource, bindingHostId }) => {
      let request;
      const report = await collectSessionQuery({
        action: "list",
        backend: {
          profile: {
            id: profileId,
            transport: { kind: transportKind },
            expected: {
              capabilities: [
                "sessions.list",
                "sessions.list.bounded_catalog_v1",
              ],
            },
          },
          transportOptions: {},
        },
        registry: {
          state: "available",
          clientId: "client:test",
          updatedAtMs: 1,
          agents: [
            {
              id: "agent-1",
              runtimeBinding: {
                runtime: "hmux_managed_v1",
                source: bindingSource,
                hostId: bindingHostId,
                ...hostGeneration(),
              },
            },
          ],
        },
        requestBackend: async (_profile, nextRequest) => {
          request = nextRequest;
          return {
            backend: {
              id: "backend",
              generation: "generation",
              protocol: { major: 1, minor: 0 },
              capabilities: ["sessions.list"],
              observedAtMs: Date.now(),
            },
            result: {
              schemaVersion: 1,
              complete: true,
              sessions: [hmuxSession()],
            },
          };
        },
      });

      expect(report.kind).toBe("dure.sessions.list");
      expect(request.body).toEqual({
        schemaVersion: 1,
        probeBudgetMs: 1_000,
        maxItems: 128,
        prioritized: [
          { sessionId: "session-1", workspaceId: "workspace-1" },
        ],
      });
    },
  );

  it("keeps the legacy sessions.list request shape for an older backend", async () => {
    let request;
    const report = await collectSessionQuery({
      action: "list",
      backend: {
        profile: {
          id: "remote-build",
          transport: { kind: "ssh" },
          expected: { capabilities: ["sessions.list"] },
        },
        transportOptions: {},
      },
      requestBackend: async (_profile, nextRequest) => {
        request = nextRequest;
        return {
          backend: {
            id: "backend",
            generation: "generation",
            protocol: { major: 1, minor: 0 },
            capabilities: ["sessions.list"],
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, complete: true, sessions: [] },
        };
      },
    });

    expect(report.kind).toBe("dure.sessions.list");
    expect(request.body).toEqual({
      schemaVersion: 1,
      probeBudgetMs: 1_000,
      maxItems: 128,
    });
  });

  it.each([
    "backend_transport_reference_unavailable",
    "backend_transport_ssh_failed",
    "backend_transport_timeout",
    "backend_transport_protocol_incompatible",
    "backend_transport_generation_mismatch",
  ])("preserves typed remote failure %s without local fallback", async (code) => {
    let localExecuted = false;
    const report = await collectSessionQuery({
      action: "list",
      backend: {
        profile: { id: "remote-build", transport: { kind: "ssh" } },
      },
      execute: async () => {
        localExecuted = true;
        throw new Error("local fallback executed");
      },
      requestBackend: async () => {
        throw new BackendTransportError(code);
      },
    });
    expect(localExecuted).toBe(false);
    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      source: { kind: "backend_profile", appDaemonRequired: false },
      error: { code, profileId: "remote-build" },
    });
  });

  it("preserves the validated remote retry disposition", async () => {
    const report = await collectSessionQuery({
      action: "list",
      backend: {
        profile: { id: "remote-build", transport: { kind: "ssh" } },
      },
      requestBackend: async () => {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { code: "remote_busy", disposition: "retry_same" },
        });
      },
    });

    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      error: {
        code: "backend_transport_remote_error",
        remoteCode: "remote_busy",
        disposition: "retry_same",
      },
    });
  });

  it.each([
    {
      code: "recovering",
      lifecycle: { status: "recovering", retryable: true },
    },
    {
      code: "cli_update_required",
      lifecycle: {
        status: "cli_update_required",
        retryable: false,
        action: {
          label: "Update Dure App",
          command: "dure install --global",
        },
      },
    },
  ])("preserves local backend lifecycle receipt $code", async ({ code, lifecycle }) => {
    let localExecuted = false;
    const report = await collectSessionQuery({
      action: "list",
      backend: { error: new LocalBackendError(code) },
      execute: async () => {
        localExecuted = true;
        throw new Error("local fallback executed");
      },
    });

    expect(localExecuted).toBe(false);
    expect(report).toMatchObject({
      kind: "dure.sessions.error",
      action: "list",
      source: { kind: "backend_profile", appDaemonRequired: false },
      error: { code, ...lifecycle },
    });
  });
});

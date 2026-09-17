import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installHmuxStub as installCanonicalHmuxStub,
  runSessionCli as runCli,
} from "./lib/dure-session-test-fixture.mjs";
import { installRemoteBackendFixture as installSshBackendFixture } from "./lib/dure-cli-ssh-fixture.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-spaces-"));
  temporaryRoots.push(root);
  return root;
}

function hostGeneration() {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    runnerPrincipal: "runner",
    runnerInstance: "runner-1",
    channelEpoch: "7",
    hostInstanceId: "host-1",
    terminalEpoch: "terminal-1",
  };
}

function hmuxSession() {
  return {
    schema_version: 1,
    session_id: "session-1",
    session_name: "codex-1",
    workspace_id: "workspace-1",
    session_class: "managed",
    lifecycle: "ready",
    provider_id: "codex",
    runtime_host: null,
    worktree_alias: null,
    branch: "agent/codex-1",
    launch_program: "codex",
    runner_principal: "runner",
    runner_instance: "runner-1",
    channel_epoch: "7",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    output_seq: "12",
    host_build_version: "0.1.4",
    supported_protocol: {
      minimum: { major: 1, minor: 0 },
      maximum: { major: 1, minor: 0 },
    },
    capabilities: ["provider_conversation_identity_v1"],
    retirement_policy: null,
    host_process: { process_id: 101, start_marker: "host-start-1" },
    provider_process: { process_id: 202, start_marker: "provider-start-1" },
    endpoint: { kind: "unix_socket", address: "/private/runtime.sock" },
    created_unix_ms: "1000",
    lifecycle_changed_unix_ms: "2000",
    exit: null,
    manifestLifecycle: "ready",
    effectiveLifecycle: "ready",
    health: "healthy",
    recoverability: "live_attach",
    workingDirectory: {
      terminal_epoch: "terminal-1",
      observed_through_output_seq: "11",
      path: "/repo/worktree",
      source: "process_inspection",
    },
    providerConversationIdentity: {
      session_id: "session-1",
      workspace_id: "workspace-1",
      runner_principal: "runner",
      runner_instance: "runner-1",
      channel_epoch: "7",
      host_instance_id: "host-1",
      terminal_epoch: "terminal-1",
      revision: "3",
      observed_through_output_seq: "11",
      provider_id: "codex",
      conversation_id: "conversation-1",
      source: "provider_event",
    },
    recoveredPresentation: null,
  };
}

function binding(source, hostId) {
  return {
    schemaVersion: 1,
    runtime: "hmux_managed_v1",
    source,
    hostId,
    workspaceId: "workspace-1",
    sessionId: "session-1",
  };
}

function clientPresentation(spaces) {
  return {
    schemaVersion: 2,
    complete: true,
    spaces: spaces.map((space) => ({
      ...space,
      windowLabel:
        space.windowLabel ??
        (space.kind === "popout" ? `win-popout-${space.id}` : "main"),
    })),
    limits: { maxSpaces: 64, maxPanesPerSpace: 128, maxTotalPanes: 512 },
    truncation: {
      spaces: false,
      panes: false,
      omittedSpaceCount: 0,
      omittedPaneCount: 0,
    },
  };
}

function pane(id, runtimeBinding, { agentId = null, type = "terminal" } = {}) {
  return {
    id,
    type,
    component: type === "agent" ? "agent" : "terminal",
    agentId,
    binding: runtimeBinding,
  };
}

function writeRegistry(
  root,
  presentation,
  source = "local",
  {
    workspaceId = "workspace-1",
    sessionId = "session-1",
    includeAgent = true,
  } = {},
) {
  mkdirSync(root, { recursive: true });
  const agents = includeAgent
    ? [
        {
          id: "agent-1",
          name: "codex-1",
          displayName: "Codex 1",
          project: "Dure",
          sessionId,
          provider: "codex",
          worktree: "/repo/worktree",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source,
            hostId: source === "ssh" ? "remote-build" : "local",
            ...hostGeneration({ workspaceId, sessionId }),
            conversationIdentity: {
              ...hostGeneration({ workspaceId, sessionId }),
              providerId: "codex",
              conversationId: "conversation-1",
            },
          },
        },
      ]
    : [];
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({
      version: 3,
      updatedAt: Date.now() - 25,
      clientPresentation: presentation,
      agents,
    }),
    { mode: 0o600 },
  );
}

function numberedHmuxSession(index) {
  const session = hmuxSession();
  const sessionId = `session-${index}`;
  const workspaceId = `workspace-${index}`;
  return {
    ...session,
    session_id: sessionId,
    session_name: `agent-${index}`,
    workspace_id: workspaceId,
    branch: "x".repeat(8_192),
    providerConversationIdentity: {
      ...session.providerConversationIdentity,
      session_id: sessionId,
      workspace_id: workspaceId,
    },
  };
}

const OVERSIZED_SESSION_ID = `session-${"s".repeat(500)}`;
const OVERSIZED_WORKSPACE_ID = `workspace-${"w".repeat(500)}`;

/** A client projection that satisfies every presentation bound on its own — one
 * space, exactly MAX_SPACE_QUERY_PANES_PER_SPACE panes, ids within 512 chars —
 * yet whose 128x8 pane/agent fan-out serializes past
 * MAX_SESSION_QUERY_OUTPUT_BYTES once joined to runtime facts. Returns the Hmux
 * session the panes bind to. */
function oversizedRegistry(root) {
  const paneBinding = {
    schemaVersion: 1,
    runtime: "hmux_managed_v1",
    source: "local",
    hostId: "local",
    workspaceId: OVERSIZED_WORKSPACE_ID,
    sessionId: OVERSIZED_SESSION_ID,
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({
      version: 3,
      updatedAt: Date.now() - 25,
      clientPresentation: clientPresentation([
        {
          id: "desk-big",
          name: "Big",
          kind: "desktop",
          panes: Array.from({ length: 128 }, (_, index) =>
            pane(`term:${index}-${"p".repeat(500)}`, paneBinding),
          ),
        },
      ]),
      // 8 is the per-session agent cap in clientProjection(); every pane leaves
      // agentId null so the projection carries all eight candidates.
      agents: Array.from({ length: 8 }, (_, index) => {
        const id = `agent-${index}-${"a".repeat(500)}`;
        return {
          id,
          name: id,
          displayName: id,
          project: id,
          sessionId: OVERSIZED_SESSION_ID,
          provider: "codex",
          worktree: "/repo/worktree",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source: "local",
            hostId: "local",
            ...hostGeneration(),
            sessionId: OVERSIZED_SESSION_ID,
            workspaceId: OVERSIZED_WORKSPACE_ID,
          },
        };
      }),
    }),
    { mode: 0o600 },
  );
  const session = hmuxSession();
  return {
    ...session,
    session_id: OVERSIZED_SESSION_ID,
    workspace_id: OVERSIZED_WORKSPACE_ID,
    workingDirectory: {
      ...session.workingDirectory,
      path: `/repo/${"d".repeat(4_000)}`,
    },
    providerConversationIdentity: {
      ...session.providerConversationIdentity,
      session_id: OVERSIZED_SESSION_ID,
      workspace_id: OVERSIZED_WORKSPACE_ID,
    },
  };
}

function installHmuxStub(root, payload, markerPath = null, probeStatuses = {}) {
  return installCanonicalHmuxStub(root, payload, {
    markerPath,
    probeStatuses,
  });
}

// Shared SSH backend fixture pinned to this file's session payload and the
// spaces capability posture.
function installRemoteBackendFixture(root, options = {}) {
  return installSshBackendFixture(root, [hmuxSession()], {
    capabilities: ["sessions.list", "sessions.show"],
    ...options,
  });
}

describe("dure spaces list/show", () => {
  it("lists client spaces and shows every pane with exact shared runtime facts", () => {
    const root = temporaryRoot();
    const localBinding = binding("local", "local");
    writeRegistry(
      root,
      clientPresentation([
        {
          id: "desktop-a",
          name: "Main",
          kind: "desktop",
          panes: [
            pane("agent:agent-1", localBinding, {
              agentId: "agent-1",
              type: "agent",
            }),
            {
              id: "browser:docs",
              type: "browser",
              component: "browser",
              agentId: null,
              binding: null,
            },
          ],
        },
        {
          id: "desktop-b",
          name: "Second view",
          kind: "desktop",
          panes: [pane("term:second-view", localBinding)],
        },
      ]),
    );
    const hmuxMarker = join(root, "hmux-executed");
    const hmux = installHmuxStub(root, [hmuxSession()], hmuxMarker);

    const listed = runCli(root, hmux, ["spaces", "list", "--json"]);
    expect(listed.status, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    expect(existsSync(hmuxMarker)).toBe(true);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      apiVersion: "dure.spaces/v1",
      kind: "dure.spaces.list",
      complete: true,
      source: { kind: "local_hmux", appDaemonRequired: false },
      spaces: [
        {
          id: "desktop-a",
          paneCount: 2,
          runtimeStates: { current: 1, unavailable: 1 },
        },
        {
          id: "desktop-b",
          paneCount: 1,
          runtimeStates: { current: 1 },
        },
      ],
    });
    expect(JSON.parse(listed.stdout).spaces[0]).not.toHaveProperty("panes");

    const shown = runCli(root, hmux, [
      "spaces",
      "show",
      "desktop-a",
      "--json",
    ]);
    expect(shown.status, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      kind: "dure.spaces.show",
      space: {
        id: "desktop-a",
        panes: [
          {
            id: "agent:agent-1",
            runtime: {
              state: "current",
              session: {
                sessionId: "session-1",
                workspaceId: "workspace-1",
                generation: { hostInstanceId: "host-1", terminalEpoch: "terminal-1" },
                liveness: { state: "alive", exactGeneration: true },
              },
              agentProjection: {
                state: "current",
                requestedAgentId: "agent-1",
                candidates: [{ id: "agent-1" }],
              },
            },
          },
          {
            id: "browser:docs",
            runtime: {
              state: "unavailable",
              reason: "session_binding_unavailable",
            },
          },
        ],
      },
    });
    expect(shown.stdout).not.toContain("/private/runtime.sock");
  });

  it("keeps a bound pane current when unrelated session history is truncated", () => {
    const root = temporaryRoot();
    const workspaceId = "workspace-130";
    const sessionId = "session-130";
    const currentBinding = {
      ...binding("local", "local"),
      workspaceId,
      sessionId,
    };
    writeRegistry(
      root,
      clientPresentation([
        {
          id: "desktop-current",
          name: "Current",
          kind: "desktop",
          panes: [pane("term:current", currentBinding)],
        },
      ]),
      "local",
      { workspaceId, sessionId, includeAgent: false },
    );
    const sessions = Array.from({ length: 130 }, (_, index) =>
      numberedHmuxSession(index + 1),
    );
    sessions[129] = {
      ...sessions[129],
      effectiveLifecycle: "unprobed",
      health: "unprobed",
    };
    const hmux = installHmuxStub(root, sessions, null, {
      "session-130": "healthy",
    });

    const shown = runCli(root, hmux, [
      "spaces",
      "show",
      "desktop-current",
      "--json",
    ]);
    expect(shown.status, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    const report = JSON.parse(shown.stdout);
    expect(report).toMatchObject({
      partial: true,
      truncation: { runtimeSessions: { items: true } },
      space: {
        runtimeStates: { current: 1, unavailable: 0 },
        panes: [
          {
            id: "term:current",
            runtime: {
              state: "current",
              session: { workspaceId, sessionId },
            },
          },
        ],
      },
    });
    expect(report.truncation.runtimeSessions.omittedCount).toBeGreaterThan(2);
  });

  it("keeps remote runtime truth shared while clients keep different spaces", () => {
    const queryClient = (clientId, spaceId, paneId) => {
      const root = temporaryRoot();
      const remoteBinding = binding("ssh", "remote-build");
      writeRegistry(
        root,
        clientPresentation([
          {
            id: spaceId,
            name: spaceId,
            kind: "desktop",
            panes: [
              pane(paneId, remoteBinding, {
                agentId: "agent-1",
                type: "agent",
              }),
            ],
          },
        ]),
        "ssh",
      );
      const marker = join(root, "local-hmux-executed");
      const hmux = installHmuxStub(root, [], marker);
      const remote = installRemoteBackendFixture(root);
      const result = runCli(
        root,
        hmux,
        ["spaces", "show", spaceId, "--backend", "remote-build", "--json"],
        {
          PATH: `${remote.bin}:${process.env.PATH}`,
          DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
          DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
          DURE_CLIENT_ID: clientId,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(existsSync(marker)).toBe(false);
      return JSON.parse(result.stdout);
    };

    const first = queryClient("client-a", "desktop-a", "agent:view-a");
    const second = queryClient("client-b", "desktop-b", "agent:view-b");
    expect(first.source.backend).toMatchObject({
      id: second.source.backend.id,
      generation: second.source.backend.generation,
      protocol: second.source.backend.protocol,
      capabilities: second.source.backend.capabilities,
    });
    expect(first.space.panes[0].runtime.session).toMatchObject({
      sessionId: second.space.panes[0].runtime.session.sessionId,
      workspaceId: second.space.panes[0].runtime.session.workspaceId,
      generation: second.space.panes[0].runtime.session.generation,
      provider: second.space.panes[0].runtime.session.provider,
      cwd: second.space.panes[0].runtime.session.cwd,
      liveness: {
        state: second.space.panes[0].runtime.session.liveness.state,
        health: second.space.panes[0].runtime.session.liveness.health,
        exactGeneration:
          second.space.panes[0].runtime.session.liveness.exactGeneration,
      },
    });
    expect(first).toMatchObject({
      client: { id: "client:client-a" },
      space: { id: "desktop-a", panes: [{ id: "agent:view-a" }] },
    });
    expect(second).toMatchObject({
      client: { id: "client:client-b" },
      space: { id: "desktop-b", panes: [{ id: "agent:view-b" }] },
    });
  });

  it("does not join a pane to a different remote backend target", () => {
    const root = temporaryRoot();
    writeRegistry(
      root,
      clientPresentation([
        {
          id: "desktop-remote",
          name: "Remote",
          kind: "desktop",
          panes: [
            pane("agent:agent-1", binding("ssh", "different-remote"), {
              agentId: "agent-1",
              type: "agent",
            }),
          ],
        },
      ]),
      "ssh",
    );
    const marker = join(root, "local-hmux-executed");
    const hmux = installHmuxStub(root, [], marker);
    const remote = installRemoteBackendFixture(root);

    const result = runCli(
      root,
      hmux,
      ["spaces", "show", "desktop-remote", "--backend", "remote-build", "--json"],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      space: {
        panes: [
          {
            runtime: {
              state: "unavailable",
              reason: "backend_target_mismatch",
              binding: { hostId: "different-remote" },
            },
          },
        ],
      },
    });
  });

  it("returns a typed remote failure without running local Hmux", () => {
    const root = temporaryRoot();
    const remoteBinding = binding("ssh", "remote-build");
    writeRegistry(
      root,
      clientPresentation([
        {
          id: "desktop-remote",
          name: "Remote",
          kind: "desktop",
          panes: [pane("agent:agent-1", remoteBinding)],
        },
      ]),
      "ssh",
    );
    const marker = join(root, "local-hmux-executed");
    const hmux = installHmuxStub(root, [], marker);
    const remote = installRemoteBackendFixture(root, { fail: true });

    const result = runCli(
      root,
      hmux,
      ["spaces", "list", "--backend", "remote-build", "--json"],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      },
    );
    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.spaces.error",
      source: { kind: "backend_profile", appDaemonRequired: false },
      error: {
        code: "backend_transport_ssh_failed",
        upstream: "sessions.list",
        profileId: "remote-build",
      },
    });
  });

  it("fails closed on absent, invalid, and oversized client projections", () => {
    const root = temporaryRoot();
    const marker = join(root, "local-hmux-executed");
    const hmux = installHmuxStub(root, [hmuxSession()], marker);
    writeFileSync(
      join(root, "agents.json"),
      JSON.stringify({ version: 3, updatedAt: Date.now(), agents: [] }),
      { mode: 0o600 },
    );
    const absent = runCli(root, hmux, ["spaces", "list", "--json"]);
    expect(absent.status).toBe(2);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      error: { code: "dure_space_client_projection_absent" },
    });
    expect(existsSync(marker)).toBe(false);

    writeRegistry(root, {
      ...clientPresentation([]),
      spaces: Array.from({ length: 65 }, (_, index) => ({
        id: `space-${index}`,
        name: `Space ${index}`,
        kind: "desktop",
        panes: [],
      })),
    });
    const oversized = runCli(root, hmux, ["spaces", "list", "--json"]);
    expect(oversized.status).toBe(2);
    expect(JSON.parse(oversized.stdout)).toMatchObject({
      error: { code: "dure_space_client_projection_invalid" },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed when the projected report exceeds the output byte bound", () => {
    const root = temporaryRoot();
    const marker = join(root, "local-hmux-executed");
    const hmux = installHmuxStub(root, [oversizedRegistry(root)], marker);

    const shown = runCli(root, hmux, ["spaces", "show", "desk-big", "--json"]);

    expect(shown.status, `${shown.stdout}\n${shown.stderr}`).toBe(2);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      apiVersion: "dure.spaces/v1",
      kind: "dure.spaces.error",
      action: "show",
      complete: false,
      error: { code: "dure_space_query_output_limit" },
      limits: { maxOutputBytes: 1024 * 1024 },
    });
    // The bound must fail closed with a small envelope, never by emitting the
    // oversized report it just rejected.
    expect(shown.stdout.length).toBeLessThan(4_096);
  });

  it("rejects an out-of-range deadline without running Hmux", () => {
    const root = temporaryRoot();
    writeRegistry(
      root,
      clientPresentation([
        {
          id: "desk-1",
          name: "Desk",
          kind: "desktop",
          panes: [
            pane("agent:agent-1", binding("local", "local"), {
              agentId: "agent-1",
              type: "agent",
            }),
          ],
        },
      ]),
    );
    const marker = join(root, "local-hmux-executed");
    const hmux = installHmuxStub(root, [hmuxSession()], marker);

    // MAX_SESSION_QUERY_DEADLINE_MS is 10_000 and the minimum is 1; both edges
    // must be refused before any child process is spawned.
    for (const deadlineMs of ["15000", "0"]) {
      for (const command of [
        ["spaces", "list", "--json"],
        ["spaces", "show", "desk-1", "--json"],
      ]) {
        const label = `${command.join(" ")} --deadline-ms ${deadlineMs}`;
        const result = runCli(root, hmux, [
          ...command,
          "--deadline-ms",
          deadlineMs,
        ]);
        expect(result.status, `${label}: ${result.stdout}${result.stderr}`).toBe(
          2,
        );
        expect(JSON.parse(result.stdout), label).toMatchObject({
          kind: "dure.spaces.error",
          complete: false,
          error: {
            code: "dure_session_query_invalid",
            upstream: "sessions.list",
          },
        });
        expect(existsSync(marker), label).toBe(false);
      }
    }

    // The same bound guards the sessions surface that spaces delegates to.
    const sessions = runCli(root, hmux, [
      "sessions",
      "list",
      "--json",
      "--deadline-ms",
      "15000",
    ]);
    expect(sessions.status, `${sessions.stdout}\n${sessions.stderr}`).toBe(2);
    expect(JSON.parse(sessions.stdout)).toMatchObject({
      kind: "dure.sessions.error",
      error: { code: "dure_session_query_invalid" },
    });
    expect(existsSync(marker)).toBe(false);
  });
});


describe("saved Space names and pane titles (#230)", () => {
  it("resolves an unambiguous name and preserves saved pane order and titles without an app", () => {
    const root = temporaryRoot();
    const hmux = installCanonicalHmuxStub(root, []);
    const presentation = clientPresentation([{ id: "desk-a", name: "Review Space", kind: "desktop", panes: [
      { ...pane("term:z", null), title: "Review terminal" },
      { ...pane("term:a", null), title: "Build logs" },
    ] }]);
    presentation.schemaVersion = 3;
    writeRegistry(root, presentation, "local", { includeAgent: false });
    expect(existsSync(join(root, "server.json"))).toBe(false);
    const result = runCli(root, hmux, ["spaces", "show", "Review Space", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.space.id).toBe("desk-a");
    expect(report.space.panes.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "term:z", title: "Review terminal" }, { id: "term:a", title: "Build logs" },
    ]);
    const human = runCli(root, hmux, ["spaces", "show", "desk-a"]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("Review terminal");
    expect(human.stdout).toContain("Build logs");
    expect(human.stdout.indexOf("term:z")).toBeLessThan(human.stdout.indexOf("term:a"));
  });

  it("rejects ambiguous or incomplete names while exact IDs remain usable", () => {
    const root = temporaryRoot();
    const hmux = installCanonicalHmuxStub(root, []);
    const presentation = clientPresentation([
      { id: "desk-a", name: "Shared", kind: "desktop", panes: [] },
      { id: "desk-b", name: "Shared", kind: "desktop", panes: [] },
      { id: "Shared", name: "Exact ID wins", kind: "desktop", panes: [] },
    ]);
    writeRegistry(root, presentation, "local", { includeAgent: false });
    const exact = runCli(root, hmux, ["spaces", "show", "Shared", "--json"]);
    expect(exact.status).toBe(0);
    expect(JSON.parse(exact.stdout).space.name).toBe("Exact ID wins");
    presentation.spaces.pop();
    writeRegistry(root, presentation, "local", { includeAgent: false });
    const ambiguous = runCli(root, hmux, ["spaces", "show", "Shared", "--json"]);
    expect(ambiguous.status).toBe(2);
    expect(JSON.parse(ambiguous.stdout).error.code).toBe("dure_space_ambiguous");
    presentation.spaces.pop();
    presentation.complete = false;
    presentation.truncation.spaces = true;
    presentation.truncation.omittedSpaceCount = 1;
    writeRegistry(root, presentation, "local", { includeAgent: false });
    const incomplete = runCli(root, hmux, ["spaces", "show", "Shared", "--json"]);
    expect(incomplete.status).toBe(2);
    expect(JSON.parse(incomplete.stdout).error.code).toBe("dure_space_projection_partial");
    expect(runCli(root, hmux, ["spaces", "show", "desk-a", "--json"]).status).toBe(0);
  });

  it("reads older title-free snapshots with an explicitly unavailable title", () => {
    const root = temporaryRoot();
    const hmux = installCanonicalHmuxStub(root, []);
    writeRegistry(root, clientPresentation([
      { id: "desk-a", name: "Old snapshot", kind: "desktop", panes: [pane("term:a", null)] },
    ]), "local", { includeAgent: false });
    const result = runCli(root, hmux, ["spaces", "show", "Old snapshot", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).space.panes[0].title).toBeNull();
  });

  it.each([undefined, 42, "unsafe\nlabel", "x".repeat(257)])("rejects malformed title data before querying a runtime (%j)", (title) => {
    const root = temporaryRoot();
    const marker = join(root, "unexpected-runtime-query");
    const hmux = installCanonicalHmuxStub(root, [], { markerPath: marker });
    const presentation = clientPresentation([
      { id: "desk-a", name: "Review", kind: "desktop", panes: [{ ...pane("term:a", null), title }] },
    ]);
    presentation.schemaVersion = 3;
    writeRegistry(root, presentation, "local", { includeAgent: false });
    const result = runCli(root, hmux, ["spaces", "show", "desk-a", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("dure_space_client_projection_invalid");
    expect(existsSync(marker)).toBe(false);
  });
});

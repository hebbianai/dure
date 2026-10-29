import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hmuxSession,
  hostGeneration,
  installHmuxStub,
  installRemoteBackendFixture,
  runSessionCli,
  writeRegistry,
} from "./lib/dure-session-test-fixture.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-ls-"));
  temporaryRoots.push(root);
  return root;
}

describe("dure ls canonical session projection", () => {
  it("lists exact local Sessions without app state", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession()]);

    const result = runSessionCli(root, hmux, ["ls", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.sessions/v1",
      kind: "dure.sessions.list",
      complete: true,
      source: { kind: "local_hmux", appDaemonRequired: false },
      sessions: [
        {
          sessionId: "session-1",
          workspaceId: "workspace-1",
          liveness: { state: "alive", exactGeneration: true },
        },
      ],
    });
  });

  it("shows CWD in table output when working directory is available", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        workingDirectory: {
          terminal_epoch: "terminal-1",
          observed_through_output_seq: "11",
          path: "/home/user/project",
          source: "process_inspection",
        },
      }),
    ], {
      capabilities: [
        "bounded_session_catalog_query_v1",
        "exact_session_probe_runtime_state_v1",
        "exact_session_probe_working_directory_v1",
      ],
    });

    const result = runSessionCli(root, hmux, ["ls"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("/home/user/project");
  });

  it("leaves CWD empty when Hmux predates the working directory probe", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession(1)], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const result = runSessionCli(root, hmux, ["ls", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const [session] = JSON.parse(result.stdout).sessions;
    expect(session.liveness.state).toBe("alive");
    expect(session.cwd).toBeNull();
  });

  it("shows CWD in JSON output when working directory is available", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        workingDirectory: {
          terminal_epoch: "terminal-1",
          observed_through_output_seq: "11",
          path: "/home/user/project",
          source: "process_inspection",
        },
      }),
    ], {
      capabilities: [
        "bounded_session_catalog_query_v1",
        "exact_session_probe_working_directory_v1",
      ],
    });

    const result = runSessionCli(root, hmux, ["ls", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions[0].cwd).toBe("/home/user/project");
  });

  it("shows dash for CWD in table output when working directory is unavailable", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { workingDirectory: undefined }),
    ]);

    const result = runSessionCli(root, hmux, ["ls"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const dataLine = lines[1];
    const columns = dataLine.split("\t");
    const cwdIndex = lines[0].split("\t").indexOf("CWD");
    expect(cwdIndex).toBeGreaterThan(-1);
    expect(columns[cwdIndex]).toBe("-");
  });

  it("shows activity state in table output when agent runtime state is available", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        agentRuntimeState: {
          terminal_epoch: "terminal-1",
          revision: "3",
          observed_through_output_seq: "11",
          lifecycle: "running",
          activity: "working",
          attention: "none",
          attention_id: null,
          source: "provider_event",
          turn_completed_count: "0",
        },
      }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const result = runSessionCli(root, hmux, ["ls"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("working");
  });

  it("shows activity state in JSON output when agent runtime state is available", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        agentRuntimeState: {
          terminal_epoch: "terminal-1",
          revision: "3",
          observed_through_output_seq: "11",
          lifecycle: "running",
          activity: "waiting",
          attention: "none",
          attention_id: null,
          source: "provider_event",
          turn_completed_count: "1",
        },
      }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const result = runSessionCli(root, hmux, ["ls", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions[0].runtime.agentRuntimeState.activity).toBe("waiting");
  });

  it("filters sessions with --alive to show only live sessions", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { lifecycle: "ready", health: "healthy" }),
      hmuxSession(2, { lifecycle: "exited", health: "exited", exit: { kind: "normal", exit_code: 0 } }),
    ]);

    const result = runSessionCli(root, hmux, ["ls", "--alive", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].sessionId).toBe("session-1");
  });

  it("finds a live successor that sorts past the first page while its exited predecessor keeps priority", () => {
    const root = temporaryRoot();
    const exited = { lifecycle: "exited", health: "exited", manifestLifecycle: "exited",
      effectiveLifecycle: "exited", exit: { kind: "normal", exit_code: 0 } };
    // An account switch leaves the predecessor as an exited tombstone and starts
    // an unnamed successor in the same workspace; the app registry still names
    // the predecessor until it re-projects the transition.
    const sessions = [
      ...Array.from({ length: 140 }, (_, index) => hmuxSession(index + 1, exited)),
      hmuxSession(141, { session_id: "runtime-native-successor", workspace_id: "workspace-zz-lead" }),
    ];
    const hmux = installHmuxStub(root, sessions, {
      capabilities: ["bounded_session_catalog_query_v1", "bounded_session_catalog_pagination_v1"],
    });
    writeRegistry(root, [{
      id: "agent-lead", name: "lead", displayName: "lead", sessionId: "session-1",
      provider: "codex", worktree: "/repo",
      runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", ...hostGeneration() },
    }]);

    const result = runSessionCli(root, hmux, ["ls", "--alive", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions.map((session) => session.sessionId)).toEqual(["runtime-native-successor"]);
    expect(parsed).toMatchObject({ inventoryComplete: true, truncation: { items: false, omittedCount: 0 } });
    // Without --alive the bounded first page still reports its truncation.
    const unfiltered = JSON.parse(runSessionCli(root, hmux, ["ls", "--json"]).stdout);
    expect(unfiltered.truncation.items).toBe(true);
    expect(unfiltered.sessions.map((session) => session.sessionId)).not.toContain("runtime-native-successor");
  });

  it("keeps --alive to the first page with its truncation when Hmux cannot paginate", () => {
    const root = temporaryRoot();
    const exited = { lifecycle: "exited", health: "exited", exit: { kind: "normal", exit_code: 0 } };
    const sessions = [
      ...Array.from({ length: 129 }, (_, index) => hmuxSession(index + 1, exited)),
      hmuxSession(130, { session_id: "runtime-native-successor", workspace_id: "workspace-zz-lead" }),
    ];
    const hmux = installHmuxStub(root, sessions);

    const result = runSessionCli(root, hmux, ["ls", "--alive"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Inventory truncated.");
  });

  it("filters sessions with --hide-provider to exclude specific providers", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { provider_id: "codex" }),
      hmuxSession(2, { provider_id: "local-shell" }),
      hmuxSession(3, { provider_id: "claude" }),
    ]);

    const result = runSessionCli(root, hmux, ["ls", "--hide-provider", "local-shell", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].sessionId).toBe("session-1");
    expect(parsed.sessions[1].sessionId).toBe("session-3");
  });

  it("supports multiple --hide-provider flags", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { provider_id: "codex" }),
      hmuxSession(2, { provider_id: "local-shell" }),
      hmuxSession(3, { provider_id: "claude" }),
      hmuxSession(4, { provider_id: "cursor" }),
    ]);

    const result = runSessionCli(
      root,
      hmux,
      ["ls", "--hide-provider", "local-shell", "--hide-provider", "cursor", "--json"]
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0].provider.id).toBe("codex");
    expect(parsed.sessions[1].provider.id).toBe("claude");
  });

  it("combines --alive and --hide-provider filters", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { lifecycle: "ready", health: "healthy", provider_id: "codex" }),
      hmuxSession(2, { lifecycle: "exited", health: "exited", provider_id: "codex", exit: { kind: "normal", exit_code: 0 } }),
      hmuxSession(3, { lifecycle: "ready", health: "healthy", provider_id: "local-shell" }),
    ]);

    const result = runSessionCli(
      root,
      hmux,
      ["ls", "--alive", "--hide-provider", "local-shell", "--json"]
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].sessionId).toBe("session-1");
  });

  it("uses sessions.list through the selected backend profile", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession()]);

    const result = runSessionCli(
      root,
      hmux,
      ["ls", "--backend", "remote-build", "--json"],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
        DURE_SESSION_REQUEST_LOG: remote.requestLog,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.list",
      source: {
        kind: "backend_profile",
        appDaemonRequired: false,
        profileId: "remote-build",
      },
      sessions: [{ sessionId: "session-1", workspaceId: "workspace-1" }],
    });
    const requests = readFileSync(remote.requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "sessions.list",
      expected: { requiredCapabilities: ["sessions.list"] },
    });
  });
});

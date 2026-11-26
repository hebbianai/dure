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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hmuxSession,
  hostGeneration,
  installHmuxStub,
  installRemoteBackendFixture,
  runSessionCli,
  writeRegistry,
} from "./lib/dure-session-test-fixture.mjs";
import { FUNCTIONAL_DEADLINE_MS, sshBackendProfile } from "./lib/dure-cli-ssh-fixture.mjs";
import { LocalBackendError } from "../cli/lib/local-backend.mjs";
import { RECOVERY_WAITS_CAPABILITY } from "../cli/lib/recovery-waits.mjs";
import {
  collectSessionQuery,
  sessionQueryExitCode,
  withRecoveryWaits,
} from "../cli/lib/session-query.mjs";
import { collectAllBackendsSessionQuery } from "../cli/lib/session-query-all-backends.mjs";

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

  it("shows a ready prompt with background work in flight", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        agentRuntimeState: {
          terminal_epoch: "terminal-1",
          revision: "4",
          observed_through_output_seq: "11",
          lifecycle: "running",
          activity: "working",
          attention: "none",
          attention_id: null,
          source: "provider_event",
          turn_completed_count: "0",
          background_work: true,
        },
      }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const table = runSessionCli(root, hmux, ["ls"]);
    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    const [header, row] = table.stdout.trim().split("\n");
    expect(row.split("\t")[header.split("\t").indexOf("ACTIVITY")]).toBe("waiting+background");
    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    const state = JSON.parse(json.stdout).sessions[0].runtime.agentRuntimeState;
    expect(state.activity).toBe("working");
    expect(state.backgroundWork).toBe(true);
  });

  it("shows how many messages unsent input holds and for how long", () => {
    const root = temporaryRoot();
    const sinceMs = Date.now() - 12 * 60_000;
    const held = (lifecycle) => ({
      terminal_epoch: "terminal-1",
      revision: "5",
      observed_through_output_seq: "11",
      lifecycle,
      activity: "waiting",
      attention: "none",
      attention_id: null,
      source: "provider_event",
      turn_completed_count: "0",
      held_prompts: { count: "3", since_unix_ms: String(sinceMs) },
    });
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { agentRuntimeState: held("running") }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const table = runSessionCli(root, hmux, ["ls"]);
    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    const [header, row] = table.stdout.trim().split("\n");
    const columns = header.split("\t");
    expect(columns.indexOf("HELD")).toBe(columns.indexOf("IDLE") + 1);
    expect(row.split("\t")[columns.indexOf("HELD")]).toMatch(/^3 for 1[23]m \d+s$/);
    expect(row.split("\t")[columns.indexOf("IDLE")]).toBe("-");
    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    const [session] = JSON.parse(json.stdout).sessions;
    expect(session.heldPrompts).toEqual({ count: 3, sinceMs });
    expect(session.fieldSources.heldPrompts).toBe("hmux_host");
    expect(session.runtime.agentRuntimeState.heldPrompts).toEqual({ count: 3, sinceMs });

    const malformedRoot = temporaryRoot();
    const malformed = installHmuxStub(malformedRoot, [
      hmuxSession(1, {
        agentRuntimeState: { ...held("running"), held_prompts: { count: "0", since_unix_ms: "1" } },
      }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });
    const none = JSON.parse(runSessionCli(malformedRoot, malformed, ["ls", "--json"]).stdout).sessions[0];
    expect(none.runtime.agentRuntimeState.activity).toBe("waiting");
    expect(none.heldPrompts).toBeNull();
    expect(none.fieldSources.heldPrompts).toBe("unavailable");
  });

  it("shows the attention the provider asked for instead of a waiting activity", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        agentRuntimeState: {
          terminal_epoch: "terminal-1",
          revision: "2",
          observed_through_output_seq: "11",
          lifecycle: "running",
          activity: "waiting",
          attention: "input_required",
          attention_id: "attention-2",
          source: "provider_event",
          turn_completed_count: "0",
        },
      }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const table = runSessionCli(root, hmux, ["ls"]);
    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    const [header, row] = table.stdout.trim().split("\n");
    expect(row.split("\t")[header.split("\t").indexOf("ACTIVITY")]).toBe("input_required");
    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    const state = JSON.parse(json.stdout).sessions[0].runtime.agentRuntimeState;
    expect(state.activity).toBe("waiting");
    expect(state.attention).toBe("input_required");
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

  const IDLE_CAPABILITIES = [
    "bounded_session_catalog_query_v1",
    "exact_session_probe_runtime_state_v1",
    "exact_session_probe_semantic_idle_v1",
  ];
  const waitingState = {
    terminal_epoch: "terminal-1",
    revision: "3",
    observed_through_output_seq: "11",
    lifecycle: "running",
    activity: "waiting",
    attention: "none",
    attention_id: null,
    source: "provider_event",
    turn_completed_count: "1",
  };

  it("says since when a waiting agent has been idle", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { agentRuntimeState: waitingState, semanticIdleMs: "125000" }),
    ], { capabilities: IDLE_CAPABILITIES });

    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    const [session] = JSON.parse(json.stdout).sessions;
    expect(session.runtime.semanticIdleMs).toBe("125000");
    expect(session.idleSinceMs).toBe(session.liveness.observedAtMs - 125_000);
    expect(session.fieldSources.idleSinceMs).toBe("hmux_host");

    const table = runSessionCli(root, hmux, ["ls"]);
    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    const [header, row] = table.stdout.trim().split("\n");
    const columns = header.split("\t");
    expect(columns.indexOf("IDLE")).toBe(columns.indexOf("ACTIVITY") + 1);
    expect(row.split("\t")[columns.indexOf("IDLE")]).toBe("2m 5s");
  });

  it("leaves the idle time unknown when Hmux predates the semantic idle probe", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, { agentRuntimeState: waitingState, semanticIdleMs: "125000" }),
    ], {
      capabilities: ["bounded_session_catalog_query_v1", "exact_session_probe_runtime_state_v1"],
    });

    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    const [session] = JSON.parse(json.stdout).sessions;
    // The older binary refuses the flag it does not know, so the probe still
    // has to report the activity without it.
    expect(session.runtime.agentRuntimeState.activity).toBe("waiting");
    expect(session.runtime.semanticIdleMs).toBeNull();
    expect(session.idleSinceMs).toBeNull();
    expect(session.fieldSources.idleSinceMs).toBe("unavailable");

    const table = runSessionCli(root, hmux, ["ls"]);
    const [header, row] = table.stdout.trim().split("\n");
    expect(row.split("\t")[header.split("\t").indexOf("IDLE")]).toBe("-");
  });

  it("never reports an idle time for an agent that is working or needs attention", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [
      hmuxSession(1, {
        agentRuntimeState: { ...waitingState, activity: "working" },
        semanticIdleMs: "5000",
      }),
      hmuxSession(2, {
        agentRuntimeState: {
          ...waitingState,
          attention: "input_required",
          attention_id: "attention-2",
        },
        semanticIdleMs: "5000",
      }),
    ], { capabilities: IDLE_CAPABILITIES });

    const json = runSessionCli(root, hmux, ["ls", "--json"]);
    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    for (const session of JSON.parse(json.stdout).sessions) {
      expect(session.runtime.semanticIdleMs).toBeNull();
      expect(session.idleSinceMs).toBeNull();
    }
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

describe("dure ls --all-backends", () => {
  const DOWN_HOST = "down.example.test";

  function installBackends(root, sessions, { unreachableHosts = [], options = {} } = {}) {
    const remote = installRemoteBackendFixture(root, sessions, { unreachableHosts, ...options });
    const profiles = [
      sshBackendProfile({ id: "remote-build", defaultProfile: true }),
      sshBackendProfile({ id: "remote-down", host: DOWN_HOST }),
    ];
    writeFileSync(
      join(root, "backend-profiles.json"),
      JSON.stringify({ schemaVersion: 1, kind: "dure.backend_profiles", profiles }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "backend-ssh-references.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "dure.backend_ssh_references",
        references: profiles.map(({ id }) => ({
          reference: `known-hosts-profile:${id}`,
          kind: "known_hosts_file",
          path: remote.knownHostsFile,
        })),
      }),
      { mode: 0o600 },
    );
    return { PATH: `${remote.bin}:${process.env.PATH}` };
  }

  function unusedHmux(root) {
    return installHmuxStub(root, { error: "must not execute" }, { status: 77 });
  }

  it("prints one table with a backend column and reports an unreachable backend beside it", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()], { unreachableHosts: [DOWN_HOST] });

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const [header, row, ...notices] = result.stdout.trim().split("\n");
    expect(header.split("\t").slice(0, 2)).toEqual(["BACKEND", "SESSION"]);
    expect(row.split("\t").slice(0, 2)).toEqual(["remote-build", "session-1"]);
    expect(notices).toEqual([
      expect.stringMatching(/^Backend remote-down unavailable: backend_transport_ssh_failed/),
    ]);
  });

  it("carries the backend on each JSON row and the failure on the backend entry", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()], { unreachableHosts: [DOWN_HOST] });

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends", "--json"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      kind: "dure.sessions.list",
      complete: false,
      partial: true,
      inventoryComplete: false,
      source: { kind: "all_backends", appDaemonRequired: false },
      sessions: [{ backendProfileId: "remote-build", sessionId: "session-1" }],
    });
    expect(report.backends).toEqual([
      expect.objectContaining({ backendProfileId: "remote-build", status: "ok" }),
      expect.objectContaining({
        backendProfileId: "remote-down",
        status: "error",
        error: expect.objectContaining({ code: "backend_transport_ssh_failed" }),
      }),
    ]);
  });

  it("keeps identical Session IDs from different backends as separate rows", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()]);

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends", "--json"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ complete: true, partial: false, inventoryComplete: true });
    expect(report.sessions.map((session) => [session.backendProfileId, session.sessionId])).toEqual([
      ["remote-build", "session-1"],
      ["remote-down", "session-1"],
    ]);
  });

  it("fails without claiming there are no sessions when every backend is unreachable", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()], {
      unreachableHosts: ["remote.example.test", DOWN_HOST],
    });

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends"], environment);

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("No Dure sessions.");
    expect(result.stdout).toContain("Backend remote-build unavailable:");
    expect(result.stdout).toContain("Backend remote-down unavailable:");
  });

  it("does not report no sessions while a backend is unreachable", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [], { unreachableHosts: [DOWN_HOST] });

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("No Dure sessions.");
    expect(result.stdout).toContain("Backend remote-down unavailable:");
  });

  it("says no sessions when every backend answered with none", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, []);

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("No Dure sessions.");
  });

  it("names the backend whose inventory was truncated", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()], {
      unreachableHosts: [DOWN_HOST],
      options: {
        results: {
          "sessions.list": {
            schemaVersion: 1,
            complete: true,
            sessions: [hmuxSession()],
            truncation: { items: true, omittedCount: 1 },
          },
        },
      },
    });

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "remote-build: Inventory truncated. Use dure ls --cursor start --backend remote-build to enumerate all pages.",
    );
    const json = JSON.parse(
      runSessionCli(root, unusedHmux(root), ["ls", "--all-backends", "--json"], environment).stdout,
    );
    expect(json.truncation).toEqual({ items: true, omittedCount: 1 });
    expect(json.backends[0]).toMatchObject({
      backendProfileId: "remote-build",
      truncation: { items: true, omittedCount: 1 },
    });
  });

  it("applies --alive and --hide-provider to every backend's rows", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [
      hmuxSession(1, { provider_id: "codex" }),
      hmuxSession(2, { provider_id: "local-shell" }),
      hmuxSession(3, { lifecycle: "exited", health: "exited", provider_id: "codex", exit: { kind: "normal", exit_code: 0 } }),
    ]);

    const result = runSessionCli(
      root,
      unusedHmux(root),
      ["ls", "--all-backends", "--alive", "--hide-provider", "local-shell", "--json"],
      environment,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).sessions.map((session) => [session.backendProfileId, session.sessionId])).toEqual([
      ["remote-build", "session-1"],
      ["remote-down", "session-1"],
    ]);
  });

  it("lists this machine under local without creating a catalog when none is configured", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession()]);

    const result = runSessionCli(root, hmux, ["ls", "--all-backends", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: true,
      backends: [{ backendProfileId: "local", status: "ok", source: { kind: "local_hmux" } }],
      sessions: [{ backendProfileId: "local", sessionId: "session-1" }],
    });
  });

  it("reports a broken catalog instead of pretending only this machine exists", () => {
    const root = temporaryRoot();
    const hmux = unusedHmux(root);
    writeFileSync(join(root, "backend-profiles.json"), "{ not json", { mode: 0o600 });

    const result = runSessionCli(root, hmux, ["ls", "--all-backends", "--json"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.error",
      error: { code: "backend_profiles_json_invalid" },
    });
  });

  it("wins over DURE_BACKEND_PROFILE", () => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()]);

    const result = runSessionCli(root, unusedHmux(root), ["ls", "--all-backends", "--json"], {
      ...environment,
      DURE_BACKEND_PROFILE: "remote-down",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).backends).toHaveLength(2);
  });

  it.each([
    [["ls", "--all-backends", "--backend", "remote-build"]],
    [["ls", "--all-backends", "--cursor", "start"]],
    [["sessions", "list", "--all-backends"]],
    [["inspect", "session-1", "--all-backends"]],
  ])("refuses %j before contacting a backend", (args) => {
    const root = temporaryRoot();
    const environment = installBackends(root, [hmuxSession()]);

    const result = runSessionCli(root, unusedHmux(root), args, {
      ...environment,
      DURE_SESSION_REQUEST_LOG: join(root, "requests.jsonl"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--all-backends");
    expect(existsSync(join(root, "requests.jsonl"))).toBe(false);
  });

  it("keeps remote backends when the local backend service cannot start", async () => {
    const report = await collectAllBackendsSessionQuery({
      query: {
        action: "list",
        requestBackend: async () => ({
          backend: { id: "remote-backend" },
          result: { schemaVersion: 1, complete: true, sessions: [hmuxSession()] },
        }),
      },
      collect: collectSessionQuery,
      loadCatalog: () => ({ profiles: [{ id: "local" }, { id: "remote-build" }] }),
      resolveBackend: async (id) =>
        id === "local"
          ? { error: new LocalBackendError("local_backend_unavailable") }
          : { profile: sshBackendProfile({ id }), transportOptions: {} },
    });

    expect(report.backends[0]).toMatchObject({
      backendProfileId: "local",
      status: "error",
      error: { code: "local_backend_unavailable" },
    });
    expect(report.sessions.map((session) => session.backendProfileId)).toEqual(["remote-build"]);
    expect(sessionQueryExitCode(report)).toBe(0);
  });

  it("keeps the other backends when one backend's response cannot be processed", async () => {
    const requestBackend = async () => ({
      backend: { id: "remote-backend" },
      result: { schemaVersion: 1, complete: true, sessions: [hmuxSession()] },
    });

    const report = await collectAllBackendsSessionQuery({
      query: { action: "list", requestBackend },
      collect: async (query) => {
        if (query.backend.profile?.id === "remote-bad") throw new TypeError("unexpected shape");
        return collectSessionQuery(query);
      },
      loadCatalog: () => ({ profiles: [{ id: "remote-bad" }, { id: "remote-build" }] }),
      resolveBackend: async (id) => ({ profile: sshBackendProfile({ id }), transportOptions: {} }),
    });

    expect(report.backends[0]).toMatchObject({
      backendProfileId: "remote-bad",
      status: "error",
      error: { code: "backend_transport_unavailable" },
    });
    expect(report.sessions.map((session) => session.backendProfileId)).toEqual(["remote-build"]);
  });

  it("leaves plain dure ls without backend fields or a backend column", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession()]);

    const table = runSessionCli(root, hmux, ["ls"]);
    const report = JSON.parse(runSessionCli(root, hmux, ["ls", "--json"]).stdout);

    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    expect(table.stdout.split("\t")[0]).toBe("SESSION");
    expect(report.source.kind).toBe("local_hmux");
    expect(report.backends).toBeUndefined();
    expect(report.sessions[0].backendProfileId).toBeUndefined();
  });
});

describe("dure ls recovery waits", () => {
  const SESSION_CAPABILITIES = [
    "sessions.list",
    "sessions.list.bounded_catalog_v1",
    "sessions.read",
    "sessions.show",
  ];
  // 2h 10m and a margin for the listing itself, so the column is exact.
  const inTwoHoursTenMinutes = () => Date.now() + (2 * 60 + 10) * 60_000 + 30_000;

  function remoteAgent(id, sessionIndex) {
    return {
      id, name: id, displayName: id, sessionId: `session-${sessionIndex}`,
      provider: "codex", worktree: "/repo",
      runtimeBinding: {
        runtime: "hmux_managed_v1", source: "ssh", hostId: "remote-build",
        ...hostGeneration({ sessionId: `session-${sessionIndex}`, workspaceId: `workspace-${sessionIndex}` }),
      },
    };
  }

  function remoteEnvironment(root, remote) {
    return {
      PATH: `${remote.bin}:${process.env.PATH}`,
      DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
      DURE_SESSION_REQUEST_LOG: remote.requestLog,
    };
  }

  function requestedOperations(remote) {
    return readFileSync(remote.requestLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line).operation).sort();
  }

  function rowOf(stdout, sessionId) {
    return stdout.trim().split("\n").find((line) => line.startsWith(`${sessionId}\t`)).split("\t");
  }

  it("shows when each waiting Agent continues, from the backend that lists it", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const resumeAtMs = inTwoHoursTenMinutes();
    const remote = installRemoteBackendFixture(root, [hmuxSession(1), hmuxSession(2)], {
      capabilities: [...SESSION_CAPABILITIES, RECOVERY_WAITS_CAPABILITY],
      results: {
        "agent_recovery.waits": {
          schemaVersion: 1,
          waits: [
            { agentId: "remote-agent-1", attemptId: "attempt-1", resumeAtMs },
            // An Agent no listed row names stays off the rows.
            { agentId: "agent-elsewhere", attemptId: "attempt-2", resumeAtMs },
          ],
        },
      },
    });
    writeRegistry(root, [remoteAgent("remote-agent-1", 1), remoteAgent("remote-agent-2", 2)]);
    const environment = remoteEnvironment(root, remote);

    const json = runSessionCli(root, hmux, ["ls", "--backend", "remote-build", "--json"], environment);
    const table = runSessionCli(root, hmux, ["ls", "--backend", "remote-build"], environment);

    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    const sessions = JSON.parse(json.stdout).sessions;
    expect(sessions.map((session) => [session.sessionId, session.recoveryWaits])).toEqual([
      ["session-1", [{ agentId: "remote-agent-1", attemptId: "attempt-1", resumeAtMs }]],
      ["session-2", []],
    ]);
    expect(table.status, `${table.stdout}\n${table.stderr}`).toBe(0);
    expect(table.stdout.split("\n")[0].split("\t").at(-1)).toBe("CONTINUES");
    expect(rowOf(table.stdout, "session-1").at(-1)).toBe("in 2h 10m");
    expect(rowOf(table.stdout, "session-2").at(-1)).toBe("-");
    expect(requestedOperations(remote)).toEqual([
      "agent_recovery.waits", "agent_recovery.waits", "sessions.list", "sessions.list",
    ]);
  });

  it("says unknown, without asking, when the backend predates the list", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession(1), hmuxSession(2)]);
    writeRegistry(root, [remoteAgent("remote-agent-1", 1)]);
    const environment = remoteEnvironment(root, remote);

    const json = runSessionCli(root, hmux, ["ls", "--backend", "remote-build", "--json"], environment);
    const table = runSessionCli(root, hmux, ["ls", "--backend", "remote-build"], environment);

    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    expect(JSON.parse(json.stdout).sessions.map((session) => session.recoveryWaits)).toEqual([null, null]);
    // Only a row that names an Agent has a wait to be unknown.
    expect(rowOf(table.stdout, "session-1").at(-1)).toBe("unknown");
    expect(rowOf(table.stdout, "session-2").at(-1)).toBe("-");
    expect(requestedOperations(remote)).toEqual(["sessions.list", "sessions.list"]);
  });

  function managedLocalCatalog(root, capabilities) {
    const socketPath = join(root, "backend", "control-plane.sock");
    const profile = {
      id: "local",
      default: true,
      transport: { kind: "local", endpoint: { kind: "unix_socket", path: socketPath } },
      auth: { kind: "peer" },
      trust: { kind: "local_peer" },
      expected: {
        backendId: "dure-local",
        generation: `local-v1-${"1".repeat(32)}`,
        protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
        capabilities,
      },
      deadlineMs: FUNCTIONAL_DEADLINE_MS,
    };
    mkdirSync(join(root, "backend"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "backend-profiles.json"),
      JSON.stringify({ schemaVersion: 1, kind: "dure.backend_profiles", profiles: [profile] }),
      { mode: 0o600 },
    );
    return { profile, socketPath };
  }

  function localBackendServer(profile, waits) {
    const requests = [];
    const server = createServer((socket) => {
      let source = "";
      socket.on("data", (chunk) => {
        source += chunk.toString("utf8");
        if (!source.includes("\n")) return;
        const request = JSON.parse(source.trim());
        requests.push(request);
        socket.end(`${JSON.stringify({
          schemaVersion: 1,
          apiVersion: "dure.backend-transport/v1",
          kind: "dure.backend.response",
          requestId: request.requestId,
          backend: {
            id: profile.expected.backendId,
            generation: profile.expected.generation,
            protocol: { major: 1, minor: 0 },
            capabilities: profile.expected.capabilities,
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, waits },
        })}\n`);
      });
    });
    return { requests, server };
  }

  function listen(server, socketPath) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  // The listing must not block this process: the backend answers from here.
  function runSessionCliAsync(root, hmux, args) {
    const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [cliPath, ...args, "--deadline-ms", String(FUNCTIONAL_DEADLINE_MS)], {
          env: { PATH: process.env.PATH, DURE_APP_CHANNEL: "stable", DURE_HOME: root, DURE_HMUX_BIN: hmux },
        });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  function localAgent(id) {
    return {
      id, name: id, displayName: id, sessionId: "session-1", provider: "codex", worktree: "/repo",
      runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", ...hostGeneration() },
    };
  }

  it("asks this machine's running backend for plain dure ls", async () => {
    const root = mkdtempSync(join(tmpdir(), "dure-lsw-"));
    temporaryRoots.push(root);
    const hmux = installHmuxStub(root, [hmuxSession()]);
    writeRegistry(root, [localAgent("agent-local")]);
    const { profile, socketPath } = managedLocalCatalog(root, ["sessions.list", RECOVERY_WAITS_CAPABILITY]);
    const resumeAtMs = inTwoHoursTenMinutes();
    const backend = localBackendServer(profile, [
      { agentId: "agent-local", attemptId: "attempt-1", resumeAtMs },
    ]);
    await listen(backend.server, socketPath);

    try {
      const result = await runSessionCliAsync(root, hmux, ["ls", "--json"]);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.source.kind).toBe("local_hmux");
      expect(report.sessions[0].recoveryWaits).toEqual([
        { agentId: "agent-local", attemptId: "attempt-1", resumeAtMs },
      ]);
      expect(backend.requests.map((request) => request.operation)).toEqual(["agent_recovery.waits"]);
    } finally {
      await new Promise((resolve) => backend.server.close(resolve));
    }
  });

  it("starts no service for plain dure ls when this machine's backend is not running", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-lsw-"));
    temporaryRoots.push(root);
    const hmux = installHmuxStub(root, [hmuxSession()]);
    writeRegistry(root, [localAgent("agent-local")]);
    managedLocalCatalog(root, ["sessions.list", RECOVERY_WAITS_CAPABILITY]);

    const result = runSessionCli(root, hmux, ["ls", "--json"]);
    const table = runSessionCli(root, hmux, ["ls"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).sessions[0].recoveryWaits).toBeNull();
    expect(rowOf(table.stdout, "session-1").at(-1)).toBe("unknown");
    expect(existsSync(join(root, "backend", "control-plane.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
  });

  it("reads each listed backend's own waits and never another backend's for it", async () => {
    const seen = [];
    const local = { profile: { id: "local" } };
    const collect = withRecoveryWaits(async (query) => ({
      kind: "dure.sessions.list",
      sessions: [{ clientProjection: { agents: [{ id: "agent-1" }] } }],
      backendId: query.backend?.profile?.id ?? null,
    }), {
      localBackend: local,
      readWaits: async (backend) => {
        seen.push(backend?.profile?.id ?? (backend?.error ? "error" : null));
        return backend?.profile ? [{ agentId: "agent-1", attemptId: "a", resumeAtMs: 1 }] : null;
      },
    });

    const remote = await collect({ backend: { profile: { id: "remote-build" } } });
    const failed = await collect({ backend: { error: new Error("unreachable") } });
    const plain = await collect({ backend: null });

    expect(seen).toEqual(["remote-build", "error", "local"]);
    expect(remote.sessions[0].recoveryWaits).toHaveLength(1);
    // A backend that could not be resolved is unknown, not this machine's.
    expect(failed.sessions[0].recoveryWaits).toBeNull();
    expect(plain.sessions[0].recoveryWaits).toHaveLength(1);
  });
});

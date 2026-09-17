import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  backendHealthExitCode,
  formatBackendStatus,
} from "../cli/lib/backend-status.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const backendModulePath = fileURLToPath(
  new URL("../cli/lib/backend-status.mjs", import.meta.url),
);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function typedError() {
  return {
    code: "hmux_session_transport_stale",
    message: "session Host did not complete a bounded observer handshake",
    source: "host_probe",
    futureSecret: "must-not-pass-through",
  };
}

function runtimePayload() {
  return {
    schemaVersion: 1,
    kind: "hmux.runtime_status",
    status: "degraded",
    reasonCodes: ["hmux_session_transport_stale"],
    observedAtMs: 1_000,
    hmuxCli: {
      state: "ready",
      packageVersion: "0.1.4",
      buildId: "0.1.4+fixture",
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 },
        capabilities: ["runtime_status_v1"],
        requiredHostCapabilities: ["screen_snapshot_profile_v1"],
        futureToken: "must-not-pass-through",
      },
      host: {
        id: "local",
        name: "fixture-host",
        os: "fixture-os",
        architecture: "fixture-arch",
        rawAddress: "private-host-address",
      },
      observedAtMs: 1_000,
      sourceAgeMs: 0,
      authToken: "must-not-pass-through",
    },
    sessionHosts: {
      state: "stale",
      complete: true,
      snapshotId: "c_fixture-generation",
      probeBudgetMs: 50,
      total: 2,
      active: 2,
      exited: 0,
      probed: 2,
      unprobed: 0,
      probeCoverageBasisPoints: 10_000,
      healthy: 1,
      degraded: 0,
      outdated: 0,
      stale: 1,
      providerCounts: { codex: 2 },
      buildCounts: { "0.1.4+fixture": 2 },
      buildCountBasis: "active_ready",
      reasonCounts: { hmux_session_transport_stale: 1 },
      buildSkew: false,
      observedAtMs: 1_000,
      manifestMaxLifecycleAgeMs: 500,
      fullCatalog: ["must-not-pass-through"],
    },
    sessionHostSample: [
      {
        sessionId: "session-stale",
        workspaceId: "workspace-1",
        sessionClass: "managed",
        lifecycle: "ready",
        health: "stale",
        providerId: "codex",
        host: {
          runtimeHost: "localhost",
          runnerPrincipal: "local-user",
          runnerInstance: "runner-1",
          channelEpoch: "1",
          hostInstanceId: "host-1",
          terminalEpoch: "terminal-1",
          privateKey: "must-not-pass-through",
        },
        process: {
          host: { processId: 41, startMarker: "host-generation-1" },
          provider: { processId: 42, startMarker: "provider-generation-1" },
          commandLine: "must-not-pass-through",
        },
        endpoint: {
          kind: "unix_socket",
          id: "endpoint-redacted-1",
          rawAddress: "/private/runtime.sock",
          socket: "/private/runtime.sock",
        },
        protocol: {
          minimum: { major: 1, minor: 0 },
          maximum: { major: 1, minor: 0 },
          capabilities: ["screen_snapshot_profile_v1"],
          negotiation: "unavailable",
          missingCapabilities: [],
        },
        probe: { state: "stale", observedAtMs: null, ageMs: null },
        manifestLifecycleAgeMs: 500,
        observationError: typedError(),
        rawAddress: "must-not-pass-through",
      },
    ],
    sessionHostSampleLimit: 16,
    sessionHostSampleHasMore: true,
    sessionHostSampleOmittedCount: 1,
    representativeError: typedError(),
    resourcePressure: {
      state: "available",
      level: "normal",
      basis: "load_average_per_logical_core",
      oneMinuteLoad: 1,
      loadPerLogicalCore: 0.25,
      logicalCores: 4,
      physicalMemoryBytes: 16_000,
      producerPeakResidentBytes: 1_000,
      observedAtMs: 1_000,
      sourceAgeMs: 0,
      processEnvironment: "must-not-pass-through",
    },
    sources: [{ name: "future-source", authToken: "must-not-pass-through" }],
    rawAddress: "must-not-pass-through",
  };
}

function payloadForHostState(kind) {
  const payload = structuredClone(runtimePayload());
  const host = payload.sessionHostSample[0];
  payload.sessionHosts.total = 1;
  payload.sessionHosts.providerCounts = { codex: 1 };
  payload.sessionHostSampleHasMore = false;
  payload.sessionHostSampleOmittedCount = 0;

  if (kind === "healthy") {
    payload.status = "ready";
    payload.reasonCodes = [];
    payload.representativeError = null;
    Object.assign(payload.sessionHosts, {
      state: "ready",
      active: 1,
      exited: 0,
      probed: 1,
      unprobed: 0,
      healthy: 1,
      degraded: 0,
      outdated: 0,
      stale: 0,
      reasonCounts: {},
      buildCounts: { "0.1.4+fixture": 1 },
    });
    host.health = "healthy";
    host.protocol.negotiation = "accepted";
    host.probe = { state: "fresh", observedAtMs: 1_000, ageMs: 0 };
    host.observationError = null;
  } else if (kind === "exited") {
    payload.status = "ready";
    payload.reasonCodes = [];
    payload.representativeError = null;
    Object.assign(payload.sessionHosts, {
      state: "ready",
      active: 0,
      exited: 1,
      probed: 0,
      unprobed: 0,
      healthy: 0,
      degraded: 0,
      outdated: 0,
      stale: 0,
      reasonCounts: {},
      buildCounts: {},
    });
    host.lifecycle = "exited";
    host.health = "exited";
    host.protocol.negotiation = "not_applicable";
    host.probe = { state: "stopped", observedAtMs: null, ageMs: null };
    host.observationError = null;
  } else if (kind === "generation_changed") {
    const error = {
      code: "hmux_process_generation_changed",
      message: "session endpoint answered with a different generation",
      source: "host_probe",
    };
    payload.reasonCodes = [error.code];
    payload.representativeError = error;
    Object.assign(payload.sessionHosts, {
      state: "stale",
      active: 1,
      exited: 0,
      probed: 1,
      unprobed: 0,
      healthy: 0,
      degraded: 0,
      outdated: 0,
      stale: 1,
      reasonCounts: { [error.code]: 1 },
      buildCounts: { "0.1.4+fixture": 1 },
    });
    host.protocol.negotiation = "generation_changed";
    host.probe = { state: "stale", observedAtMs: null, ageMs: null };
    host.observationError = error;
  }
  return payload;
}

function payloadForResource(level) {
  const payload = structuredClone(runtimePayload());
  const unavailable = level === "unavailable";
  const reasonCode = unavailable
    ? "hmux_resource_pressure_unavailable"
    : "hmux_resource_pressure_critical";
  payload.reasonCodes.push(reasonCode);
  Object.assign(payload.resourcePressure, {
    state: unavailable ? "unavailable" : "available",
    level: unavailable ? "unknown" : "critical",
    oneMinuteLoad: unavailable ? null : 12,
    loadPerLogicalCore: unavailable ? null : 3,
    logicalCores: unavailable ? null : 4,
  });
  return payload;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-backend-status-"));
  roots.push(root);
  const appHome = path.join(root, "app-home");
  const invocationLog = path.join(root, "hmux-invocations.jsonl");
  const executable = path.join(root, "fake-hmux.mjs");
  fs.mkdirSync(appHome);
  fs.writeFileSync(path.join(appHome, "agents.json"), "not valid json");
  fs.mkdirSync(path.join(appHome, "server.json"));
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_HMUX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const runtime = process.argv.includes("runtime");
const mode = process.env.FAKE_HMUX_MODE || "valid";
if (!runtime) {
  process.stdout.write(JSON.stringify({schemaVersion: 1, capabilities: ["managed_screen_read_v1"]}) + "\\n");
  process.exit(0);
}
if (mode === "timeout") {
  setTimeout(() => process.exit(0), 5_000);
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(300 * 1024));
} else if (mode === "outdated") {
  process.exit(64);
} else if (mode === "invalid-json") {
  process.stdout.write("not-json\\n");
} else {
  const payload = JSON.parse(process.env.FAKE_HMUX_PAYLOAD);
  if (mode === "wrong-schema") payload.schemaVersion = 2;
  if (mode === "wrong-kind") payload.kind = "hmux.future_status";
  if (mode === "missing-capability") payload.hmuxCli.protocol.capabilities = [];
  if (mode === "bad-session-state") payload.sessionHosts.state = "healthy";
  if (mode === "bad-error") payload.representativeError = {message: "untyped"};
  if (mode === "bad-resource") payload.resourcePressure.basis = "raw_process_dump";
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
`,
    { mode: 0o755 },
  );
  return { appHome, executable, invocationLog, root };
}

function run(
  fx,
  subcommand,
  {
    hmuxBin = fx.executable,
    mode = "valid",
    payload = runtimePayload(),
    timeoutMs = 3_000,
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      cliPath,
      "backend",
      subcommand,
      "--json",
      "--timeout-ms",
      String(timeoutMs),
      "--probe-budget-ms",
      "50",
    ],
    {
      cwd: fx.root,
      encoding: "utf8",
      timeout: Math.max(2_000, timeoutMs + 1_000),
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: fx.appHome,
        DURE_HMUX_BIN: hmuxBin,
        FAKE_HMUX_LOG: fx.invocationLog,
        FAKE_HMUX_MODE: mode,
        FAKE_HMUX_PAYLOAD: JSON.stringify(payload),
      },
    },
  );
}

function runAsync(fx, subcommand, options = {}) {
  const hmuxBin = options.hmuxBin ?? fx.executable;
  const mode = options.mode ?? "valid";
  const payload = options.payload ?? runtimePayload();
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "backend",
        subcommand,
        "--json",
        "--timeout-ms",
        String(timeoutMs),
        "--probe-budget-ms",
        "50",
      ],
      {
        cwd: fx.root,
        env: {
          ...process.env,
          DURE_APP_CHANNEL: "stable",
          DURE_HOME: fx.appHome,
          DURE_HMUX_BIN: hmuxBin,
          FAKE_HMUX_LOG: fx.invocationLog,
          FAKE_HMUX_MODE: mode,
          FAKE_HMUX_PAYLOAD: JSON.stringify(payload),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function installControlPlaneProfile(fx, socketPath) {
  fs.writeFileSync(
    path.join(fx.appHome, "backend-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [
        {
          id: "local",
          default: true,
          transport: {
            kind: "local",
            endpoint: { kind: "unix_socket", path: socketPath },
          },
          auth: { kind: "peer" },
          trust: { kind: "local_peer" },
          expected: {
            backendId: "dure-local",
            generation: "local-v1-status-fixture",
            protocol: {
              minimum: { major: 1, minor: 0 },
              maximum: { major: 1, minor: 0 },
            },
            capabilities: ["orchestration.invoke"],
          },
          deadlineMs: 500,
        },
      ],
    }),
    { mode: 0o600 },
  );
}

function backendPingServer({ generation = "local-v1-status-fixture" } = {}) {
  let observedRequest;
  const server = createServer((socket) => {
    let source = "";
    socket.on("data", (chunk) => {
      source += chunk.toString("utf8");
      if (!source.includes("\n")) return;
      observedRequest = JSON.parse(source.trim());
      socket.end(
        `${JSON.stringify({
          schemaVersion: 1,
          apiVersion: "dure.backend-transport/v1",
          kind: "dure.backend.response",
          requestId: observedRequest.requestId,
          backend: {
            id: "dure-local",
            generation,
            protocol: { major: 1, minor: 0 },
            capabilities: ["orchestration.invoke"],
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, status: "ready" },
        })}\n`,
      );
    });
  });
  return { observedRequest: () => observedRequest, server };
}

function invocations(fx) {
  return fs
    .readFileSync(fx.invocationLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Dure backend status CLI", () => {
  test("reports the reachable selected control plane instead of permanent absence", async () => {
    const fx = fixture();
    const socketPath = path.join(fx.root, "control-plane.sock");
    installControlPlaneProfile(fx, socketPath);
    const backend = backendPingServer();
    const { server } = backend;
    await listen(server, socketPath);
    const filesBefore = fs.readdirSync(fx.appHome).sort();

    try {
      const result = await runAsync(fx, "health", {
        payload: payloadForHostState("healthy"),
      });

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        status: "ready",
        reasonCodes: [],
        partial: false,
        controlPlane: {
          state: "ready",
          reasonCode: null,
          identity: {
            backendId: "dure-local",
            generation: "local-v1-status-fixture",
          },
          protocol: {
            negotiation: "accepted",
            version: { major: 1, minor: 0 },
            capabilities: ["orchestration.invoke"],
          },
          endpoint: {
            transport: "local",
            kind: "unix_socket",
          },
          heartbeat: { state: "fresh" },
        },
      });
      expect(backend.observedRequest()).toMatchObject({
        operation: "backend.ping",
        body: { schemaVersion: 1 },
      });
      expect(report.sources).toContainEqual(
        expect.objectContaining({
          name: "control_plane",
          state: "ready",
          reasonCode: null,
        }),
      );
      expect(JSON.stringify(report.controlPlane)).not.toContain(socketPath);
      expect(JSON.stringify(report.controlPlane)).not.toMatch(
        /credential|privateKey|processId|socketPath/,
      );
      expect(fs.readdirSync(fx.appHome).sort()).toEqual(filesBefore);
    } finally {
      await closeServer(server);
    }
  });

  test("distinguishes a configured unreachable control plane from an absent deployment", async () => {
    const fx = fixture();
    const socketPath = path.join(fx.root, "unreachable-control-plane.sock");
    installControlPlaneProfile(fx, socketPath);
    const filesBefore = fs.readdirSync(fx.appHome).sort();

    const result = await runAsync(fx, "health", {
      payload: payloadForHostState("healthy"),
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: "unreachable",
      reasonCodes: ["backend_transport_unavailable"],
      controlPlane: {
        state: "unreachable",
        reasonCode: "backend_transport_unavailable",
        lastTypedError: {
          code: "backend_transport_unavailable",
          source: "control_plane_transport",
        },
      },
    });
    expect(JSON.stringify(report.controlPlane)).not.toContain(socketPath);
    expect(fs.readdirSync(fx.appHome).sort()).toEqual(filesBefore);
  });

  test("reports a reachable stale generation as outdated", async () => {
    const fx = fixture();
    const socketPath = path.join(fx.root, "stale-control-plane.sock");
    installControlPlaneProfile(fx, socketPath);
    const { server } = backendPingServer({
      generation: "local-v1-stale-generation",
    });
    await listen(server, socketPath);

    try {
      const result = await runAsync(fx, "health", {
        payload: payloadForHostState("healthy"),
      });

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "outdated",
        reasonCodes: ["backend_transport_generation_mismatch"],
        representativeError: {
          code: "backend_transport_generation_mismatch",
          source: "control_plane_transport",
        },
        controlPlane: {
          state: "outdated",
          reasonCode: "backend_transport_generation_mismatch",
          protocol: { negotiation: "incompatible" },
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  test("dispatches before the app registry and emits an allowlisted aggregate", () => {
    const fx = fixture();
    const payload = runtimePayload();
    payload.reasonCodes = [
      "hmux_probe_deadline_exhausted",
      "hmux_session_transport_stale",
    ];
    Object.assign(payload.sessionHosts, {
      complete: false,
      total: 3,
      active: 3,
      probed: 2,
      unprobed: 1,
      probeCoverageBasisPoints: 6_666,
      healthy: 1,
      degraded: 1,
      stale: 1,
      providerCounts: { "에이전트": 2, Zed: 1 },
      buildCounts: { "0.1.4+fixture": 3 },
      reasonCounts: {
        hmux_probe_deadline_exhausted: 1,
        hmux_session_transport_stale: 1,
      },
    });
    payload.sessionHostSampleOmittedCount = 2;
    const result = run(fx, "status", { payload });

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.backend/v1",
      kind: "dure.backend.status",
      view: "status",
      status: "degraded",
      reasonCodes: [
        "control_plane_not_deployed",
        "hmux_probe_deadline_exhausted",
        "hmux_session_transport_stale",
      ],
      partial: true,
      terminalRuntime: {
        state: "degraded",
        source: "hmux_cli",
        producer: {
          packageVersion: "0.1.4",
          buildId: "0.1.4+fixture",
        },
      },
      sessionHosts: {
        state: "stale",
        complete: false,
        snapshotId: "c_fixture-generation",
        probeBudgetMs: 50,
        probeCoverageBasisPoints: 6666,
        total: 3,
        probed: 2,
        unprobed: 1,
        providerCounts: { Zed: 1, "에이전트": 2 },
      },
      controlPlane: {
        state: "absent",
        reasonCode: "control_plane_not_deployed",
      },
      sources: [
        { name: "hmux_cli", state: "ready", reasonCode: null },
        {
          name: "session_hosts",
          state: "stale",
          reasonCode: "hmux_session_transport_stale",
        },
        { name: "resource_pressure", state: "ready", reasonCode: null },
        {
          name: "control_plane",
          state: "absent",
          reasonCode: "control_plane_not_deployed",
        },
      ],
    });
    expect(report.sessionHostSample).toHaveLength(1);
    expect(Object.keys(report.sessionHosts.providerCounts)).toEqual([
      "Zed",
      "에이전트",
    ]);
    expect(report.sessionHostSampleHasMore).toBe(true);
    expect(report.sessionHostSampleOmittedCount).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(
      /rawAddress|private-host-address|private\/runtime|authToken|futureSecret|fullCatalog|processEnvironment|commandLine|privateKey|future-source/,
    );
    expect(invocations(fx)).toEqual([
      ["--json", "runtime", "status", "--probe-budget-ms", "50"],
    ]);
  });

  test("supports server as a registry-free alias", () => {
    const fx = fixture();
    const result = spawnSync(
      process.execPath,
      [cliPath, "server", "status", "--json"],
      {
        cwd: fx.root,
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_HOME: fx.appHome,
          DURE_HMUX_BIN: fx.executable,
          FAKE_HMUX_LOG: fx.invocationLog,
          FAKE_HMUX_PAYLOAD: JSON.stringify(runtimePayload()),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).kind).toBe("dure.backend.status");
    expect(invocations(fx)).toEqual([["--json", "runtime", "status"]]);
  });

  test("treats an older Hmux census without completeness fields as partial", () => {
    const payload = runtimePayload();
    for (const field of [
      "complete",
      "snapshotId",
      "probeBudgetMs",
      "probed",
      "unprobed",
      "probeCoverageBasisPoints",
    ]) {
      delete payload.sessionHosts[field];
    }

    const result = run(fixture(), "status", { payload });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).sessionHosts).toMatchObject({
      complete: false,
      snapshotId: null,
      probeBudgetMs: null,
      probed: null,
      unprobed: null,
      probeCoverageBasisPoints: null,
    });
  });

  test("rejects inconsistent completeness counts", () => {
    const payload = runtimePayload();
    payload.sessionHosts.unprobed = 1;

    const result = run(fixture(), "health", { payload });

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: { code: "hmux_runtime_contract_invalid" },
    });
  });

  test("rejects a probe coverage claim that disagrees with bounded counts", () => {
    const payload = runtimePayload();
    payload.sessionHosts.probeCoverageBasisPoints = 9_999;

    const result = run(fixture(), "health", { payload });

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: { code: "hmux_runtime_contract_invalid" },
    });
  });

  test("uses 0/1/2 health semantics", () => {
    expect(backendHealthExitCode({ status: "ready" })).toBe(0);
    expect(backendHealthExitCode({ status: "degraded" })).toBe(1);
    expect(backendHealthExitCode({ status: "outdated" })).toBe(1);
    expect(backendHealthExitCode({ status: "unreachable" })).toBe(2);

    const degraded = run(fixture(), "health");
    expect(degraded.status, degraded.stderr).toBe(1);
    expect(JSON.parse(degraded.stdout).view).toBe("health");
  });

  test("renders bounded partial census counts instead of unavailable", () => {
    expect(
      formatBackendStatus({
        status: "degraded",
        terminalRuntime: { state: "degraded" },
        controlPlane: { state: "absent" },
        sessionHosts: {
          complete: false,
          active: 98,
          total: 108,
          probed: 63,
          unprobed: 35,
        },
        durationMs: 182,
        reasonCodes: ["hmux_probe_deadline_exhausted"],
      }),
    ).toContain("sessions: 63/98 probed (35 unprobed)");
  });

  test.each([
    ["healthy", "healthy", "accepted", "fresh"],
    ["exited", "exited", "not_applicable", "stopped"],
    ["generation_changed", "stale", "generation_changed", "stale"],
  ])(
    "accepts the real Hmux %s host projection",
    (fixtureKind, health, negotiation, probeState) => {
      const result = run(fixture(), "status", {
        payload: payloadForHostState(fixtureKind),
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.representativeError?.code).not.toBe(
        "hmux_runtime_contract_invalid",
      );
      expect(report.sessionHostSample[0]).toMatchObject({
        health,
        protocol: { negotiation },
        probe: { state: probeState },
      });
    },
  );

  test.each([
    [
      "critical",
      "degraded",
      "hmux_resource_pressure_critical",
    ],
    [
      "unavailable",
      "unavailable",
      "hmux_resource_pressure_unavailable",
    ],
  ])(
    "keeps %s resource pressure as an independent source",
    (level, sourceState, reasonCode) => {
      const result = run(fixture(), "status", {
        payload: payloadForResource(level),
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.sources).toContainEqual(
        expect.objectContaining({
          name: "hmux_cli",
          state: "ready",
          reasonCode: null,
        }),
      );
      expect(report.sources).toContainEqual(
        expect.objectContaining({
          name: "resource_pressure",
          state: sourceState,
          reasonCode,
        }),
      );
    },
  );

  test.each([
    "wrong-schema",
    "wrong-kind",
    "missing-capability",
    "bad-session-state",
    "bad-error",
    "bad-resource",
  ])("rejects invalid Hmux contract: %s", (mode) => {
    const result = run(fixture(), "health", { mode });

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: { code: "hmux_runtime_contract_invalid" },
    });
  });

  test("classifies an old Hmux capability as outdated without mutation", () => {
    const fx = fixture();
    const result = run(fx, "health", { mode: "outdated" });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "outdated",
      representativeError: {
        code: "hmux_runtime_status_capability_outdated",
      },
    });
    expect(invocations(fx)).toEqual([
      ["--json", "runtime", "status", "--probe-budget-ms", "50"],
      ["capabilities", "--json"],
    ]);
  });

  test("returns exit 2 when the configured Hmux executable is absent", () => {
    const fx = fixture();
    const result = run(fx, "health", {
      hmuxBin: path.join(fx.root, "does-not-exist-hmux"),
    });

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: { code: "hmux_cli_unavailable" },
    });
  });

  test("returns exit 2 for invalid Hmux JSON", () => {
    const result = run(fixture(), "health", { mode: "invalid-json" });

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: { code: "hmux_runtime_contract_invalid" },
    });
  });

  test("returns a typed partial result under the whole-child deadline", () => {
    const fx = fixture();
    const started = Date.now();
    const result = run(fx, "health", { mode: "timeout", timeoutMs: 80 });
    const elapsed = Date.now() - started;

    expect(result.status, result.stderr).toBe(2);
    expect(elapsed).toBeLessThan(1_000);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: "unreachable",
      partial: true,
      deadlineMs: 80,
      representativeError: { code: "hmux_runtime_timeout" },
    });
    expect(report.sources).toContainEqual(
      expect.objectContaining({ name: "hmux_cli", state: "unreachable" }),
    );
  });

  test("turns oversized child output into a bounded typed failure", () => {
    const result = run(fixture(), "health", { mode: "oversize" });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout.length).toBeLessThan(10_000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "unreachable",
      representativeError: {
        code: "hmux_runtime_output_limit_exceeded",
      },
    });
  });

  test("keeps backend dispatch textually before loadRegistry", () => {
    const cliSource = fs.readFileSync(cliPath, "utf8");
    const mainStart = cliSource.indexOf("async function main()");
    const dispatch = cliSource.indexOf(
      'if (cmd === "backend" || cmd === "server")',
      mainStart,
    );
    const registryRead = cliSource.indexOf("const reg = loadRegistry();", mainStart);
    const backendSource = fs.readFileSync(backendModulePath, "utf8");

    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(mainStart);
    expect(registryRead).toBeGreaterThan(dispatch);
    expect(backendSource).not.toMatch(/server\.json|agents\.json|loadRegistry/);
  });
});

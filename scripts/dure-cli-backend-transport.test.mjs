import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBackendSshReferencesFromEnvironment } from "../cli/lib/backend-ssh-references.mjs";
import { parseBackendProfiles } from "../cli/lib/backend-profiles.mjs";
import { CONTROL_PLANE_CAPABILITIES } from "../cli/lib/control-plane-contract.mjs";
import {
  BACKEND_TRANSPORT_API_VERSION,
  MAX_BACKEND_TRANSPORT_REQUEST_BYTES,
  MAX_BACKEND_TRANSPORT_RESPONSE_BYTES,
  BackendTransportError,
  backendTransportErrorReport,
  buildBackendSshArgv,
  createBackendTransportRequest,
  exchangeLocalBackendRequest,
  exchangeSshBackendRequest,
  parseBackendTransportResponse,
  performBackendProfileRequest,
} from "../cli/lib/backend-transport.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

const modulePath = fileURLToPath(
  new URL("../cli/lib/backend-transport.mjs", import.meta.url),
);
const temporaryRoots = [];

describe("backend capability contract", () => {
  const maximum = Array.from({ length: 128 }, (_, index) => `capability.${index}`);

  it.each([
    ["current backend", CONTROL_PLANE_CAPABILITIES],
    ["protocol maximum", maximum],
  ])("accepts the %s in profiles, requests and handshakes", (_name, capabilities) => {
    const profile = localProfile();
    profile.expected.capabilities = [...capabilities];
    const source = JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [profile],
    });
    const selected = parseBackendProfiles(source).profiles[0];
    const request = createBackendTransportRequest(selected, {
      body: { schemaVersion: 1 },
      operation: "backend.ping",
      requiredCapabilities: capabilities,
    });
    const response = parseBackendTransportResponse(
      responseBytes(selected, request.request.requestId),
      {
        profile: selected,
        requestId: request.request.requestId,
        requiredCapabilities: request.requiredCapabilities,
        nowMs: 1_000,
      },
    );
    expect(response.backend.capabilities).toEqual([...capabilities].sort());
  });

  it.each([
    ["over maximum", [...maximum, "capability.extra"]],
    ["duplicate", [...maximum.slice(1), maximum[1]]],
    ["invalid token", [...maximum.slice(1), "invalid capability"]],
  ])("rejects %s in profiles and handshakes", (_name, capabilities) => {
    const profile = localProfile();
    const invalid = structuredClone(profile);
    invalid.expected.capabilities = capabilities;
    expect(() => parseBackendProfiles(JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [invalid],
    }))).toThrow();
    expect(() => parseBackendTransportResponse(
      responseBytes(profile, "capability-bound", { backend: { capabilities } }),
      { profile, requestId: "capability-bound", nowMs: 1_000 },
    )).toThrow("the backend response is malformed");
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-backend-transport-"));
  temporaryRoots.push(root);
  return root;
}

function sshReferences(profile) {
  const root = temporaryRoot();
  const identity = join(root, "identity");
  const knownHosts = join(root, "known-hosts");
  writeFileSync(identity, "fixture-only-identity", { mode: 0o600 });
  writeFileSync(knownHosts, "fixture-only-known-hosts", { mode: 0o600 });
  return resolveBackendSshReferencesFromEnvironment({
    auth: profile.auth, trust: profile.trust, profileId: profile.id,
  }, {
    DURE_HOME: root,
    DURE_BACKEND_SSH_REFERENCE_PROFILE: profile.id,
    DURE_BACKEND_IDENTITY_FILE: identity,
    DURE_BACKEND_KNOWN_HOSTS_FILE: knownHosts,
  });
}

function localProfile(overrides = {}) {
  const root = temporaryRoot();
  const raw = {
    id: "local-primary",
    default: true,
    transport: {
      kind: "local",
      endpoint: { kind: "unix_socket", path: join(root, "backend.sock") },
    },
    auth: { kind: "peer" },
    trust: { kind: "local_peer" },
    expected: {
      backendId: "local-backend",
      generation: "generation-local-1",
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 3 },
      },
      capabilities: ["agent_checkpoint.read", "agent_checkpoint.write"],
    },
    deadlineMs: 1_000,
    ...overrides,
  };
  return parseBackendProfiles(
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [raw],
    }),
  ).profiles[0];
}

function remoteProfile(overrides = {}) {
  const raw = {
    ...sshBackendProfile({
      defaultProfile: true,
      host: "build.example.test",
      user: "dure_runner",
      endpointPort: 4681,
      connectTimeoutMs: 750,
      auth: identityFileAuth("remote-build"),
      generation: "generation-remote-7",
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 2 },
      },
      capabilities: ["agent_checkpoint.read", "agent_checkpoint.write"],
      deadlineMs: 2_000,
    }),
    ...overrides,
  };
  return parseBackendProfiles(
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [raw],
    }),
  ).profiles[0];
}

function responseFor(profile, requestId, overrides = {}) {
  const backendOverrides = overrides.backend ?? {};
  return {
    schemaVersion: 1,
    apiVersion: BACKEND_TRANSPORT_API_VERSION,
    kind: "dure.backend.response",
    requestId,
    backend: {
      id: profile.expected.backendId,
      generation: profile.expected.generation,
      protocol: { major: 1, minor: 1 },
      capabilities: [...profile.expected.capabilities],
      observedAtMs: 900,
      ...backendOverrides,
    },
    result: { checkpoint: "랜딩 중", revision: 7 },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "backend"),
    ),
  };
}

function responseBytes(profile, requestId, overrides) {
  return Buffer.from(
    `${JSON.stringify(responseFor(profile, requestId, overrides))}\n`,
    "utf8",
  );
}

async function expectErrorCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BackendTransportError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

describe("Dure backend profile transport", () => {
  it("carries the saved data scope on the actual local request", async () => {
    const profile = localProfile();
    profile.expected.capabilities.push("backend.scope.v1");
    let observedRequest;
    const server = createServer((socket) => {
      let source = "";
      socket.on("data", (chunk) => {
        source += chunk.toString("utf8");
        if (!source.includes("\n")) return;
        observedRequest = JSON.parse(source.trim());
        socket.end(responseBytes(profile, observedRequest.requestId));
      });
    });
    await listen(server, profile.transport.endpoint.path);
    chmodSync(profile.transport.endpoint.path, 0o600);
    try {
      await performBackendProfileRequest(profile, {
        operation: "agent_checkpoint.write", body: { agentId: "agent-1" },
        requiredCapabilities: ["agent_checkpoint.write"], scopeId: "backend-scope-original",
      }, { now: () => 1_000 });
      expect(observedRequest.expected).toMatchObject({
        scopeId: "backend-scope-original",
        requiredCapabilities: ["agent_checkpoint.write", "backend.scope.v1"],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("requires receiver support for a saved scope and keeps malformed options typed", async () => {
    const profile = localProfile();
    const options = { operation: "agent_checkpoint.write", body: {}, scopeId: "backend-scope-original" };
    await expectErrorCode(() => createBackendTransportRequest(profile, options), "backend_transport_profile_capability_missing");
    profile.expected.capabilities.push("backend.scope.v1");
    await expectErrorCode(() => createBackendTransportRequest(profile, { ...options, requiredCapabilities: null }), "backend_transport_invalid_request");
    await expectErrorCode(() => createBackendTransportRequest(profile, { ...options, scopeId: "invalid scope" }), "backend_transport_invalid_request");
  });

  it("exchanges one bounded request over a local socket without app state", async () => {
    const profile = localProfile();
    const socketPath = profile.transport.endpoint.path;
    let observedRequest;
    const server = createServer((socket) => {
      let source = "";
      socket.on("data", (chunk) => {
        source += chunk.toString("utf8");
        if (!source.includes("\n")) return;
        observedRequest = JSON.parse(source.trim());
        socket.end(responseBytes(profile, observedRequest.requestId));
      });
    });
    await listen(server, socketPath);
    chmodSync(socketPath, 0o600);

    try {
      const result = await performBackendProfileRequest(
        profile,
        {
          body: {
            identity: {
              agentId: "agent-1",
              sessionId: "session-1",
              bindingGeneration: 3,
            },
          },
          operation: "agent_checkpoint.read",
          requestId: "request-local-1",
          requiredCapabilities: ["agent_checkpoint.read"],
        },
        { now: () => 1_000 },
      );

      expect(observedRequest).toMatchObject({
        schemaVersion: 1,
        apiVersion: BACKEND_TRANSPORT_API_VERSION,
        kind: "dure.backend.request",
        requestId: "request-local-1",
        operation: "agent_checkpoint.read",
        expected: {
          backendId: "local-backend",
          generation: "generation-local-1",
          requiredCapabilities: ["agent_checkpoint.read"],
        },
      });
      expect(result).toMatchObject({
        kind: "dure.backend.result",
        backend: {
          id: "local-backend",
          generation: "generation-local-1",
          sourceAgeMs: 100,
        },
        result: { checkpoint: "랜딩 중", revision: 7 },
      });
      expect(readFileSync(modulePath, "utf8")).not.toMatch(
        /(?:server\.json|agents\.json)/,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("refuses a local socket owned by another OS user before writing", async () => {
    const socket = new EventEmitter();
    let destroyed = false;
    let written = false;
    socket.destroy = () => {
      destroyed = true;
    };
    socket.write = () => {
      written = true;
    };
    const result = await exchangeLocalBackendRequest(
      { kind: "unix_socket", path: "/tmp/foreign-backend.sock" },
      Buffer.from("{}\n"),
      {
        connect: () => {
          queueMicrotask(() => socket.emit("connect"));
          return socket;
        },
        deadlineMs: 1_000,
        lstat: () => ({
          isSocket: () => true,
          isSymbolicLink: () => false,
          mode: 0o140600,
          uid: (process.geteuid?.() ?? 0) + 1,
        }),
      },
    );

    expect(result).toEqual({
      kind: "peer_untrusted",
      stdout: Buffer.alloc(0),
    });
    expect(destroyed).toBe(true);
    expect(written).toBe(false);
  });

  it("refuses a group-accessible local socket before writing request bytes", async () => {
    const profile = localProfile();
    const socketPath = profile.transport.endpoint.path;
    let observedBytes = 0;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        observedBytes += chunk.byteLength;
      });
    });
    await listen(server, socketPath);
    chmodSync(socketPath, 0o660);

    try {
      const result = await exchangeLocalBackendRequest(
        profile.transport.endpoint,
        Buffer.from("{}\n"),
        { deadlineMs: 1_000 },
      );
      expect(result.kind).toBe("peer_untrusted");
      expect(observedBytes).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("uses bounded non-interactive SSH stdio forwarding without reference leaks", async () => {
    const profile = remoteProfile();
    let observedArgv;
    let observedRequest;
    const result = await performBackendProfileRequest(
      profile,
      {
        body: { agentId: "agent-remote" },
        operation: "agent_checkpoint.read",
        requestId: "request-ssh-1",
        requiredCapabilities: ["agent_checkpoint.read"],
      },
      {
        now: () => 1_000,
        resolveSshReferences: ({ auth, trust }) => {
          expect(auth.reference).toBe("credential-profile:remote-build");
          expect(trust.reference).toBe("known-hosts-profile:remote-build");
          return sshReferences(profile);
        },
        sshExchange: async (argv, input) => {
          observedArgv = argv;
          observedRequest = JSON.parse(input.toString("utf8"));
          return {
            kind: "success",
            stdout: responseBytes(profile, observedRequest.requestId),
          };
        },
      },
    );

    expect(observedArgv).toContain("BatchMode=yes");
    expect(observedArgv).toContain("StrictHostKeyChecking=yes");
    expect(observedArgv).toContain("PasswordAuthentication=no");
    expect(observedArgv).toContain("127.0.0.1:4681");
    expect(observedArgv.at(-1)).toBe("build.example.test");
    expect(JSON.stringify(observedArgv)).not.toContain(
      "credential-profile:remote-build",
    );
    expect(JSON.stringify(observedArgv)).not.toContain(
      "known-hosts-profile:remote-build",
    );
    expect(observedRequest.operation).toBe("agent_checkpoint.read");
    expect(result.backend.id).toBe("remote-backend");
  });

  it("uses the fixed authenticated gateway for an SSH Unix endpoint", async () => {
    const profile = remoteProfile({
      transport: {
        kind: "ssh",
        host: "build.example.test",
        port: 22,
        user: "dure_runner",
        endpoint: {
          kind: "unix_socket",
          path: "/srv/dure/backend/control-plane.sock",
        },
        batchMode: true,
        strictHostKeyChecking: "yes",
        connectTimeoutMs: 750,
      },
      expected: {
        backendId: "remote-backend",
        generation: "generation-remote-7",
        protocol: {
          minimum: { major: 1, minor: 0 },
          maximum: { major: 1, minor: 2 },
        },
        capabilities: [
          "agent_checkpoint.read",
          "agent_checkpoint.write",
          "backend.transport.ssh_gateway",
        ],
      },
    });
    let argv;
    let request;
    const result = await performBackendProfileRequest(
      profile,
      {
        body: { agentId: "agent-remote" },
        operation: "agent_checkpoint.read",
        requestId: "request-ssh-gateway-1",
        requiredCapabilities: ["agent_checkpoint.read"],
      },
      {
        now: () => 1_000,
        resolveSshReferences: () => sshReferences(profile),
        sshExchange: async (observedArgv, input) => {
          argv = observedArgv;
          request = JSON.parse(input.toString("utf8"));
          return {
            kind: "success",
            stdout: responseBytes(profile, request.requestId),
          };
        },
      },
    );

    expect(argv).not.toContain("-W");
    expect(argv.slice(-7)).toEqual([
      "build.example.test",
      "~/.local/bin/dure-control-plane",
      "gateway",
      "--socket-hex",
      Buffer.from("/srv/dure/backend/control-plane.sock", "utf8").toString(
        "hex",
      ),
      "--expected-generation",
      "generation-remote-7",
    ]);
    expect(request.expected.requiredCapabilities).toEqual([
      "agent_checkpoint.read",
      "backend.transport.ssh_gateway",
    ]);
    expect(result.backend.capabilities).toContain(
      "backend.transport.ssh_gateway",
    );
  });

  it("runs an SSH stdio exchange without a shell", async () => {
    const input = Buffer.from("bounded-input\n", "utf8");
    const result = await exchangeSshBackendRequest(
      [
        process.execPath,
        "-e",
        "process.stdin.on('data', chunk => process.stdout.write(chunk))",
      ],
      input,
      { deadlineMs: 1_000 },
    );

    expect(result.kind).toBe("success");
    expect(result.stdout).toEqual(input);
  });

  it("builds a request only for capabilities declared by the selected profile", async () => {
    const profile = localProfile();
    const created = createBackendTransportRequest(profile, {
      body: { agentId: "agent-1" },
      operation: "agent_checkpoint.read",
      requestId: "request-capability-1",
      requiredCapabilities: ["agent_checkpoint.read"],
    });
    expect(created.bytes.byteLength).toBeLessThan(
      MAX_BACKEND_TRANSPORT_REQUEST_BYTES,
    );
    expect(created.requiredCapabilities).toEqual(["agent_checkpoint.read"]);

    await expectErrorCode(
      () =>
        Promise.resolve(
          createBackendTransportRequest(profile, {
            body: {},
            operation: "sessions.list",
            requestId: "request-capability-2",
            requiredCapabilities: ["sessions.list"],
          }),
        ),
      "backend_transport_profile_capability_missing",
    );
    await expectErrorCode(
      () =>
        Promise.resolve(
          createBackendTransportRequest(profile, {
            body: { checkpoint: "x".repeat(MAX_BACKEND_TRANSPORT_REQUEST_BYTES) },
            operation: "agent_checkpoint.write",
            requestId: "request-too-large",
            requiredCapabilities: ["agent_checkpoint.write"],
          }),
        ),
      "backend_transport_invalid_request",
    );
  });

  it.each([
    ["timeout", "backend_transport_timeout"],
    ["aborted", "backend_transport_aborted"],
    ["output_limit", "backend_transport_output_limit"],
    ["unavailable", "backend_transport_unavailable"],
  ])("maps local %s without exposing endpoint details", async (kind, code) => {
    const profile = localProfile();
    const error = await expectErrorCode(
      () =>
        performBackendProfileRequest(
          profile,
          {
            body: {},
            operation: "agent_checkpoint.read",
            requestId: `request-${kind}`,
          },
          {
            localExchange: async () => ({
              kind,
              stdout: Buffer.from(profile.transport.endpoint.path),
            }),
          },
        ),
      code,
    );
    expect(error.message).not.toContain(profile.transport.endpoint.path);
  });

  it.each([
    ["unavailable", "backend_transport_ssh_unavailable"],
    ["nonzero", "backend_transport_ssh_failed"],
  ])("maps SSH %s to a stable typed failure", async (kind, code) => {
    const profile = remoteProfile();
    await expectErrorCode(
      () =>
        performBackendProfileRequest(
          profile,
          {
            body: {},
            operation: "agent_checkpoint.read",
            requestId: `request-ssh-${kind}`,
          },
          {
            resolveSshReferences: () => sshReferences(profile),
            sshExchange: async () => ({ kind, stdout: Buffer.alloc(0) }),
          },
        ),
      code,
    );
  });

  it.each([
    [
      "backend identity",
      (response) => (response.backend.id = "other-backend"),
      "backend_transport_backend_mismatch",
    ],
    [
      "backend generation",
      (response) => (response.backend.generation = "replacement-2"),
      "backend_transport_generation_mismatch",
    ],
    [
      "protocol range",
      (response) => (response.backend.protocol = { major: 2, minor: 0 }),
      "backend_transport_protocol_incompatible",
    ],
    [
      "required capability",
      (response) => (response.backend.capabilities = ["agent_checkpoint.read"]),
      "backend_transport_capability_missing",
    ],
    [
      "request identity",
      (response) => (response.requestId = "other-request"),
      "backend_transport_malformed_response",
    ],
    [
      "unknown field",
      (response) => (response.secret = "forbidden"),
      "backend_transport_malformed_response",
    ],
    [
      "stale handshake",
      (response) => (response.backend.observedAtMs = 0),
      "backend_transport_backend_stale",
    ],
  ])("fails closed on mismatched %s", async (_name, mutate, code) => {
    const profile = localProfile();
    const response = responseFor(profile, "request-response-1");
    mutate(response);
    await expectErrorCode(
      () =>
        Promise.resolve(
          parseBackendTransportResponse(Buffer.from(JSON.stringify(response)), {
            nowMs: _name === "stale handshake" ? 120_000 : 1_000,
            profile,
            requestId: "request-response-1",
            requiredCapabilities: ["agent_checkpoint.read"],
          }),
        ),
      code,
    );
  });

  it("rejects banner corruption, invalid UTF-8, and oversized responses", async () => {
    const profile = localProfile();
    const options = {
      nowMs: 1_000,
      profile,
      requestId: "request-malformed-1",
      requiredCapabilities: ["agent_checkpoint.read"],
    };
    for (const value of [
      Buffer.from(`banner\n${JSON.stringify(responseFor(profile, options.requestId))}`),
      Buffer.from([0xc3, 0x28]),
    ]) {
      await expectErrorCode(
        () => Promise.resolve(parseBackendTransportResponse(value, options)),
        "backend_transport_malformed_response",
      );
    }
    await expectErrorCode(
      () =>
        Promise.resolve(
          parseBackendTransportResponse(
            Buffer.alloc(MAX_BACKEND_TRANSPORT_RESPONSE_BYTES + 1, 0x78),
            options,
          ),
        ),
      "backend_transport_output_limit",
    );
  });

  it("validates remote errors only after the backend handshake", async () => {
    const profile = localProfile();
    const response = responseFor(profile, "request-remote-error", {
      kind: "dure.backend.error",
      error: {
        code: "revision_conflict",
        message: "revision conflict",
        details: { disposition: "stale_generation", diagnostic: "retained" },
      },
    });
    delete response.result;
    const error = await expectErrorCode(
      () =>
        Promise.resolve(
          parseBackendTransportResponse(Buffer.from(JSON.stringify(response)), {
            nowMs: 1_000,
            profile,
            requestId: "request-remote-error",
          }),
        ),
      "backend_transport_remote_error",
    );
    expect(backendTransportErrorReport(error, profile)).toEqual({
      schemaVersion: 1,
      apiVersion: BACKEND_TRANSPORT_API_VERSION,
      kind: "dure.backend.transport_error",
      profile: { id: "local-primary", transport: "local" },
      error: {
        code: "backend_transport_remote_error",
        message: "the backend rejected the request",
        remoteCode: "revision_conflict",
        disposition: "stale_generation",
      },
    });
  });

  it.each(["dispatch_completed", "private /Users/name/path", "secret\nvalue", "x".repeat(129)])(
    "only exposes bounded semantic backend reason codes: %s",
    async (reasonCode) => {
      const profile = localProfile();
      const response = responseFor(profile, "request-reason-code", {
        kind: "dure.backend.error",
        error: {
          code: "orchestration_state_conflict",
          message: "private backend diagnostic",
          details: { reasonCode, secret: "must-not-escape", disposition: "terminal" },
        },
      });
      delete response.result;
      const error = await expectErrorCode(() => Promise.resolve(
        parseBackendTransportResponse(Buffer.from(JSON.stringify(response)), {
          nowMs: 1_000, profile, requestId: "request-reason-code",
        }),
      ), "backend_transport_remote_error");
      const report = backendTransportErrorReport(error, profile).error;
      expect(report.reasonCode).toBe(reasonCode === "dispatch_completed" ? reasonCode : undefined);
      expect(JSON.stringify(report)).not.toContain("private");
      expect(JSON.stringify(report)).not.toContain("must-not-escape");
    },
  );

  it("fails closed when SSH references or endpoint forwarding are unavailable", async () => {
    const profile = remoteProfile();
    await expectErrorCode(
      () =>
        performBackendProfileRequest(profile, {
          body: {},
          operation: "agent_checkpoint.read",
          requestId: "request-no-reference",
        }),
      "backend_transport_reference_unavailable",
    );

    const unsupported = remoteProfile({
      transport: {
        ...profile.transport,
        endpoint: { kind: "windows_named_pipe", name: "\\\\.\\pipe\\dure" },
      },
    });
    await expectErrorCode(
      () =>
        Promise.resolve(
          buildBackendSshArgv(unsupported, {
            identityFile: "/private/tmp/dure-identity",
            knownHostsFile: "/private/tmp/dure-known-hosts",
          }),
        ),
      "backend_transport_endpoint_unsupported",
    );
  });

  it("keeps the transport free of legacy/app authority and shell execution", () => {
    const source = readFileSync(modulePath, "utf8");
    expect(source).not.toMatch(/HEBBIAN_/);
    expect(source).not.toMatch(/(?:server\.json|agents\.json)/);
    expect(source).not.toMatch(/\bshell\s*:\s*true\b/);
    expect(source).not.toMatch(/\b(?:exec|execFile)\s*\(/);
  });
});

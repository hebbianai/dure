import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { appControlDirectory } from "./app-channel.mjs";

const processBoundary = vi.hoisted(() => ({
  observeProcessLiveness: vi.fn(),
}));

vi.mock("./process-identity.mjs", () => processBoundary);

import {
  observeDevLaunchParentGeneration,
  observeDevLaunchRestartAuthority,
  requestDevLaunchParentReload,
} from "./dev-launch-client.mjs";
import {
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE,
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
} from "./dev-launch-contract.mjs";

const fixtures = [];

function writeDescriptor(pathname, descriptor) {
  writeFileSync(pathname, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
}

async function startParentFixture(onRequest, descriptorOverrides = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "dure-parent-liveness-"));
  const home = join(fixtureRoot, "home");
  const root = join(fixtureRoot, "worktree");
  const channel = `dev-parent-liveness-${fixtureRoot.slice(-8).toLowerCase()}`;
  const controlDirectory = appControlDirectory(home, channel);
  const descriptorPath = join(
    controlDirectory,
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\dure-parent-liveness-${process.pid}-${fixtureRoot.slice(-8)}`
    : join(fixtureRoot, "supervisor.sock");
  const supervisor = {
    pid: 41_001,
    processIdentity: "predecessor-process",
    generation: "a".repeat(64),
  };
  const launch = {
    pid: 41_002,
    processIdentity: "launch-process",
    generation: "b".repeat(64),
  };
  const baseDescriptor = {
    schemaVersion: 1,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "ready",
    worktreeRoot: root,
    channel,
    socketPath,
    capability: "c".repeat(64),
    capabilities: ["child_restart", "parent_reload"],
    sourceGeneration: "d".repeat(64),
    supervisor,
    launch,
    publishedAtMs: Date.now(),
    ...descriptorOverrides,
  };
  let request;
  const server = createServer((connection) => {
    let body = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      request = JSON.parse(body.slice(0, newline));
      onRequest({
        connection,
        descriptorPath,
        descriptor: baseDescriptor,
        request,
      });
    });
  });

  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  chmodSync(controlDirectory, 0o700);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  writeDescriptor(descriptorPath, baseDescriptor);

  const fixture = {
    channel,
    descriptorPath,
    home,
    root,
    request: () => request,
    close: async () => {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function parentReloadFailure(fixture) {
  let failure;
  try {
    await requestDevLaunchParentReload({
      home: fixture.home,
      root: fixture.root,
      channel: fixture.channel,
      sourceGeneration: "e".repeat(64),
      timeoutMs: 250,
    });
  } catch (error) {
    failure = error;
  }
  return failure;
}

function startMissingDescriptorFixture() {
  return startParentFixture(({ connection, descriptorPath }) => {
    unlinkSync(descriptorPath);
    connection.destroy();
  });
}

function startupFailureFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "dure-startup-failure-"));
  const home = join(fixtureRoot, "home");
  const root = join(fixtureRoot, "worktree");
  const channel = `dev-startup-failure-${fixtureRoot.slice(-8).toLowerCase()}`;
  const controlDirectory = appControlDirectory(home, channel);
  const descriptorPath = join(
    controlDirectory,
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const sourceGeneration = "d".repeat(64);
  const hmuxProviderIdentity = {
    sessionId: "standalone_startup_failure",
    workspaceId: "workspace_startup_failure",
  };
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  chmodSync(controlDirectory, 0o700);
  writeDescriptor(descriptorPath, {
    schemaVersion: 1,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "preparing",
    worktreeRoot: root,
    channel,
    socketPath: join(fixtureRoot, "closed.sock"),
    capability: "c".repeat(64),
    capabilities: [],
    sourceGeneration,
    supervisor: {
      pid: 41_001,
      processIdentity: "failed-supervisor-process",
      generation: "a".repeat(64),
    },
    launch: null,
    startupFailure: {
      type: "startup_failure",
      hmux: hmuxProviderIdentity,
      reason: "fixture low headroom",
      failedAtMs: Date.now(),
    },
    publishedAtMs: Date.now(),
  });
  const fixture = {
    home,
    root,
    channel,
    sourceGeneration,
    hmuxProviderIdentity,
    close: async () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  processBoundary.observeProcessLiveness.mockReset();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

it("observes every live runtime state accepted by child restart", async () => {
  processBoundary.observeProcessLiveness.mockResolvedValue("active");
  const legacy = await startParentFixture(() => {}, {
    protocolVersion: LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    sourceGeneration: undefined,
  });
  const preparing = await startParentFixture(() => {}, {
    state: "preparing",
    capabilities: [
      "child_restart",
      DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
    ],
    frontend: {
      pid: 41_003,
      processIdentity: "frontend-process",
      generation: "e".repeat(64),
    },
  });

  await expect(
    observeDevLaunchRestartAuthority({
      home: legacy.home,
      root: legacy.root,
      channel: legacy.channel,
      timeoutMs: 250,
    }),
  ).resolves.toMatchObject({
    protocolVersion: LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "ready",
  });
  await expect(
    observeDevLaunchRestartAuthority({
      home: preparing.home,
      root: preparing.root,
      channel: preparing.channel,
      timeoutMs: 250,
    }),
  ).resolves.toMatchObject({
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "preparing",
  });
  expect(legacy.request()).toBeUndefined();
  expect(preparing.request()).toBeUndefined();
});

it("rejects a runtime descriptor whose supervisor is not live", async () => {
  processBoundary.observeProcessLiveness.mockResolvedValue("stale");
  const fixture = await startParentFixture(() => {});

  await expect(
    observeDevLaunchRestartAuthority({
      home: fixture.home,
      root: fixture.root,
      channel: fixture.channel,
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({
    code: DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE,
    destructiveBoundaryCrossed: false,
  });
  expect(fixture.request()).toBeUndefined();
});

it("reports only the exact Hmux startup failure", async () => {
  const fixture = startupFailureFixture();

  await expect(
    observeDevLaunchParentGeneration({
      home: fixture.home,
      root: fixture.root,
      channel: fixture.channel,
      sourceGeneration: fixture.sourceGeneration,
      hmuxProviderIdentity: fixture.hmuxProviderIdentity,
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({
    message: "fixture low headroom",
  });

  await expect(
    observeDevLaunchParentGeneration({
      home: fixture.home,
      root: fixture.root,
      channel: fixture.channel,
      sourceGeneration: fixture.sourceGeneration,
      hmuxProviderIdentity: {
        ...fixture.hmuxProviderIdentity,
        sessionId: "standalone_next_attempt",
      },
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({
    code: DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE,
  });
});

it("keeps unavailable predecessor liveness indeterminate after admission loss", async () => {
  processBoundary.observeProcessLiveness.mockResolvedValue("unknown");
  const fixture = await startMissingDescriptorFixture();

  const failure = await parentReloadFailure(fixture);

  expect(failure).toMatchObject({
    destructiveBoundaryCrossed: true,
    parentReloadRequestId: fixture.request().requestId,
  });
  expect(failure.message).toMatch(/predecessor liveness is indeterminate/);
  expect(failure.message).not.toMatch(/exited/);
});

it("marks only a stale predecessor exit safe before handoff", async () => {
  processBoundary.observeProcessLiveness.mockResolvedValue("stale");
  const fixture = await startMissingDescriptorFixture();

  const failure = await parentReloadFailure(fixture);

  expect(failure).toMatchObject({
    destructiveBoundaryCrossed: false,
    parentReloadRequestId: fixture.request().requestId,
  });
  expect(failure.message).toMatch(/predecessor exited/);
});

it("keeps unavailable successor liveness indeterminate before activation", async () => {
  processBoundary.observeProcessLiveness.mockResolvedValue("unknown");
  const fixture = await startParentFixture(
    ({ connection, descriptorPath, descriptor, request }) => {
      writeDescriptor(descriptorPath, {
        ...descriptor,
        state: "preparing",
        sourceGeneration: request.targetSourceGeneration,
        supervisor: {
          ...descriptor.supervisor,
          generation: request.targetSupervisorGeneration,
        },
        launch: null,
        activation: {
          type: "parent_reload",
          requestId: request.requestId,
          previousSupervisor: descriptor.supervisor,
          previousLaunch: descriptor.launch,
          sourceGeneration: request.targetSourceGeneration,
        },
        publishedAtMs: Date.now(),
      });
      connection.destroy();
    },
  );

  const failure = await parentReloadFailure(fixture);

  expect(failure).toMatchObject({
    destructiveBoundaryCrossed: true,
    parentReloadRequestId: fixture.request().requestId,
  });
  expect(failure.message).toMatch(/successor liveness is indeterminate/);
  expect(failure.message).not.toMatch(/exited/);
});

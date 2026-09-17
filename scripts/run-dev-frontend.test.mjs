import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DEV_LAUNCH_FRONTEND_READY_PATH } from "./lib/dev-launch-contract.mjs";
import { tryBackendRuntimeFingerprint } from "./lib/backend-runtime-fingerprint.mjs";
import { requireCurrentNodeDependencyInstall } from "./node-dependency-preflight.mjs";
import {
  boundedDevLaunchFixtureOutcome,
  createDevLaunchFixtureRegistry,
  runDevLaunchFixtureCleanup,
} from "./lib/dev-launch-test-support.mjs";
import {
  processGroupId,
  processIdentity,
} from "./lib/process-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = fileURLToPath(new URL("./run-dev-frontend.mjs", import.meta.url));
const channel = "dev-frontend-wrapper-test-1234567890";
const generation = "a".repeat(64);
const children = [];
const fixtureProcesses = createDevLaunchFixtureRegistry();
const processGroupAdapterSupported =
  process.platform === "darwin" || process.platform === "linux";

function listen(listener, port = 0) {
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
}

function close(listener) {
  return new Promise((resolve) => listener.close(resolve));
}

async function unusedPort() {
  const listener = createServer();
  await listen(listener);
  const address = listener.address();
  if (!address || typeof address === "string") {
    await close(listener);
    throw new Error("frontend wrapper fixture did not allocate a port");
  }
  await close(listener);
  return address.port;
}

function spawnFrontend(port) {
  const child = spawn(
    process.execPath,
    [runner, "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: channel,
        DURE_DEV_FRONTEND_GENERATION: generation,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stderr: () => stderr }),
    );
  });
  const ownership = fixtureProcesses.registerSpawn(child);
  const frontend = {
    child,
    exited,
    stderr: () => stderr,
    leaderIdentity: waitFor(() => processIdentity(child.pid)).catch(() => null),
    witnessRecord: null,
    witnessReady: null,
  };
  frontend.witnessReady = nextMessage(
    child,
    "process_group_witness_ready",
  ).then(async (message) => {
    const identity = await waitFor(() => processIdentity(message.pid));
    frontend.witnessRecord = { ...message, processIdentity: identity };
    const leaderIdentity = await frontend.leaderIdentity;
    if (leaderIdentity) {
      ownership.bind({
        pid: child.pid,
        processIdentity: leaderIdentity,
        processGroup: {
          kind: "posix_process_group_v1",
          id: child.pid,
          witness: {
            pid: message.pid,
            processIdentity: identity,
          },
        },
      });
    }
    return frontend.witnessRecord;
  });
  frontend.witnessReady.catch(() => {});
  children.push(frontend);
  return frontend;
}

function nextMessage(child, type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

async function activate(frontend) {
  const acknowledgement = nextMessage(frontend.child, "frontend_activated");
  frontend.child.send({
    schemaVersion: 1,
    type: "frontend_activate",
    channel,
    generation,
  });
  await expect(acknowledgement).resolves.toEqual({
    schemaVersion: 1,
    type: "frontend_activated",
    channel,
    generation,
  });
}

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch {}
      if (Date.now() >= deadline) {
        reject(new Error("frontend wrapper fixture observation timed out"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

afterEach(async () => {
  const spawnedChildren = children.splice(0);
  await runDevLaunchFixtureCleanup([
    () => fixtureProcesses.retireAll(),
    ...spawnedChildren.map(({ exited }) => () =>
      boundedDevLaunchFixtureOutcome(exited, {
        label: "frontend fixture child exit",
      })
    ),
  ]);
});

it.runIf(processGroupAdapterSupported)(
  "exits before readiness when strictPort finds an unrelated listener",
  async () => {
  const listener = createServer();
  await listen(listener);
  const address = listener.address();
  if (!address || typeof address === "string") {
    await close(listener);
    throw new Error("frontend wrapper fixture did not allocate a port");
  }

  try {
    const frontend = spawnFrontend(address.port);
    const outcome = await frontend.exited;
    expect(outcome).toMatchObject({ code: 1, signal: null });
    expect(outcome.stderr()).toContain(`Port ${address.port} is already in use`);
    expect(listener.listening).toBe(true);
  } finally {
    await close(listener);
  }
  },
);

it.runIf(processGroupAdapterSupported)(
  "retires an unactivated candidate when its supervisor disconnects",
  async () => {
  const port = await unusedPort();
  const frontend = spawnFrontend(port);
  await expect(nextMessage(frontend.child, "frontend_ready")).resolves.toEqual({
    schemaVersion: 1,
    protocolVersion: 1,
    type: "frontend_ready",
    channel,
    generation,
  });
  const witness = await frontend.witnessReady;

  frontend.child.disconnect();
  await expect(frontend.exited).resolves.toMatchObject({ code: 1, signal: null });
  await waitFor(() => processIdentity(witness.pid) === null);
  const replacementListener = createServer();
  await listen(replacementListener, port);
  await close(replacementListener);
  },
);

it.runIf(processGroupAdapterSupported)(
  "survives supervisor disconnect only after exact activation",
  async () => {
  const port = await unusedPort();
  const frontend = spawnFrontend(port);
  await nextMessage(frontend.child, "frontend_ready");
  const witness = await frontend.witnessReady;
  expect(processGroupId(witness.pid)).toBe(frontend.child.pid);
  await activate(frontend);
  const identity = processIdentity(frontend.child.pid);
  expect(identity).toBeTruthy();

  frontend.child.disconnect();
  const response = await fetch(
    `http://127.0.0.1:${port}${DEV_LAUNCH_FRONTEND_READY_PATH}`,
  );
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    protocolVersion: 1,
    type: "frontend_ready",
    channel,
    generation,
    backendRuntimeFingerprint: tryBackendRuntimeFingerprint(root),
    nodeDependencyFingerprint: requireCurrentNodeDependencyInstall(root).fingerprint,
  });
  expect(processIdentity(frontend.child.pid)).toBe(identity);
  },
);

it.runIf(!processGroupAdapterSupported)(
  "reports typed process-group unavailability during frontend preflight",
  async () => {
    const child = spawn(
      process.execPath,
      [runner, "--check", "--host", "127.0.0.1", "--port", "1420"],
      { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(outcome).toEqual({ code: 1, signal: null });
    expect(stderr).toContain("development process groups are unsupported");
  },
);

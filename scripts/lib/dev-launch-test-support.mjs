import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, delimiter, join } from "node:path";
import { appControlDirectory } from "./app-channel.mjs";
import {
  CHILD_STOP_TIMEOUT_MS,
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  descriptorOwnedLaunchIdentities,
  exactDescriptor,
  parentGenerationFrame,
  sameDevLaunchIdentity,
  sameOptionalDevLaunchIdentity,
} from "./dev-launch-contract.mjs";
import {
  PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
  observeOwnedProcessGroup,
  signalExactProcess,
  signalOwnedProcessGroup,
} from "./process-group-authority.mjs";
import {
  observeProcessLiveness,
  processIdentity,
} from "./process-identity.mjs";

export const processGroupWitnessModuleUrl = new URL(
  "./process-group-witness.mjs",
  import.meta.url,
).href;
export const FIXTURE_LIFECYCLE_TIMEOUT_MS = CHILD_STOP_TIMEOUT_MS;

export function writeFixtureNodeDependencies(root, lock = "lockfileVersion: '9.0'\n") {
  mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  writeFileSync(join(root, "node_modules/.pnpm/lock.yaml"), lock);
}

export function writeFixtureBackendRuntime(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src-tauri/binaries"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "src-tauri/binaries/\n");
  writeFileSync(join(root, "scripts/backend-runtime-inputs.txt"),
    "src-tauri/tauri.conf.json\nartifact-prefix:src-tauri/binaries/hmux-runtime-\n");
  writeFileSync(join(root, "src-tauri/binaries/hmux-runtime-fixture"), "runtime-v1");
}

export function writeFixtureTauriCli(root, source) {
  const packageRoot = join(root, "node_modules", "@tauri-apps", "cli");
  const relativePath = "fixture/direct-cli.cjs";
  const pathname = join(packageRoot, "fixture", "direct-cli.cjs");
  mkdirSync(join(packageRoot, "fixture"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@tauri-apps/cli",
      type: "commonjs",
      bin: { tauri: `./${relativePath}` },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    pathname,
    `if (require.main !== module) process.exit(65);\n${source}`,
    { mode: 0o600 },
  );
  return pathname;
}

export async function startDevLaunchEndpointFixture({
  fixtureRoot,
  home,
  fixtureHome,
  worktreeRoot,
  channel,
  protocolVersion = DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  capabilities,
  sourceGeneration,
  supervisorIdentity,
  launchIdentity,
  frontendIdentity,
  replacementIdentity,
  replacementFrontendIdentity,
  onRequest,
}) {
  const controlDirectory = appControlDirectory(home ?? fixtureHome, channel);
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\dure-supervisor-${process.pid}-${basename(fixtureRoot)}`
      : join(fixtureRoot, "supervisor.sock");
  const supervisor = supervisorIdentity ?? {
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    generation: "a".repeat(64),
  };
  const launch = launchIdentity ?? {
    pid: 4_321,
    processIdentity: "fixture-child-one",
    generation: "b".repeat(64),
  };
  const replacement = replacementIdentity ?? {
    pid: 5_432,
    processIdentity: "fixture-child-two",
    generation: "c".repeat(64),
  };
  const replacementFrontend = replacementFrontendIdentity ?? {
    pid: 6_543,
    processIdentity: "fixture-frontend-two",
    generation: "e".repeat(64),
  };
  const capability = "d".repeat(64);
  const requests = [];
  const descriptorPath = join(
    controlDirectory,
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const writeDescriptor = (descriptor) =>
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
      mode: 0o600,
    });
  const server = createServer((connection) => {
    let body = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(body.slice(0, newline));
      requests.push(request);
      onRequest({
        request,
        connection,
        supervisor,
        launch,
        frontend: frontendIdentity,
        replacement,
        replacementFrontend,
        capability,
        descriptorPath,
        socketPath,
        writeDescriptor,
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
  writeDescriptor({
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    ...(protocolVersion === null ? {} : { protocolVersion }),
    state: "ready",
    worktreeRoot,
    channel,
    socketPath,
    capability,
    ...(capabilities ? { capabilities } : {}),
    ...(sourceGeneration ? { sourceGeneration } : {}),
    supervisor,
    launch,
    ...(frontendIdentity ? { frontend: frontendIdentity } : {}),
    publishedAtMs: Date.now(),
  });

  return {
    capability,
    descriptorPath,
    frontend: frontendIdentity,
    launch,
    replacement,
    replacementFrontend,
    requests,
    socketPath,
    supervisor,
    writeDescriptor,
    close: () =>
      server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve(),
  };
}

export async function startConvergentDevLaunchParentFixture({
  concurrentActivationDelayMs,
  turnoverDuringConvergenceProbe = false,
  ...options
}) {
  const concurrentActivation = concurrentActivationDelayMs !== undefined;
  let activationTimer;
  let turnoverPending = false;
  const fixture = await startDevLaunchEndpointFixture({
    ...options,
    onRequest({
      request,
      connection,
      supervisor,
      launch,
      frontend,
      replacement,
      replacementFrontend,
      capability,
      socketPath,
      descriptorPath,
      writeDescriptor,
    }) {
      if (request.type === "parent_generation_probe") {
        let descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        if (turnoverPending) {
          turnoverPending = false;
          descriptor = {
            ...descriptor,
            supervisor: {
              ...descriptor.supervisor,
              generation: "8".repeat(64),
            },
            publishedAtMs: Date.now(),
          };
          writeDescriptor(descriptor);
        }
        connection.end(
          `${JSON.stringify(parentGenerationFrame(descriptor))}\n`,
        );
        return;
      }
      if (
        request.type !== "parent_reload" ||
        request.capability !== capability ||
        !sameDevLaunchIdentity(request.expectedSupervisor, supervisor) ||
        !sameDevLaunchIdentity(request.expectedLaunch, launch) ||
        !sameOptionalDevLaunchIdentity(request.expectedFrontend, frontend)
      ) {
        connection.destroy(new Error("invalid parent reload fixture request"));
        return;
      }
      const successor = {
        ...supervisor,
        generation: concurrentActivation
          ? "9".repeat(64)
          : request.targetSupervisorGeneration,
      };
      const capabilities = options.capabilities ?? [];
      const readyDescriptor = {
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "ready",
        worktreeRoot: options.worktreeRoot,
        channel: options.channel,
        socketPath,
        capability,
        capabilities,
        sourceGeneration: request.targetSourceGeneration,
        supervisor: successor,
        launch: replacement,
        ...(frontend ? { frontend: replacementFrontend } : {}),
        ...(!concurrentActivation
          ? {
              activation: {
                type: "parent_reload",
                requestId: request.requestId,
                previousSupervisor: supervisor,
                previousLaunch: launch,
                ...(frontend ? { previousFrontend: frontend } : {}),
                sourceGeneration: request.targetSourceGeneration,
                launch: replacement,
                ...(frontend ? { frontend: replacementFrontend } : {}),
                activatedAtMs: Date.now(),
              },
            }
          : {}),
        publishedAtMs: Date.now(),
      };
      if (concurrentActivation) {
        writeDescriptor({
          ...readyDescriptor,
          state: "preparing",
          launch: null,
          ...(frontend ? { frontend: null } : {}),
        });
        activationTimer = setTimeout(() => {
          activationTimer = undefined;
          writeDescriptor(readyDescriptor);
          turnoverPending = turnoverDuringConvergenceProbe;
        }, concurrentActivationDelayMs);
      } else {
        writeDescriptor(readyDescriptor);
      }
      connection.end(
        `${JSON.stringify(
          concurrentActivation
            ? {
                schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
                protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                type: "parent_reload_rejected",
                requestId: request.requestId,
                reason: "target generation became active",
                destructiveBoundaryCrossed: false,
              }
            : {
                schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
                protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                type: "parent_reload_admitted",
                requestId: request.requestId,
                worktreeRoot: options.worktreeRoot,
                channel: options.channel,
                previousSupervisor: supervisor,
                previousLaunch: launch,
                ...(frontend ? { previousFrontend: frontend } : {}),
                targetSupervisorGeneration:
                  request.targetSupervisorGeneration,
                targetSourceGeneration: request.targetSourceGeneration,
              },
        )}\n`,
      );
    },
  });
  return {
    ...fixture,
    close: async () => {
      if (activationTimer !== undefined) {
        clearTimeout(activationTimer);
        activationTimer = undefined;
      }
      await fixture.close();
    },
  };
}

export function waitForFileObservation(
  observeValue,
  timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    const poll = () => {
      try {
        const value = observeValue();
        if (value) {
          resolve(value);
          return;
        }
      } catch {}
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        reject(new Error("fixture file observation timed out"));
        return;
      }
      setTimeout(poll, Math.min(20, remainingMs));
    };
    poll();
  });
}

export function waitForJsonFile(pathname, predicate, timeoutMs) {
  return waitForFileObservation(
    () => predicate(JSON.parse(readFileSync(pathname, "utf8"))),
    timeoutMs,
  );
}

export function waitForFileContent(pathname, predicate, timeoutMs) {
  return waitForFileObservation(
    () => existsSync(pathname) && predicate(readFileSync(pathname, "utf8")),
    timeoutMs,
  );
}

function descriptorDiagnostic(descriptor) {
  const generation = (identity) => identity?.generation ?? "none";
  return [
    `state=${descriptor.state}`,
    `launch=${generation(descriptor.launch)}`,
    `candidateLaunch=${generation(descriptor.candidateLaunch)}`,
    `frontend=${generation(descriptor.frontend)}`,
    `candidateFrontend=${generation(descriptor.candidateFrontend)}`,
  ].join(" ");
}

export function startManagedDevLaunchFixture({
  fixtureProcesses,
  fixtureReleasePaths = [],
  superviseDevLaunch,
  ...options
}) {
  const descriptorPath = join(
    appControlDirectory(options.home, options.channel),
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const outcome = superviseDevLaunch(options);
  const readDescriptor = () =>
    exactDescriptor(JSON.parse(readFileSync(descriptorPath, "utf8")), {
      channel: options.channel,
      worktreeRoot: options.worktreeRoot,
    });
  const retireDescriptor = async () => {
    let descriptor;
    try {
      descriptor = readDescriptor();
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const identity of descriptorOwnedLaunchIdentities(
      descriptor,
    ).reverse()) {
      await fixtureProcesses.retireIdentity(identity);
    }
  };
  const observeDescriptor = async (predicate) => {
    try {
      return await waitForJsonFile(
        descriptorPath,
        predicate,
        FIXTURE_LIFECYCLE_TIMEOUT_MS,
      );
    } catch (error) {
      let diagnostic = "descriptor=unavailable";
      try {
        diagnostic = descriptorDiagnostic(readDescriptor());
      } catch {}
      throw new Error(`${error.message}: ${diagnostic}`, { cause: error });
    }
  };
  const observeFile = (pathname, predicate) =>
    waitForFileContent(pathname, predicate, FIXTURE_LIFECYCLE_TIMEOUT_MS);
  let cleanup;
  let cleanupPromise;
  const dispose = () => {
    cleanupPromise ??= (async () => {
      let cleanupFailure;
      let outcomeValue;
      const attempt = async (operation) => {
        try {
          await operation();
        } catch (error) {
          cleanupFailure ??= error;
        }
      };
      try {
        for (const pathname of fixtureReleasePaths) {
          try {
            writeFileSync(pathname, "release\n", { mode: 0o600 });
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
        await attempt(retireDescriptor);
        outcomeValue = await outcome.catch(() => undefined);
        await attempt(retireDescriptor);
        if (cleanupFailure) throw cleanupFailure;
        return outcomeValue;
      } finally {
        cleanup.release();
      }
    })();
    return cleanupPromise;
  };
  cleanup = fixtureProcesses.registerCleanup(dispose);
  return {
    descriptorPath,
    dispose,
    observeDescriptor,
    observeFile,
    outcome,
    readDescriptor,
  };
}

export async function boundedDevLaunchFixtureOutcome(
  outcome,
  {
    label = "dev launch fixture child exit",
    timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS,
  } = {},
) {
  let timeout;
  try {
    return await Promise.race([
      outcome,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`${label} exceeded ${timeoutMs}ms`);
          error.code = "DEV_LAUNCH_FIXTURE_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runDevLaunchFixtureCleanup(cleanups) {
  const failures = [];
  const attempt = async (cleanup) => {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const cleanup of cleanups) {
    await attempt(cleanup);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "dev launch fixture teardown was incomplete",
    );
  }
}

export function simulatedLinuxProcessBoundaryEnvironment({
  root,
  mode,
  environment = process.env,
}) {
  const preload = join(root, "linux-platform.cjs");
  writeFileSync(
    preload,
    'Object.defineProperty(process, "platform", { value: "linux" });\n',
    { mode: 0o600 },
  );
  const python = spawnSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  );
  if (python.status !== 0) {
    throw new Error(`Python fixture is unavailable: ${python.stderr}`);
  }
  const python3 = join(root, "python3");
  writeFileSync(
    python3,
    `#!${python.stdout.trim()}
import errno
import os
import runpy
import signal
import sys

helper = sys.argv[1]
operation = sys.argv[2]
mode = os.environ["DURE_QA_LINUX_PIDFD_MODE"]
sys.platform = "linux"
if operation == "observe-point":
    for value in sys.argv[3:]:
        pid = int(value, 10)
        try:
            os.kill(pid, 0)
            group = os.getpgid(pid)
            session = os.getsid(pid)
        except OSError:
            continue
        print(f"M {pid} 1 {group} {session} live linux:test-boot:{pid}")
    raise SystemExit(0)
if operation == "observe-group":
    raise SystemExit(0)
if mode == "missing-apis":
    if hasattr(os, "pidfd_open"):
        delattr(os, "pidfd_open")
    if hasattr(signal, "pidfd_send_signal"):
        delattr(signal, "pidfd_send_signal")
else:
    def pidfd_open(_pid, _flags):
        if mode == "kernel-open-unsupported":
            raise OSError(errno.ENOSYS, "pidfd unavailable")
        if mode == "target-operation" and _pid == os.getpid():
            raise OSError(errno.EPERM, "unexpected self probe")
        return os.open(os.devnull, os.O_RDONLY)

    def pidfd_send_signal(*_arguments):
        if mode == "kernel-signal-unsupported":
            raise OSError(errno.ENOSYS, "pidfd signaling unavailable")

    os.pidfd_open = pidfd_open
    signal.pidfd_send_signal = pidfd_send_signal
sys.argv = sys.argv[1:]
runpy.run_path(helper, run_name="__main__")
`,
    { mode: 0o700 },
  );
  return {
    ...environment,
    DURE_QA_LINUX_PIDFD_MODE: mode,
    NODE_OPTIONS: [
      environment.NODE_OPTIONS,
      `--require=${preload}`,
    ].filter(Boolean).join(" "),
    PATH: `${root}${delimiter}${environment.PATH ?? ""}`,
  };
}

export function sendDevLaunchFixtureFrame(
  socketPath,
  value,
  { timeoutMs } = {},
) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    let body = "";
    let timeout;
    let settled = false;
    const settle = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.destroy();
      callback(result);
    };
    connection.setEncoding("utf8");
    connection.once("connect", () => {
      connection.write(`${JSON.stringify(value)}\n`, () => {
        if (!settled && timeoutMs !== undefined) {
          timeout = setTimeout(
            () => settle(
              reject,
              new Error(`dev launch frame exceeded ${timeoutMs}ms`),
            ),
            timeoutMs,
          );
        }
      });
    });
    connection.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline !== -1) {
        settle(resolve, JSON.parse(body.slice(0, newline)));
      }
    });
    connection.once("error", (error) => settle(reject, error));
  });
}

export function processGroupWitnessReadySource(
  channelExpression,
  generationExpression,
) {
  return `const { spawnProcessGroupWitness } = await import(${JSON.stringify(processGroupWitnessModuleUrl)});
const groupWitness = await spawnProcessGroupWitness();
process.send({
  schemaVersion: ${DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION},
  protocolVersion: ${PROCESS_GROUP_WITNESS_PROTOCOL_VERSION},
  type: "process_group_witness_ready",
  channel: ${channelExpression},
  generation: ${generationExpression},
  pid: groupWitness.pid,
});`;
}

function waitForRetirement(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) {
          resolve(true);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 20);
    };
    void poll();
  });
}

function samePhysicalProcess(left, right) {
  return (
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity
  );
}

async function retireFixtureIdentity(identity, timeoutMs) {
  if (identity.processGroup) {
    const observe = () => observeOwnedProcessGroup(identity);
    const retired = async () => (await observe()).state === "retired";
    const initial = await observe();
    if (initial.state === "retired") return;
    if (initial.state !== "owned") {
      const error = new Error(
        `fixture process group ${identity.processGroup.id} lacks exact cleanup authority`,
      );
      error.code = "DEV_FIXTURE_PROCESS_GROUP_AUTHORITY_UNAVAILABLE";
      throw error;
    }
    await signalOwnedProcessGroup(identity, "SIGTERM");
    if (await waitForRetirement(retired, timeoutMs)) return;
    await signalOwnedProcessGroup(identity, "SIGKILL");
    if (await waitForRetirement(retired, timeoutMs)) return;
    throw new Error(
      `fixture process group ${identity.processGroup.id} did not retire`,
    );
  }
  const retired = async () => {
    const observed = await observeProcessLiveness(identity);
    if (observed === "unknown") {
      const error = new Error(
        `fixture process ${identity.pid} identity observation is incomplete`,
      );
      error.code = "DEV_FIXTURE_PROCESS_IDENTITY_UNAVAILABLE";
      throw error;
    }
    return observed === "stale";
  };
  if (await retired()) return;
  await signalExactProcess(identity, "SIGTERM");
  if (await waitForRetirement(retired, timeoutMs)) return;
  await signalExactProcess(identity, "SIGKILL");
  if (await waitForRetirement(retired, timeoutMs)) return;
  throw new Error(`fixture process ${identity.pid} did not retire`);
}

export function createDevLaunchFixtureRegistry(
  { timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS } = {},
) {
  const cleanupObligations = [];
  const records = [];
  const descriptorPaths = [];

  function registerCleanup(cleanup) {
    const obligation = { active: true, cleanup };
    cleanupObligations.push(obligation);
    return {
      release() {
        obligation.active = false;
      },
    };
  }

  function registerIdentity(identity) {
    const record = { identity };
    records.push(record);
    return record;
  }

  function registerSpawn(child) {
    const record = {
      identity: null,
      pid: child.pid,
      processIdentity: processIdentity(child.pid),
      exited: false,
      spawnFailed: false,
    };
    records.push(record);
    if (!record.processIdentity) {
      child.once("spawn", () => {
        record.pid = child.pid;
        record.processIdentity = processIdentity(child.pid);
      });
    }
    child.once("exit", () => {
      record.exited = true;
    });
    child.once("error", () => {
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
        record.spawnFailed = true;
      }
    });
    return {
      bind(identity) {
        record.identity = identity;
        return identity;
      },
    };
  }

  function registerDescriptor(pathname) {
    descriptorPaths.push(pathname);
  }

  async function readRegisteredDescriptors(attempt) {
    const descriptors = [];
    for (const pathname of descriptorPaths) {
      const descriptor = await attempt(() => {
        if (!existsSync(pathname)) return null;
        const raw = JSON.parse(readFileSync(pathname, "utf8"));
        return exactDescriptor(raw, {
          channel: raw.channel,
          worktreeRoot: raw.worktreeRoot,
        });
      });
      if (descriptor) descriptors.push(descriptor);
    }
    return descriptors;
  }

  function uniqueIdentities(identities) {
    const unique = [];
    for (const identity of identities) {
      const existingIndex = unique.findIndex((candidate) =>
        samePhysicalProcess(candidate, identity)
      );
      if (existingIndex >= 0) {
        if (identity.processGroup) unique[existingIndex] = identity;
        continue;
      }
      unique.push(identity);
    }
    return unique;
  }

  async function retireControllers(descriptors, attempt) {
    const controllers = uniqueIdentities(
      descriptors.map(({ supervisor }) => supervisor),
    ).reverse();
    for (const controller of controllers) {
      await attempt(async () => {
        if (controller.pid === process.pid) {
          const error = new Error(
            "fixture descriptor may still be owned by the current test process",
          );
          error.code = "DEV_FIXTURE_CONTROLLER_STILL_ACTIVE";
          throw error;
        }
        await retireFixtureIdentity(controller, timeoutMs);
      });
    }
  }

  async function retireAll() {
    const errors = [];
    const retryIdentities = [];
    const attempt = async (operation) => {
      try {
        return await operation();
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    };
    try {
      for (const obligation of [...cleanupObligations].reverse()) {
        if (obligation.active) {
          await attempt(() =>
            boundedDevLaunchFixtureOutcome(
              Promise.resolve().then(() => obligation.cleanup()),
              {
                label: "dev launch fixture cleanup obligation",
                timeoutMs,
              },
            )
          );
        }
      }
      const capturedDescriptors = await readRegisteredDescriptors(attempt);
      await retireControllers(capturedDescriptors, attempt);
      const finalDescriptors = await readRegisteredDescriptors(attempt);
      await retireControllers(finalDescriptors, attempt);
      const identities = [];
      for (const record of records) {
        const identity = await attempt(() => {
          if (record.identity) return record.identity;
          if (!record.processIdentity) {
            if (
              record.spawnFailed &&
              (!Number.isSafeInteger(record.pid) || record.pid <= 0)
            ) {
              return null;
            }
            const error = new Error(
              "fixture spawn with an assigned pid has no exact process identity",
            );
            error.code = "DEV_FIXTURE_PROCESS_IDENTITY_UNAVAILABLE";
            error.fixtureProcessExited = record.exited;
            throw error;
          }
          return { pid: record.pid, processIdentity: record.processIdentity };
        });
        if (identity) identities.push(identity);
      }
      for (const descriptor of [...capturedDescriptors, ...finalDescriptors]) {
        if (descriptor.supervisor.pid !== process.pid) {
          retryIdentities.push(descriptor.supervisor);
        }
        const owned = await attempt(() =>
          descriptorOwnedLaunchIdentities(descriptor)
        );
        if (owned) {
          retryIdentities.push(...owned);
          identities.push(...owned);
        }
      }
      retryIdentities.push(...identities);
      const unique = uniqueIdentities(identities);
      const typed = unique.filter((identity) => identity.processGroup).reverse();
      const exact = unique.filter((identity) => !identity.processGroup).reverse();
      for (const identity of [...typed, ...exact]) {
        await attempt(() => retireFixtureIdentity(identity, timeoutMs));
      }
    } finally {
      if (errors.length === 0) {
        cleanupObligations.length = 0;
        records.length = 0;
        descriptorPaths.length = 0;
      } else {
        for (const identity of uniqueIdentities(retryIdentities)) {
          const record = records.find((candidate) => {
            const existing = candidate.identity ?? (
              candidate.processIdentity
                ? {
                  pid: candidate.pid,
                  processIdentity: candidate.processIdentity,
                }
                : null
            );
            return existing && samePhysicalProcess(existing, identity);
          });
          if (!record) records.push({ identity });
          else if (identity.processGroup) record.identity = identity;
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "fixture cleanup was incomplete");
    }
  }

  const retireIdentity = (identity) =>
    retireFixtureIdentity(identity, timeoutMs);

  return {
    registerCleanup,
    registerDescriptor,
    registerIdentity,
    registerSpawn,
    retireAll,
    retireIdentity,
  };
}

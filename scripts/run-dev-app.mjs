#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDevTauriConfig,
  canonicalAppChannelEnvironment,
  devWebviewEnvironment,
  devHmuxEnvironment,
  DEV_SERVER_HOST_ENV,
  DEV_SERVER_PORT_ENV,
  DEV_INSTANCE_ENV,
  mergeTauriConfigs,
  platformTauriConfigFile,
  appControlDirectory,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import {
  persistDevServerProfile,
  selectDevServerProfile,
} from "./lib/dev-server-profile.mjs";
import { assertHeadroom } from "./lib/build-storage-admission.mjs";
import { exposeBuildStorageReservation } from "./lib/build-storage-reservation.mjs";
import { buildStorageBudget } from "./lib/disk-space.mjs";
import {
  assertDevParentNodeRuntime,
  devParentSourceGeneration,
} from "./lib/dev-launch-impact.mjs";
import {
  DEV_LAUNCH_PARENT_HANDOFF_ENV,
  parseDevLaunchHmuxProviderIdentity,
  parseDevLaunchParentHandoff,
} from "./lib/dev-launch-contract.mjs";
import {
  delay,
  observeDevLaunchParentGeneration,
} from "./lib/dev-launch-client.mjs";
import { devLaunchPrerequisites } from "./lib/dev-launch-prerequisites.mjs";
import { canReuseDevFrontend, probeDevFrontend } from "./lib/dev-frontend-authority.mjs";
import { openDevLaunchLog } from "./lib/dev-launch-storage.mjs";
import { devTauriCliInvocation } from "./lib/dev-tauri-cli.mjs";
import {
  preflightDevLaunchParentResume,
  superviseDevLaunch,
} from "./lib/dev-launch-supervisor.mjs";
import { appRootUnder } from "./lib/dure-home.mjs";

const PARENT_RELOAD_PREFLIGHT_ARGUMENT = "--parent-reload-preflight";
const INTERNAL_SUPERVISOR_ARGUMENT = "--internal-supervisor";
const DETACHED_START_TIMEOUT_MS = 30 * 60_000;
const DETACHED_START_POLL_MS = 100;
const launcherPath = fileURLToPath(import.meta.url);
const launcherSourceRoot = fileURLToPath(new URL("..", import.meta.url));

function devLaunchInvocation() {
  const worktreeRoot = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim(),
  );
  assertDevParentNodeRuntime(worktreeRoot);
  const home = process.env.HOME || homedir();
  const instance = process.env[DEV_INSTANCE_ENV];
  const identity = worktreeDevIdentity(worktreeRoot, instance);
  return {
    worktreeRoot,
    home,
    instance,
    identity,
    sourceGeneration: devParentSourceGeneration(
      worktreeRoot,
      process.platform,
      { sourceRoot: launcherSourceRoot },
    ),
  };
}

export async function launchDetachedDevApp({
  supervisorEntrypoint = launcherPath,
} = {}) {
  const { worktreeRoot, home, identity, sourceGeneration } =
    devLaunchInvocation();
  const log = openDevLaunchLog(home, identity.channel);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        supervisorEntrypoint,
        INTERNAL_SUPERVISOR_ARGUMENT,
        ...process.argv.slice(2),
      ],
      {
        cwd: worktreeRoot,
        detached: true,
        env: process.env,
        stdio: ["ignore", log.descriptor, log.descriptor],
      },
    );
    child.unref();
  } finally {
    closeSync(log.descriptor);
  }
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw new Error(`detached dev launch did not start; log: ${log.pathname}`);
  }
  let outcome;
  child.once("error", (error) => {
    outcome = { error };
  });
  child.once("exit", (code, signal) => {
    outcome = { code, signal };
  });
  const deadline = Date.now() + DETACHED_START_TIMEOUT_MS;
  let lastError;
  for (;;) {
    if (outcome) {
      const detail = outcome.error?.message ??
        (outcome.signal
          ? `signal ${outcome.signal}`
          : `exit ${outcome.code ?? 1}`);
      throw new Error(
        `detached dev launch stopped before readiness (${detail}); log: ${log.pathname}`,
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `detached dev launch did not become ready: ${lastError?.message ?? "timed out"}; log: ${log.pathname}`,
      );
    }
    try {
      const parentGeneration = await observeDevLaunchParentGeneration({
        home,
        root: worktreeRoot,
        channel: identity.channel,
        sourceGeneration,
        requireParentReloadAuthority: true,
        requireFrontendAuthority: true,
        timeoutMs: Math.min(1_000, remainingMs),
      });
      if (parentGeneration.supervisor.pid === child.pid) {
        process.stdout.write(
          `Dure is running independently of this terminal.\n  log: ${log.pathname}\n`,
        );
        return parentGeneration;
      }
      lastError = new Error(
        "another dev launch supervisor owns the channel",
      );
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(DETACHED_START_POLL_MS, remainingMs));
  }
}

function parseParentReloadPreflight(serialized) {
  if (typeof serialized !== "string" || serialized.length > 64 * 1024) {
    throw new Error("invalid parent reload preflight payload");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`invalid parent reload preflight JSON: ${error.message}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !/^[a-f0-9]{64}$/.test(value.sourceGeneration) ||
    typeof value.worktreeRoot !== "string" ||
    typeof value.channel !== "string" ||
    typeof value.controlDirectory !== "string" ||
    !value.handoff ||
    typeof value.handoff !== "object" ||
    Array.isArray(value.handoff)
  ) {
    throw new Error("invalid parent reload preflight payload");
  }
  return value;
}

export async function runDevApp({
  assertLaunchHeadroom = assertHeadroom,
} = {}) {
  const serializedParentHandoff =
    process.env[DEV_LAUNCH_PARENT_HANDOFF_ENV];
  delete process.env[DEV_LAUNCH_PARENT_HANDOFF_ENV];
  const hmuxProviderIdentity =
    process.env.HMUX_SESSION_ID && process.env.HMUX_WORKSPACE_ID
      ? parseDevLaunchHmuxProviderIdentity({
          sessionId: process.env.HMUX_SESSION_ID,
          workspaceId: process.env.HMUX_WORKSPACE_ID,
        })
      : undefined;
  const printConfig = process.argv.includes("--print-config");
  let parentReloadPreflight;
  const forwarded = [];
  const inputArguments = process.argv.slice(2);
  for (let index = 0; index < inputArguments.length; index += 1) {
    const argument = inputArguments[index];
    if (argument === "--print-config") continue;
    if (argument === INTERNAL_SUPERVISOR_ARGUMENT) continue;
    if (argument === PARENT_RELOAD_PREFLIGHT_ARGUMENT) {
      if (parentReloadPreflight !== undefined) {
        throw new Error("parent reload preflight may only be specified once");
      }
      const serializedPreflight = inputArguments[(index += 1)];
      if (!serializedPreflight) {
        throw new Error("parent reload preflight requires a source generation");
      }
      parentReloadPreflight = parseParentReloadPreflight(serializedPreflight);
      continue;
    }
    forwarded.push(argument);
  }
  const separator = forwarded.indexOf("--");
  const cliArguments =
    separator === -1 ? forwarded : forwarded.slice(0, separator);
  const runnerArguments =
    separator === -1 ? [] : forwarded.slice(separator);

  const {
    worktreeRoot,
    home: devHome,
    identity,
    instance,
    sourceGeneration,
  } = devLaunchInvocation();
  // Tauri는 `tauri.<platform>.conf.json`을 자동으로 얹지만, 우리가 넘기는
  // 인라인 `--config`가 그보다 뒤에 적용된다. 그래서 그 우선순위를 여기서 먼저
  // 재현해 두지 않으면 우리가 내보내는 `app.windows`가 플랫폼 창 설정을
  // 통째로 갈아치운다(2026-07-30 dev 앱만 네이티브 창처럼 안 보인 원인).
  const configDirectory = join(worktreeRoot, "src-tauri");
  const platformConfigFile = platformTauriConfigFile();
  const platformConfigPath = platformConfigFile
    ? join(configDirectory, platformConfigFile)
    : null;
  const baseConfig = mergeTauriConfigs(
    JSON.parse(readFileSync(join(configDirectory, "tauri.conf.json"), "utf8")),
    platformConfigPath && existsSync(platformConfigPath)
      ? JSON.parse(readFileSync(platformConfigPath, "utf8"))
      : undefined,
  );
  const parentHandoff = parseDevLaunchParentHandoff(
    serializedParentHandoff,
    { channel: identity.channel, worktreeRoot },
  );
  const devServer = selectDevServerProfile({
    home: devHome,
    channel: identity.channel,
    worktreeRoot,
    portOverride: process.env[DEV_SERVER_PORT_ENV],
    hostOverride: process.env[DEV_SERVER_HOST_ENV],
  });
  const plan = {
    ...buildDevTauriConfig({
      worktreeRoot,
      vitePort: devServer.port,
      viteHost: devServer.host,
      baseConfig,
      instance,
    }),
    devServer,
  };
  const toolEnvironment = devHmuxEnvironment(
    devHome,
    plan.identity.channel,
    process.env.PATH,
  );
  const productEnvironment = {
    ...process.env,
    ...toolEnvironment,
    ...devWebviewEnvironment(plan.webviewStore),
  };
  const configuredDureHome = productEnvironment.DURE_HOME;
  const portableAppHome =
    typeof configuredDureHome === "string" &&
    configuredDureHome.length > 0 &&
    resolve(configuredDureHome) !== resolve(appRootUnder(devHome));
  // The pane hosting app:dev is process supervision, never product catalog
  // authority. Ordinary dev channels share HOME/.dure even when that canonical
  // path is repeated in DURE_HOME. A genuinely portable/QA DURE_HOME remains
  // the explicit isolation boundary and may carry its paired Hmux root.
  if (!portableAppHome) delete productEnvironment.HMUX_DISCOVERY_ROOT;
  const macosDevBundle = {
    enabled: process.platform === "darwin",
    key: plan.identity.channel,
    identifier: plan.identity.identifier,
  };

  if (printConfig) {
    process.stdout.write(
      `${JSON.stringify({ ...plan, macosDevBundle }, null, 2)}\n`,
    );
    return;
  }

  const childEnvironment = canonicalAppChannelEnvironment(
    plan.identity.channel,
    {
      ...productEnvironment,
      ...(macosDevBundle.enabled
        ? {
            DURE_MACOS_DEV_BUNDLE: "1",
            DURE_MACOS_DEV_BUNDLE_KEY: macosDevBundle.key,
          }
        : {}),
    },
    { includeVite: true },
  );
  delete childEnvironment.HEBBIAN_DEV_PORT;

  const launchPrerequisites = devLaunchPrerequisites({
    worktreeRoot,
    childEnvironment,
    devServer,
  });
  let storageReservation;
  let restoreStorageEnvironment = () => {};
  const admitLaunchHeadroom = () => {
    if (storageReservation) return storageReservation;
    const headroom = assertLaunchHeadroom({
      cwd: worktreeRoot,
      label: "app:dev",
      log: (message) => process.stderr.write(`${message}\n`),
      requestedBytes: buildStorageBudget("dev"),
    });
    storageReservation = headroom.reservation;
    if (storageReservation) {
      exposeBuildStorageReservation(storageReservation, childEnvironment);
      restoreStorageEnvironment = exposeBuildStorageReservation(
        storageReservation,
      );
      process.once("exit", storageReservation.release);
    }
    return storageReservation;
  };

  if (parentReloadPreflight !== undefined) {
    if (
      sourceGeneration !== parentReloadPreflight.sourceGeneration ||
      worktreeRoot !== parentReloadPreflight.worktreeRoot ||
      plan.identity.channel !== parentReloadPreflight.channel ||
      appControlDirectory(devHome, plan.identity.channel) !==
        parentReloadPreflight.controlDirectory
    ) {
      throw new Error(
        "parent reload preflight changed the loaded source or launch identity",
      );
    }
    const proposal = await preflightDevLaunchParentResume({
      home: devHome,
      worktreeRoot,
      channel: plan.identity.channel,
      sourceGeneration,
      handoff: parentReloadPreflight.handoff,
    });
    admitLaunchHeadroom();
    execFileSync(
      process.execPath,
      [join(worktreeRoot, "scripts/run-dev-launch-child.mjs"), "--check"],
      {
        cwd: worktreeRoot,
        env: childEnvironment,
        stdio: "inherit",
      },
    );
    for (const prerequisite of launchPrerequisites) {
      execFileSync(prerequisite.command, prerequisite.args, {
        ...prerequisite.spawnOptions,
      });
    }
    if (
      proposal.previousFrontend &&
      !(await probeDevFrontend(
        { origin: devServer.origin, channel: plan.identity.channel },
        proposal.previousFrontend,
      ))
    ) {
      throw new Error(
        "target parent could not prove the exact active frontend generation",
      );
    }
    return;
  }

  const tauriLaunch = devTauriCliInvocation([
    "dev",
    ...cliArguments,
    "--config",
    JSON.stringify(plan.config),
    ...runnerArguments,
  ]);
  const outcome = await superviseDevLaunch({
    home: devHome,
    worktreeRoot,
    channel: plan.identity.channel,
    command: tauriLaunch.command,
    args: tauriLaunch.args,
    spawnOptions: {
      cwd: worktreeRoot,
      env: childEnvironment,
      stdio: "inherit",
    },
    frontend: {
      command: process.execPath,
      args: [
        join(worktreeRoot, "scripts/run-dev-frontend.mjs"),
        "--host",
        devServer.host,
        "--port",
        String(devServer.port),
      ],
      spawnOptions: {
        cwd: worktreeRoot,
        env: childEnvironment,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
      probe: (identity) =>
        probeDevFrontend(
          { origin: devServer.origin, channel: plan.identity.channel },
          identity,
        ),
      canReuse: (identity) => canReuseDevFrontend(
        { origin: devServer.origin, channel: plan.identity.channel, worktreeRoot },
        identity,
      ),
    },
    prepareInitialLaunch: async () => {
      // A source-reload successor keeps the same PID/process generation and
      // inherited capability, so this adopts the existing lease instead of
      // double booking it and restores its exit cleanup after exec.
      admitLaunchHeadroom();

      persistDevServerProfile({
        home: devHome,
        channel: plan.identity.channel,
        worktreeRoot,
        devServer,
      });

      process.stdout.write(
        `Starting ${plan.identity.productName}\n` +
          `  channel: ${plan.identity.channel}\n` +
          `  Vite:    ${devServer.origin} (${devServer.source})\n`,
      );
    },
    prepareLaunch: parentHandoff ? undefined : launchPrerequisites,
    sourceGeneration,
    hmuxProviderIdentity,
    parentHandoff,
    preflightParent: (targetSourceGeneration, proposedHandoff) => {
      const preflight = {
        sourceGeneration: targetSourceGeneration,
        worktreeRoot,
        channel: plan.identity.channel,
        controlDirectory: appControlDirectory(
          devHome,
          plan.identity.channel,
        ),
        handoff: proposedHandoff,
      };
      return {
        command: process.execPath,
        args: [
          ...process.execArgv,
          process.argv[1],
          ...process.argv.slice(2),
          PARENT_RELOAD_PREFLIGHT_ARGUMENT,
          JSON.stringify(preflight),
        ],
        spawnOptions: {
          cwd: worktreeRoot,
          env: process.env,
          stdio: "inherit",
        },
        timeoutMs: 30 * 60_000,
      };
    },
    reloadParent:
      typeof process.execve === "function"
        ? (handoff) => {
            const environment = {
              ...process.env,
              [DEV_LAUNCH_PARENT_HANDOFF_ENV]: JSON.stringify(handoff),
            };
            process.execve(
              process.execPath,
              [
                process.execPath,
                ...process.execArgv,
                process.argv[1],
                ...process.argv.slice(2),
              ],
              environment,
            );
          }
        : undefined,
  }).finally(() => {
    restoreStorageEnvironment();
    storageReservation?.release();
  });
  if (outcome.error) {
    process.stderr.write(
      `Could not stop the development app safely: ${outcome.error.message}\n`,
    );
  }
  if (outcome.signal) {
    process.stderr.write(`Development app exited from signal ${outcome.signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = outcome.code ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const foreground =
    process.argv.includes(INTERNAL_SUPERVISOR_ARGUMENT) ||
    process.argv.includes("--print-config") ||
    process.argv.includes(PARENT_RELOAD_PREFLIGHT_ARGUMENT);
  (foreground ? runDevApp() : launchDetachedDevApp()).catch((error) => {
    process.stderr.write(`app:dev: ${error.message}\n`);
    process.exitCode = 1;
  });
}

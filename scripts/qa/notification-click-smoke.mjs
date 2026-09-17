#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveAppChannel,
  validateAppChannel,
} from "../lib/app-channel.mjs";
import { exposeBuildStorageReservation } from "../lib/build-storage-reservation.mjs";
import { ensureHeadroom } from "../lib/build-storage-admission.mjs";
import { appRootUnder } from "../lib/dure-home.mjs";
import { buildStorageBudget } from "../lib/disk-space.mjs";

export const QA_BUNDLE_IDENTIFIER = "dev.dureai.qa.notification-click";
export const QA_PRODUCT_NAME = "Dure Notification Click QA";
export const QA_JOURNAL_FILE = "notification-click-qa-v1.json";
export const QA_CONTROLLER_WINDOW_LABEL = "win-notification-click-controller";
export const QA_TARGET_WINDOW_LABEL = "win-notification-click-target";
export const QA_ISOLATION_ROOT_ENV = "DURE_NOTIFICATION_CLICK_QA_ROOT";
const QA_ISOLATION_PREFIX = "dure-notification-click-qa-";
export const QA_BUILD_ENV = Object.freeze({
  VITE_DURE_NOTIFICATION_CLICK_QA: "1",
});

export function qaBuildEnvironment(reservation, environment = process.env) {
  const childEnvironment = { ...environment, ...QA_BUILD_ENV };
  exposeBuildStorageReservation(reservation, childEnvironment);
  return childEnvironment;
}

export const QA_SCENARIOS = [
  "cold-start",
  "minimized",
  "multi-window",
  "owner-change",
];

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(scriptPath, "../../.."));

const scrubbedQaEnvironmentKeys = [
  "HEBBIAN_APP_CHANNEL",
  "VITE_HEBBIAN_APP_CHANNEL",
  "HEBBIAN_DEV_HOST",
  "DURE_DEV_PORT",
  "HEBBIAN_DEV_PORT",
  "HEBBIAN_SESSION",
  "HEBBIAN_AGENT",
  "HMUX_SESSION_ID",
  "HEBBIAN_IDE_WINDOW",
  "HEBBIAN_IDE_PANEL",
];

function qaIsolationPaths(root, channel) {
  return Object.freeze({
    root,
    channel,
    home: join(root, "home"),
    dureHome: join(root, "dure-home"),
    discoveryRoot: join(root, "hmux-discovery"),
    hebbianHome: join(root, "hebbian-home"),
    cliInstallRoot: join(root, "dure-cli", "install"),
    cliInstallDir: join(root, "dure-cli", "bin"),
    infoPlist: join(root, "Info.plist"),
  });
}

function isPathBelow(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export function prepareQaIsolation(root, channel) {
  if (!/^[a-z0-9-]{1,64}$/u.test(channel) || !channel.startsWith("qa-notification-click-")) {
    throw new Error("QA app channel is not a bounded notification-click identity");
  }
  const temporaryRoot = realpathSync(tmpdir());
  const requestedRoot = resolve(root);
  if (
    dirname(requestedRoot) !== temporaryRoot ||
    !basename(requestedRoot).startsWith(QA_ISOLATION_PREFIX)
  ) {
    throw new Error("QA isolation root must be an explicit notification-click temp root");
  }
  if (existsSync(requestedRoot)) {
    const metadata = lstatSync(requestedRoot);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("QA isolation root is not an owner-only real directory");
    }
  } else {
    mkdirSync(requestedRoot, { recursive: false, mode: 0o700 });
  }
  const resolvedRoot = realpathSync(requestedRoot);
  if (dirname(resolvedRoot) !== temporaryRoot) {
    throw new Error("QA isolation root escaped the system temp directory");
  }
  const isolation = qaIsolationPaths(resolvedRoot, channel);
  for (const path of [
    isolation.home,
    isolation.dureHome,
    isolation.discoveryRoot,
    isolation.hebbianHome,
    isolation.cliInstallRoot,
    isolation.cliInstallDir,
  ]) {
    if (!isPathBelow(resolvedRoot, path)) {
      throw new Error(`QA isolation path escaped its root: ${path}`);
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(path);
    const resolvedPath = realpathSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      resolvedPath !== resolve(path) ||
      !isPathBelow(resolvedRoot, resolvedPath)
    ) {
      throw new Error(`QA isolation path is not an owner-only real directory: ${path}`);
    }
  }
  return isolation;
}

function isolationEnvironmentEntries(isolation) {
  return {
    [QA_ISOLATION_ROOT_ENV]: isolation.root,
    HOME: isolation.home,
    USERPROFILE: isolation.home,
    DURE_HOME: isolation.dureHome,
    DURE_APP_CHANNEL: isolation.channel,
    VITE_DURE_APP_CHANNEL: isolation.channel,
    HMUX_DISCOVERY_ROOT: isolation.discoveryRoot,
    HEBBIAN_HOME: isolation.hebbianHome,
    DURE_CLI_INSTALL_ROOT: isolation.cliInstallRoot,
    DURE_CLI_INSTALL_DIR: isolation.cliInstallDir,
  };
}

export function qaAppEnvironment(isolation, environment = process.env) {
  const result = { ...environment, ...isolationEnvironmentEntries(isolation) };
  for (const key of scrubbedQaEnvironmentKeys) delete result[key];
  return result;
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function writeQaInfoPlist(isolation) {
  const entries = Object.entries(isolationEnvironmentEntries(isolation))
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  writeFileSync(
    isolation.infoPlist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>LSEnvironment</key>
  <dict>
${entries}
  </dict>
</dict>
</plist>
`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function createQaIsolation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), QA_ISOLATION_PREFIX)));
  const channel = `qa-notification-click-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const isolation = prepareQaIsolation(root, channel);
  writeQaInfoPlist(isolation);
  return isolation;
}

function help() {
  return `Signed Dure notification click QA

Builds or validates a dedicated signed QA .app, dispatches a real macOS
notification, and waits for you to click it. Production Dure notification
permissions and receipts are never read or changed.

Usage:
  pnpm test:notification-click [options]

Options:
  --app <path>           Reuse an existing QA .app instead of building.
  --authorize            Explicitly request notification permission for the
                         dedicated ${QA_BUNDLE_IDENTIFIER} identity.
  --scenario <name>      cold-start, minimized, multi-window, owner-change,
                         or all (default).
  --timeout <seconds>    Per-click timeout (default: 180).
  --require-execution    Treat unavailable permission as a failure, not a skip.
  --help                 Show this help.

The click is intentionally human-driven. This avoids Accessibility automation
that could select another notification or mutate unrelated macOS UI state.
`;
}

export function parseArguments(arguments_) {
  const options = {
    app: undefined,
    authorize: false,
    scenario: "all",
    timeoutMs: 180_000,
    requireExecution: false,
    help: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--authorize") options.authorize = true;
    else if (argument === "--require-execution") options.requireExecution = true;
    else if (argument === "--app") options.app = arguments_[++index];
    else if (argument === "--scenario") options.scenario = arguments_[++index];
    else if (argument === "--timeout") {
      const seconds = Number(arguments_[++index]);
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) {
        throw new Error("--timeout must be an integer between 10 and 900 seconds");
      }
      options.timeoutMs = seconds * 1_000;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (options.app === undefined && arguments_.includes("--app")) {
    throw new Error("--app requires a path");
  }
  if (!["all", ...QA_SCENARIOS].includes(options.scenario)) {
    throw new Error(`unsupported scenario: ${options.scenario}`);
  }
  return options;
}

export function buildQaTauriConfig(infoPlist = "/tmp/dure-notification-click-qa/Info.plist") {
  return {
    productName: QA_PRODUCT_NAME,
    identifier: QA_BUNDLE_IDENTIFIER,
    build: {
      frontendDist: "../dist",
    },
    app: {
      windows: [
        {
          label: QA_CONTROLLER_WINDOW_LABEL,
          title: QA_PRODUCT_NAME,
          url: "index.html?qaNotificationClick=1",
          width: 760,
          height: 520,
          minWidth: 640,
          minHeight: 420,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          dragDropEnabled: false,
          backgroundThrottling: "disabled",
          visible: true,
        },
        {
          label: QA_TARGET_WINDOW_LABEL,
          title: `${QA_PRODUCT_NAME} — target`,
          url: "index.html?qaNotificationClick=1&qaNotificationClickRole=target",
          width: 760,
          height: 520,
          minWidth: 640,
          minHeight: 420,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          dragDropEnabled: false,
          backgroundThrottling: "disabled",
          visible: true,
          focus: false,
        },
      ],
    },
    bundle: {
      targets: ["app"],
      createUpdaterArtifacts: false,
      macOS: { infoPlist },
    },
  };
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(`${command} exited with ${result.status}${detail}`);
  }
  return options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

function signingIdentity() {
  if (process.env.DURE_NOTIFICATION_QA_SIGNING_IDENTITY) {
    return process.env.DURE_NOTIFICATION_QA_SIGNING_IDENTITY;
  }
  const output = run(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { capture: true },
  );
  const identities = [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+/gmu)].map(
    (match) => match[1],
  );
  if (identities.length !== 1) {
    throw new Error(
      `signed-app-unavailable: expected exactly one code-signing identity, found ${identities.length}`,
    );
  }
  return identities[0];
}

function findBundle(directory, depth = 0) {
  if (!existsSync(directory) || depth > 5) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory() && entry.name === `${QA_PRODUCT_NAME}.app`) return candidate;
    if (entry.isDirectory()) {
      const nested = findBundle(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function buildApp(identity, isolation) {
  const headroom = ensureHeadroom({
    cwd: repositoryRoot,
    label: "notification-click signed QA build",
    log: (message) => process.stderr.write(`${message}\n`),
    requestedBytes: buildStorageBudget("qa"),
  });
  if (!headroom.ok) throw new Error(headroom.message);
  try {
    run(
      "pnpm",
      [
        "tauri",
        "build",
        "--bundles",
        "app",
        "--config",
        JSON.stringify(buildQaTauriConfig(isolation.infoPlist)),
      ],
      { env: qaBuildEnvironment(headroom.reservation) },
    );
    const bundleRoot = join(
      repositoryRoot,
      "src-tauri",
      "target",
      "release",
      "bundle",
    );
    const app = findBundle(bundleRoot);
    if (!app) throw new Error(`built QA app was not found below ${bundleRoot}`);
    run("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp=none",
      "--sign",
      identity,
      app,
    ]);
    return app;
  } finally {
    headroom.reservation?.release();
  }
}

function plistValue(app, key) {
  return run(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, join(app, "Contents", "Info.plist")],
    { capture: true },
  ).trim();
}

function isolationFromApp(app) {
  const root = plistValue(app, `LSEnvironment:${QA_ISOLATION_ROOT_ENV}`);
  const channel = plistValue(app, "LSEnvironment:DURE_APP_CHANNEL");
  const isolation = prepareQaIsolation(root, channel);
  const expected = isolationEnvironmentEntries(isolation);
  for (const [key, value] of Object.entries(expected)) {
    const actual = plistValue(app, `LSEnvironment:${key}`);
    if (actual !== value) {
      throw new Error(`refusing QA bundle with unsafe LSEnvironment ${key}`);
    }
  }
  return isolation;
}

function validateApp(app, expectedIsolation) {
  const resolved = realpathSync(resolve(app));
  if (!resolved.endsWith(".app") || !statSync(resolved).isDirectory()) {
    throw new Error("--app must name an existing .app directory");
  }
  if (plistValue(resolved, "CFBundleIdentifier") !== QA_BUNDLE_IDENTIFIER) {
    throw new Error(`refusing non-QA bundle: ${resolved}`);
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", resolved]);
  const signature = run("/usr/bin/codesign", ["-dv", "--verbose=4", resolved], {
    capture: true,
  });
  if (
    !signature.includes(`Identifier=${QA_BUNDLE_IDENTIFIER}`) ||
    /TeamIdentifier=not set/u.test(signature)
  ) {
    throw new Error("signed-app-unavailable: QA app lacks a stable team signature");
  }
  const executable = join(resolved, "Contents", "MacOS", plistValue(resolved, "CFBundleExecutable"));
  if (!existsSync(executable)) throw new Error("QA app executable is missing");
  const isolation = isolationFromApp(resolved);
  if (expectedIsolation && isolation.root !== expectedIsolation.root) {
    throw new Error("built QA bundle did not preserve its exact isolation root");
  }
  return { app: resolved, executable, isolation };
}

function journalPaths(isolation) {
  return [...new Set([isolation.home, homedir()])].map((home) =>
    join(
      home,
      "Library",
      "Application Support",
      QA_BUNDLE_IDENTIFIER,
      QA_JOURNAL_FILE,
    ),
  );
}

function readJournal(runId, isolation) {
  for (const path of journalPaths(isolation)) {
    if (!existsSync(path)) continue;
    const journal = JSON.parse(readFileSync(path, "utf8"));
    if (journal.schema === "dure.notification-click-qa.v1" && journal.runId === runId) {
      return journal;
    }
  }
  return undefined;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForJournal(runId, isolation, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const journal = readJournal(runId, isolation);
    if (journal && predicate(journal)) return journal;
    await delay(100);
  }
  throw new Error(`timed out waiting for notification click QA receipt ${runId}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(timeoutMs).then(() => undefined),
  ]);
}

function quitDedicatedQaApp() {
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", `tell application id "${QA_BUNDLE_IDENTIFIER}" to quit`],
    { encoding: "utf8", stdio: "pipe" },
  );
  return result.status === 0;
}

function dedicatedQaAppIsRunning() {
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", `return application id "${QA_BUNDLE_IDENTIFIER}" is running`],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not observe the dedicated QA app: ${result.stderr?.trim() || "osascript failed"}`,
    );
  }
  const observation = result.stdout.trim();
  if (observation !== "true" && observation !== "false") {
    throw new Error(`unexpected dedicated QA app observation: ${observation}`);
  }
  return observation === "true";
}

async function waitForDedicatedQaAppExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!dedicatedQaAppIsRunning()) return true;
    await delay(100);
  }
  return !dedicatedQaAppIsRunning();
}

export function ambientLiveDescriptorPaths(environment = process.env) {
  const home = environment.HOME || homedir();
  const channel = resolveAppChannel(environment);
  const legacyChannel = environment.HEBBIAN_APP_CHANNEL
    ? validateAppChannel(environment.HEBBIAN_APP_CHANNEL)
    : undefined;
  const channels = [
    channel,
    ...(legacyChannel && legacyChannel !== channel ? [legacyChannel] : []),
  ];
  const appRoot = appRootUnder(home);
  const cliRoot = environment.DURE_HOME || appRoot;
  const descriptor = (root, selectedChannel) =>
    join(
      root,
      ...(selectedChannel === "stable" ? [] : ["channels", selectedChannel]),
      "server.json",
    );
  return [
    ...new Set(
      channels.flatMap((selectedChannel) => [
        descriptor(appRoot, selectedChannel),
        descriptor(cliRoot, selectedChannel),
      ]),
    ),
  ];
}

function snapshotLiveDescriptors() {
  return ambientLiveDescriptorPaths().map((path) => ({
    path,
    bytes: existsSync(path) ? readFileSync(path) : undefined,
  }));
}

function assertLiveDescriptorsUnchanged(snapshots) {
  for (const snapshot of snapshots) {
    const after = existsSync(snapshot.path) ? readFileSync(snapshot.path) : undefined;
    const unchanged =
      snapshot.bytes === undefined ? after === undefined : after?.equals(snapshot.bytes) === true;
    if (!unchanged) {
      throw new Error(`notification click QA mutated live descriptor: ${snapshot.path}`);
    }
  }
}

function startApp(executable, runId, scenario, authorize, isolation) {
  const arguments_ = [
    `--dure-notification-click-qa-run=${runId}`,
    `--dure-notification-click-qa-scenario=${scenario}`,
  ];
  if (authorize) arguments_.push("--dure-notification-click-qa-authorize");
  const child = spawn(executable, arguments_, {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: qaAppEnvironment(isolation),
  });
  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function runScenario(appInfo, scenario, options, authorize) {
  const runId = crypto.randomUUID().replaceAll("-", "");
  const liveDescriptors = snapshotLiveDescriptors();
  const child = startApp(
    appInfo.executable,
    runId,
    scenario,
    authorize,
    appInfo.isolation,
  );
  const terminalStages = new Set(["armed", "skipped", "failed"]);
  let journal;
  try {
    journal = await waitForJournal(
      runId,
      appInfo.isolation,
      (candidate) => terminalStages.has(candidate.stage),
      options.timeoutMs,
    );
    if (journal.stage === "skipped") {
      return { outcome: "skipped", scenario, reason: journal.reason, runId };
    }
    if (journal.stage === "failed") {
      throw new Error(journal.reason ?? "notification dispatch failed");
    }
    if (scenario === "cold-start") {
      const exitCode = await waitForChildExit(child, 5_000);
      if (exitCode === undefined) {
        throw new Error("cold-start QA app did not exit after arming the notification");
      }
    }
    process.stderr.write(
      `\n${QA_PRODUCT_NAME}: CLICK the notification for ${scenario} ` +
        `(run ${runId.slice(0, 12)}).\n`,
    );
    journal = await waitForJournal(
      runId,
      appInfo.isolation,
      (candidate) => candidate.stage === "completed" || candidate.stage === "failed",
      options.timeoutMs,
    );
    if (journal.stage !== "completed") {
      throw new Error(journal.reason ?? "notification click verification failed");
    }
    return {
      outcome: "passed",
      scenario,
      runId,
      freshProcess: journal.freshProcess,
      initialProcessId: journal.initialProcessId,
      activatedProcessId: journal.activatedProcessId,
      expectedTarget: journal.expectedTarget,
      observation: journal.observation,
    };
  } finally {
    await waitForChildExit(child, 2_000);
    if (dedicatedQaAppIsRunning() && !quitDedicatedQaApp()) {
      throw new Error(
        `${QA_PRODUCT_NAME}: dedicated QA app did not acknowledge an exact bundle quit`,
      );
    }
    if (!(await waitForDedicatedQaAppExit(5_000))) {
      throw new Error(
        `${QA_PRODUCT_NAME}: dedicated QA app remained alive after exact bundle cleanup`,
      );
    }
    assertLiveDescriptorsUnchanged(liveDescriptors);
  }
}

function cleanupQaIsolation(isolation) {
  const checked = prepareQaIsolation(isolation.root, isolation.channel);
  if (checked.root !== isolation.root || dedicatedQaAppIsRunning()) {
    throw new Error("refusing to clean an active or changed QA isolation root");
  }
  rmSync(checked.root, { recursive: true, force: false });
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("signed Dure notification click QA requires macOS");
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  let ownedIsolation;
  let appInfo;
  try {
    if (options.app) {
      appInfo = validateApp(resolve(options.app));
    } else {
      const identity = signingIdentity();
      ownedIsolation = createQaIsolation();
      appInfo = validateApp(
        buildApp(identity, ownedIsolation),
        ownedIsolation,
      );
    }
    run(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appInfo.app],
    );
    const scenarios = options.scenario === "all" ? QA_SCENARIOS : [options.scenario];
    const receipts = [];
    for (const [index, scenario] of scenarios.entries()) {
      const receipt = await runScenario(
        appInfo,
        scenario,
        options,
        options.authorize && index === 0,
      );
      receipts.push(receipt);
      if (receipt.outcome === "skipped") break;
    }
    const outcome = receipts.some((receipt) => receipt.outcome === "skipped")
      ? "skipped"
      : "passed";
    process.stdout.write(
      `${JSON.stringify({ outcome, app: basename(appInfo.app), receipts }, null, 2)}\n`,
    );
    if (outcome === "skipped" && options.requireExecution) process.exitCode = 2;
  } finally {
    const isolation = appInfo?.isolation ?? ownedIsolation;
    if (isolation && !dedicatedQaAppIsRunning()) cleanupQaIsolation(isolation);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

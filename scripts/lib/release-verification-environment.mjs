import fs from "node:fs";
import path from "node:path";

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;
const TARGET_GENERATION = /^[0-9a-f]{16}$/;
const ROOT_MARKER = ".dure-release-verification-owner";
const SHORT_TEMP_PREFIX = "dure-rv-";
const SHORT_TEMP_DIRECTORY = "tmp";

const ISOLATED_DIRECTORIES = Object.freeze({
  HOME: "home",
  DURE_HOME: "dure-home",
  HMUX_DISCOVERY_ROOT: "hmux-discovery",
  XDG_RUNTIME_DIR: "runtime/xdg",
  DURE_GHOSTTY_VT_CACHE_ROOT: "cache/ghostty-vt",
  NODE_COMPILE_CACHE: "cache/node-compile",
  COREPACK_HOME: "cache/corepack",
  npm_config_cache: "cache/npm",
  npm_config_store_dir: "cache/pnpm-store",
  PNPM_HOME: "install/pnpm/bin",
  npm_config_prefix: "install/pnpm",
  CARGO_INSTALL_ROOT: "install/cargo",
  XDG_CACHE_HOME: "cache/xdg",
  XDG_CONFIG_HOME: "config/xdg",
  XDG_DATA_HOME: "data/xdg",
  XDG_STATE_HOME: "state/xdg",
  HMUX_INSTALL_ROOT: "install/hmux",
  HMUX_INSTALL_DIR: "install/hmux/bin",
  DURE_CLI_INSTALL_ROOT: "install/dure-cli",
  DURE_CLI_INSTALL_DIR: "install/dure-cli/bin",
  HMUX_STAGE_ARTIFACT_DIR: "stage/hmux",
  CODEX_HOME: "provider/codex",
  CODEX_SQLITE_HOME: "provider/codex-sqlite",
  CLAUDE_CONFIG_DIR: "provider/claude",
  ANTHROPIC_CONFIG_DIR: "provider/claude",
  KIMI_CODE_HOME: "provider/kimi",
  GEMINI_CLI_HOME: "provider/gemini",
  PI_CODING_AGENT_DIR: "provider/pi-agent",
  PI_CODING_AGENT_SESSION_DIR: "provider/pi-agent/sessions",
  GROK_HOME: "provider/grok",
  ZIG_GLOBAL_CACHE_DIR: "cache/zig-global",
  ZIG_LOCAL_CACHE_DIR: "cache/zig-local",
});

const ISOLATED_FILES = Object.freeze({
  HMUX_RUNTIME_LOG: "runtime/log/hmux-runtime.log",
  OPENCODE_DB: "provider/opencode/opencode.db",
});

const SCRUBBED_VARIABLES = Object.freeze([
  "CARGO_BUILD_TARGET",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_ENCODED_RUSTFLAGS",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "DURE_APP_CHANNEL",
  "DURE_BACKEND_RUNTIME_FINGERPRINT",
  "DURE_BUILD_ID",
  "DURE_CLAUDE_PROCESS_RELAY_BIN",
  "DURE_CONTROL_PLANE_BIN",
  "DURE_DEV_LAUNCH_GENERATION",
  "DURE_DEV_LIVE_WORKTREE",
  "DURE_DEV_PORT",
  "DURE_HMUX_BIN",
  "DURE_HMUX_RUNTIME_BIN",
  "HEBBIAN_APP_CHANNEL",
  "HEBBIAN_DAILY_APP_PATH",
  "HEBBIAN_DEV_HOST",
  "HEBBIAN_DEV_INSTANCE",
  "HEBBIAN_DEV_PORT",
  "HEBBIAN_DEV_WORKTREE",
  "HEBBIAN_HOME",
  "HEBBIAN_HMUX_BIN",
  "HEBBIAN_IDE_CLI_BUILD_ID",
  "HEBBIAN_IDE_CLI_INSTALL_DIR",
  "HEBBIAN_IDE_CLI_INSTALL_ROOT",
  "HEBBIAN_IDE_CLI_LOCK_WAIT_MS",
  "HMUX",
  "HMUX_ARTIFACT_DIR",
  "HMUX_BIN",
  "HMUX_CHANNEL_EPOCH",
  "HMUX_CLI_BIN",
  "HMUX_HOST_INSTANCE_ID",
  "HMUX_RUNNER_INSTANCE",
  "HMUX_RUNNER_PRINCIPAL",
  "HMUX_RUNTIME_BIN",
  "HMUX_SESSION_ID",
  "HMUX_SESSION_NAME",
  "HMUX_TERMINAL_EPOCH",
  "HMUX_WORKSPACE_ID",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTFLAGS",
  "TAURI_ANDROID_PACKAGE_NAME_APP_NAME",
  "TAURI_ANDROID_PACKAGE_NAME_PREFIX",
  "TAURI_CLI_VERBOSITY",
  "TAURI_CONFIG",
  "TAURI_ENV_TARGET_TRIPLE",
  "TAURI_UPDATER_PLUGIN_CONFIG",
  "VITE_DURE_APP_CHANNEL",
  "VITE_HEBBIAN_APP_CHANNEL",
  "VITEST_MAX_WORKERS",
]);

function fail(message) {
  throw new Error(`release verification isolation: ${message}`);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is required`);
  }
  return value;
}

function safeToken(environment, name, numeric = false) {
  const value = required(environment, name);
  const valid = numeric ? /^\d+$/.test(value) : SAFE_TOKEN.test(value);
  if (!valid) fail(`${name} must be one safe token`);
  return value;
}

function realDirectory(directory, label) {
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) {
    fail(`${label} must be an absolute non-root directory`);
  }
  let metadata;
  try {
    metadata = fs.lstatSync(directory);
  } catch {
    fail(`${label} does not exist`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory`);
  }
  return fs.realpathSync(directory);
}

function exactRegularFile(file, expected, label) {
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch {
    fail(`${label} is missing`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular file`);
  }
  if (fs.readFileSync(file, "utf8") !== expected) {
    fail(`${label} does not match this workflow run`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`isolated path is not a real directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function currentUserId() {
  if (typeof process.getuid !== "function") {
    fail("private release temp ownership cannot be verified on this platform");
  }
  return process.getuid();
}

function privateDirectoryIdentity(directory, label, expected) {
  const canonical = realDirectory(directory, label);
  if (canonical !== directory) {
    fail(`${label} must use its canonical path`);
  }
  const metadata = fs.lstatSync(directory);
  if (metadata.uid !== currentUserId() || (metadata.mode & 0o777) !== 0o700) {
    fail(`${label} must be owned by this user with mode 0700`);
  }
  if (
    expected &&
    (metadata.dev !== expected.device || metadata.ino !== expected.inode)
  ) {
    fail(`${label} identity changed`);
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function ownerMarkerIdentity(file, expectedContents, label, expected) {
  exactRegularFile(file, expectedContents, label);
  const metadata = fs.lstatSync(file);
  if (metadata.uid !== currentUserId() || (metadata.mode & 0o777) !== 0o600) {
    fail(`${label} must be owned by this user with mode 0600`);
  }
  if (fs.realpathSync(file) !== file) {
    fail(`${label} must use its canonical path`);
  }
  if (
    expected &&
    (metadata.dev !== expected.device || metadata.ino !== expected.inode)
  ) {
    fail(`${label} identity changed`);
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function validateShortTempState(state, markerContents) {
  if (
    path.dirname(state.root) !== state.systemTempRoot ||
    !path.basename(state.root).startsWith(SHORT_TEMP_PREFIX)
  ) {
    fail("short release temp escaped the canonical system temp root");
  }
  const rootIdentity = privateDirectoryIdentity(
    state.root,
    "short release temp root",
    state.rootIdentity,
  );
  if (
    rootIdentity.device !== state.runnerDevice ||
    rootIdentity.device !== state.systemTempDevice
  ) {
    fail("short release temp must share the runner temp device");
  }
  ownerMarkerIdentity(
    path.join(state.root, ROOT_MARKER),
    markerContents,
    "short release temp ownership marker",
    state.markerIdentity,
  );
  if (path.dirname(state.directory) !== state.root) {
    fail("short release temp directory escaped its owned root");
  }
  const directoryIdentity = privateDirectoryIdentity(
    state.directory,
    "short release temp directory",
    state.directoryIdentity,
  );
  if (directoryIdentity.device !== rootIdentity.device) {
    fail("short release temp directory crossed devices");
  }
}

function removeJustCreatedShortTemp(root, systemTempRoot, markerContents) {
  if (!root) return;
  if (
    path.dirname(root) !== systemTempRoot ||
    !path.basename(root).startsWith(SHORT_TEMP_PREFIX)
  ) {
    fail("refusing to clean an unexpected short release temp root");
  }
  privateDirectoryIdentity(root, "short release temp root");
  const entries = fs.readdirSync(root).sort();
  for (const entry of entries) {
    if (entry === ROOT_MARKER) {
      ownerMarkerIdentity(
        path.join(root, entry),
        markerContents,
        "short release temp ownership marker",
      );
      fs.unlinkSync(path.join(root, entry));
      continue;
    }
    if (entry === SHORT_TEMP_DIRECTORY) {
      const directory = path.join(root, entry);
      privateDirectoryIdentity(directory, "short release temp directory");
      if (fs.readdirSync(directory).length !== 0) {
        fail("refusing to clean a populated incomplete short release temp");
      }
      fs.rmdirSync(directory);
      continue;
    }
    fail("refusing to clean unexpected short release temp contents");
  }
  fs.rmdirSync(root);
}

function prepareShortTemp(runnerTemp, markerContents) {
  if (process.platform === "win32") return undefined;
  let systemTempRoot;
  try {
    systemTempRoot = fs.realpathSync("/tmp");
  } catch {
    fail("canonical system temp root is unavailable");
  }
  systemTempRoot = realDirectory(systemTempRoot, "canonical system temp root");
  const runnerDevice = fs.lstatSync(runnerTemp).dev;
  const systemTempDevice = fs.lstatSync(systemTempRoot).dev;
  if (runnerDevice !== systemTempDevice) {
    fail("canonical system temp and runner temp must share a device");
  }

  let root;
  try {
    root = fs.mkdtempSync(path.join(systemTempRoot, SHORT_TEMP_PREFIX));
    fs.chmodSync(root, 0o700);
    const rootIdentity = privateDirectoryIdentity(
      root,
      "short release temp root",
    );
    const marker = path.join(root, ROOT_MARKER);
    fs.writeFileSync(marker, markerContents, { flag: "wx", mode: 0o600 });
    fs.chmodSync(marker, 0o600);
    const markerIdentity = ownerMarkerIdentity(
      marker,
      markerContents,
      "short release temp ownership marker",
    );
    const directory = path.join(root, SHORT_TEMP_DIRECTORY);
    ensurePrivateDirectory(directory);
    const directoryIdentity = privateDirectoryIdentity(
      directory,
      "short release temp directory",
    );
    const state = {
      directory,
      directoryIdentity,
      markerIdentity,
      root,
      rootIdentity,
      runnerDevice,
      systemTempDevice,
      systemTempRoot,
    };
    validateShortTempState(state, markerContents);
    return state;
  } catch (error) {
    removeJustCreatedShortTemp(root, systemTempRoot, markerContents);
    throw error;
  }
}

function removeOwnedShortTemp(state, markerContents) {
  if (!state) return;
  validateShortTempState(state, markerContents);
  fs.rmSync(state.root, { recursive: true });
}

function validateCargoHome(environment, runnerTemp, owner) {
  const configured = required(environment, "CARGO_HOME");
  const expected = path.join(runnerTemp, "hebbian-cargo-home");
  if (configured !== expected) {
    fail(`Cargo home must be the prepared runner path ${expected}`);
  }
  const cargoHome = realDirectory(configured, "Cargo home");
  if (cargoHome !== expected) {
    fail("Cargo home resolves outside its prepared runner path");
  }
  exactRegularFile(
    path.join(cargoHome, ".hebbian-ci-owner"),
    `${owner}\n`,
    "Cargo home ownership marker",
  );
  return cargoHome;
}

function validateCargoTarget(environment, runnerWork, runnerTemp, workspace, owner) {
  if (required(environment, "HEBBIAN_CI_TARGET_PROFILE") !== "verify") {
    fail("Cargo target profile must be verify");
  }
  const targetRoot = realDirectory(
    required(environment, "HEBBIAN_CI_TARGET_ROOT"),
    "Cargo target root",
  );
  const expectedRoot = path.join(runnerWork, "_hebbian-ci-targets-v1");
  if (targetRoot !== expectedRoot) {
    fail(`Cargo target root must be the leased runner path ${expectedRoot}`);
  }
  if (isWithin(workspace, targetRoot) || isWithin(runnerTemp, targetRoot)) {
    fail("Cargo target root overlaps mutable checkout or runner temp state");
  }
  exactRegularFile(
    path.join(targetRoot, ".hebbian-ci-target-root"),
    "hebbian-ci-target-root-v1\n",
    "Cargo target root marker",
  );

  const target = realDirectory(
    required(environment, "CARGO_TARGET_DIR"),
    "Cargo target",
  );
  if (path.basename(target) !== "target") {
    fail("Cargo target must be the native output directory of its owned generation");
  }
  const generationDirectory = realDirectory(
    path.dirname(target),
    "Cargo target generation",
  );
  const generation = path.basename(generationDirectory);
  if (!TARGET_GENERATION.test(generation)) {
    fail("Cargo target generation is not canonical");
  }
  const profile = path.join(targetRoot, "verify");
  if (target !== path.join(profile, generation, "target")) {
    fail("Cargo target is outside the leased verify profile");
  }
  exactRegularFile(
    path.join(generationDirectory, ".hebbian-ci-target-owner"),
    `format=1\nprofile=verify\nrust=${generation}\n`,
    "Cargo target generation marker",
  );
  exactRegularFile(
    path.join(profile, ".lease", ".hebbian-ci-lease"),
    `${owner}\n`,
    "Cargo target lease",
  );
  return target;
}

function validateRustupHome(environment, runnerTemp) {
  const configured = required(environment, "RUSTUP_HOME");
  const expected = path.join(runnerTemp, "dure-rustup-home");
  if (configured !== expected) {
    fail(`Rustup home must be the runner path ${expected}`);
  }
  const rustupHome = realDirectory(configured, "Rustup home");
  if (rustupHome !== expected) {
    fail("Rustup home resolves outside its runner path");
  }
  return rustupHome;
}

function removeOwnedRoot(root, markerContents, runnerTemp) {
  if (!fs.existsSync(root)) return;
  const rootReal = realDirectory(root, "release isolation root");
  if (!isWithin(runnerTemp, rootReal)) {
    fail("release isolation root escaped runner temp during cleanup");
  }
  exactRegularFile(
    path.join(rootReal, ROOT_MARKER),
    markerContents,
    "release isolation ownership marker",
  );
  fs.rmSync(rootReal, { recursive: true });
}

function removeJustCreatedRoot(root, markerContents, runnerTemp) {
  try {
    removeOwnedRoot(root, markerContents, runnerTemp);
  } catch (cleanupError) {
    const rootReal = realDirectory(root, "release isolation root");
    if (!isWithin(runnerTemp, rootReal)) throw cleanupError;
    const entries = fs.readdirSync(rootReal);
    if (entries.length === 0) {
      fs.rmdirSync(rootReal);
      return;
    }
    if (entries.length === 1 && entries[0] === ROOT_MARKER) {
      const marker = path.join(rootReal, ROOT_MARKER);
      const metadata = fs.lstatSync(marker);
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        fs.unlinkSync(marker);
        fs.rmdirSync(rootReal);
        return;
      }
    }
    throw cleanupError;
  }
}

export function prepareReleaseVerificationEnvironment(
  source = process.env,
  workingDirectory = process.cwd(),
) {
  if (source.GITHUB_ACTIONS !== "true") {
    fail("explicit GitHub Actions authority is required");
  }
  const runId = safeToken(source, "GITHUB_RUN_ID", true);
  const runAttempt = safeToken(source, "GITHUB_RUN_ATTEMPT", true);
  const job = safeToken(source, "GITHUB_JOB");
  const owner = `${runId}:${runAttempt}:${job}`;
  const markerContents = `${owner}\n`;
  const runnerTemp = realDirectory(
    required(source, "HEBBIAN_CI_RUNNER_TEMP"),
    "runner temp",
  );
  const runnerWork = path.dirname(runnerTemp);
  const workspace = realDirectory(
    required(source, "GITHUB_WORKSPACE"),
    "GitHub workspace",
  );
  if (!isWithin(runnerWork, workspace) || isWithin(runnerTemp, workspace)) {
    fail("GitHub workspace is outside the runner work checkout boundary");
  }
  if (realDirectory(workingDirectory, "release checkout") !== workspace) {
    fail("release gate cwd must be the exact GitHub workspace");
  }

  const cargoHome = validateCargoHome(source, runnerTemp, owner);
  const cargoTarget = validateCargoTarget(
    source,
    runnerWork,
    runnerTemp,
    workspace,
    owner,
  );
  const rustupHome = validateRustupHome(source, runnerTemp);
  const root = path.join(
    runnerTemp,
    `dure-release-verification-${runId}-${runAttempt}-${job}`,
  );
  if (fs.existsSync(root) || fs.lstatSync(runnerTemp).isSymbolicLink()) {
    fail("release isolation root already exists or runner temp is a symlink");
  }

  let rootCreated = false;
  let shortTemp;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    rootCreated = true;
    fs.writeFileSync(path.join(root, ROOT_MARKER), markerContents, {
      flag: "wx",
      mode: 0o600,
    });
    shortTemp = prepareShortTemp(runnerTemp, markerContents);
    const environment = { ...source };
    for (const name of SCRUBBED_VARIABLES) delete environment[name];
    // pnpm accepts npm_config keys case-insensitively and has many writable
    // path settings. Normalize the whole untrusted namespace before adding
    // back only the three release-owned paths declared above.
    for (const name of Object.keys(environment)) {
      if (/^npm_config_/i.test(name)) delete environment[name];
    }
    for (const [name, relative] of Object.entries(ISOLATED_DIRECTORIES)) {
      const directory = path.join(root, relative);
      ensurePrivateDirectory(directory);
      environment[name] = directory;
    }
    const tempDirectory = shortTemp?.directory ?? path.join(root, "tmp");
    if (!shortTemp) ensurePrivateDirectory(tempDirectory);
    environment.TMPDIR = tempDirectory;
    environment.TEMP = tempDirectory;
    environment.TMP = tempDirectory;
    environment.HMUX_RUNTIME_ROOT = path.join(tempDirectory, "hmux-runtime");
    ensurePrivateDirectory(environment.HMUX_RUNTIME_ROOT);
    for (const [name, relative] of Object.entries(ISOLATED_FILES)) {
      const file = path.join(root, relative);
      ensurePrivateDirectory(path.dirname(file));
      environment[name] = file;
    }
    const buildId = `release-${runId}.${runAttempt}.${job}`;
    if (buildId.length > 128 || !SAFE_TOKEN.test(buildId)) {
      fail("release build identity is not one safe path component");
    }
    environment.CARGO_HOME = cargoHome;
    environment.CARGO_TARGET_DIR = cargoTarget;
    environment.RUSTUP_HOME = rustupHome;
    environment.HMUX_BUILD_ID = buildId;
    environment.DURE_HMUX_BUILD_ID = buildId;
    environment.DURE_CLI_BUILD_ID = buildId;
    environment.HMUX_INSTALL_LOCK_WAIT_SECONDS = "15";
    environment.DURE_CLI_LOCK_WAIT_MS = "15000";
    environment.DURE_RELEASE_VERIFICATION_ROOT = root;
    environment.VITEST_MAX_WORKERS = "1";
    if (shortTemp) validateShortTempState(shortTemp, markerContents);

    return {
      environment,
      root,
      cleanup() {
        let shortTempError;
        try {
          removeOwnedShortTemp(shortTemp, markerContents);
        } catch (error) {
          shortTempError = error;
        } finally {
          removeOwnedRoot(root, markerContents, runnerTemp);
        }
        if (shortTempError) throw shortTempError;
      },
    };
  } catch (error) {
    try {
      removeOwnedShortTemp(shortTemp, markerContents);
    } finally {
      if (rootCreated) {
        removeJustCreatedRoot(root, markerContents, runnerTemp);
      }
    }
    throw error;
  }
}

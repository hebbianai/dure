import { createHash } from "node:crypto";
import { basename, delimiter, join } from "node:path";
import { appRootUnder } from "./dure-home.mjs";

export const STABLE_APP_CHANNEL = "stable";
export const APP_CHANNEL_ENV = "DURE_APP_CHANNEL";
export const LEGACY_APP_CHANNEL_ENV = "HEBBIAN_APP_CHANNEL";
export const VITE_APP_CHANNEL_ENV = "VITE_DURE_APP_CHANNEL";
export const LEGACY_VITE_APP_CHANNEL_ENV = "VITE_HEBBIAN_APP_CHANNEL";
export const DEV_SERVER_HOST = "localhost";
export const DEV_SERVER_HOST_ENV = "HEBBIAN_DEV_HOST";
export const DEV_SERVER_PORT_ENV = "DURE_DEV_PORT";
export const DEV_INSTANCE_ENV = "HEBBIAN_DEV_INSTANCE";
export const DEV_WEBVIEW_DATA_STORE_ENV =
  "DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER";
const DEV_SERVER_PORT_BASE = 20_000;
const DEV_SERVER_PORT_COUNT = 40_000;

function worktreeHash(worktreeRoot) {
  return createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 10);
}

function devInstanceDigest(worktreeRoot, instance) {
  return createHash("sha256").update(`${worktreeRoot}\0${instance}`).digest();
}

function devWebviewStore(worktreeRoot, instance) {
  if (instance === undefined) return undefined;
  const digest = devInstanceDigest(worktreeRoot, instance);
  const storeKey = digest.toString("hex").slice(0, 32);
  return {
    identifier: storeKey,
    dataStoreIdentifier: Array.from(digest.subarray(0, 16)),
    // WebView2/WebKitGTK use the relative data directory. Keeping both fields
    // gives an explicit instance fence on every desktop platform.
    dataDirectory: `dure-dev-${storeKey}`,
  };
}

export function devWebviewEnvironment(webviewStore) {
  if (!webviewStore) return {};
  if (!/^[a-f0-9]{32}$/.test(webviewStore.identifier)) {
    throw new Error("dev WebView data-store identifier must be 32 lowercase hex characters");
  }
  return {
    [DEV_WEBVIEW_DATA_STORE_ENV]: webviewStore.identifier,
  };
}

export function validateAppChannel(channel) {
  if (!/^[a-z0-9-]{1,64}$/.test(channel)) {
    throw new Error(
      "app channel must contain only lowercase letters, digits, and hyphens",
    );
  }
  return channel;
}

export function resolveAppChannel(environment = process.env) {
  return validateAppChannel(
    environment[APP_CHANNEL_ENV] ??
      environment[LEGACY_APP_CHANNEL_ENV] ??
      STABLE_APP_CHANNEL,
  );
}

export function canonicalAppChannelEnvironment(
  channel,
  environment = {},
  { includeVite = false } = {},
) {
  const resolved = validateAppChannel(channel);
  const result = {
    ...environment,
    [APP_CHANNEL_ENV]: resolved,
    ...(includeVite ? { [VITE_APP_CHANNEL_ENV]: resolved } : {}),
  };
  delete result[LEGACY_APP_CHANNEL_ENV];
  delete result[LEGACY_VITE_APP_CHANNEL_ENV];
  return result;
}

export function appControlDirectory(home, channel = STABLE_APP_CHANNEL) {
  validateAppChannel(channel);
  const root = appRootUnder(home);
  return channel === STABLE_APP_CHANNEL
    ? root
    : join(root, "channels", channel);
}

export function worktreeDevIdentity(worktreeRoot, instance) {
  const slug =
    basename(worktreeRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "worktree";
  if (instance !== undefined && !/^[a-z0-9-]{1,20}$/.test(instance)) {
    throw new Error(
      `${DEV_INSTANCE_ENV} must contain only lowercase letters, digits, and hyphens`,
    );
  }
  const hash = instance
    ? devInstanceDigest(worktreeRoot, instance).toString("hex").slice(0, 10)
    : worktreeHash(worktreeRoot);
  const channel = validateAppChannel(`dev-${slug}-${hash}`);
  return {
    channel,
    hash,
    identifier: `io.hebbian.ade.dev.${hash}`,
    productName: `Dure Dev ${slug}`,
    windowTitle: `Dure Dev · ${slug}`,
  };
}

export function devHmuxToolPaths(home, channel) {
  validateAppChannel(channel);
  if (!channel.startsWith("dev-")) {
    throw new Error("development Hmux tools require an isolated dev channel");
  }
  if (typeof home !== "string" || home.length === 0) {
    throw new Error("home is required for development Hmux tools");
  }
  const installRoot = join(
    home,
    ".local",
    "share",
    "hmux",
    "channels",
    channel,
  );
  const commandDirectory = join(installRoot, "bin");
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  return {
    installRoot,
    commandDirectory,
    hmuxCommand: join(commandDirectory, `hmux${executableSuffix}`),
  };
}

export function devHmuxEnvironment(home, channel, currentPath = "") {
  const paths = devHmuxToolPaths(home, channel);
  return {
    HMUX_INSTALL_ROOT: paths.installRoot,
    HMUX_INSTALL_DIR: paths.commandDirectory,
    HEBBIAN_HMUX_BIN: paths.hmuxCommand,
    PATH: currentPath
      ? `${paths.commandDirectory}${delimiter}${currentPath}`
      : paths.commandDirectory,
  };
}

export function deterministicDevServerPort(worktreeRoot) {
  const hashPrefix = worktreeHash(worktreeRoot).slice(0, 8);
  return (
    DEV_SERVER_PORT_BASE +
    (Number.parseInt(hashPrefix, 16) % DEV_SERVER_PORT_COUNT)
  );
}

export function resolveDevServer(worktreeRoot, portOverride, hostOverride) {
  const host = hostOverride ?? DEV_SERVER_HOST;
  if (host !== DEV_SERVER_HOST && host !== "127.0.0.1") {
    throw new Error(
      `${DEV_SERVER_HOST_ENV} must be ${DEV_SERVER_HOST} or 127.0.0.1`,
    );
  }
  let port;
  const source =
    portOverride === undefined && hostOverride === undefined
      ? "worktree-hash"
      : "environment";
  if (portOverride === undefined) {
    port = deterministicDevServerPort(worktreeRoot);
  } else {
    if (!/^[0-9]+$/.test(portOverride)) {
      throw new Error(
        `${DEV_SERVER_PORT_ENV} must be an integer between 1024 and 65535`,
      );
    }
    port = Number(portOverride);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error(
        `${DEV_SERVER_PORT_ENV} must be an integer between 1024 and 65535`,
      );
    }
  }
  return {
    host,
    port,
    origin: `http://${host}:${port}`,
    source,
  };
}

/** Tauri가 자동으로 얹는 플랫폼별 설정 파일 이름. 지원하지 않는 플랫폼은 null. */
export function platformTauriConfigFile(platform = process.platform) {
  if (platform === "darwin") return "tauri.macos.conf.json";
  if (platform === "linux") return "tauri.linux.conf.json";
  if (platform === "win32") return "tauri.windows.conf.json";
  return null;
}

/**
 * Tauri의 설정 합치기 규칙을 그대로 옮긴 것 — 객체는 재귀 병합, 배열은 교체.
 *
 * 왜 우리가 이걸 해야 하나: `tauri dev --config <json>`은 우리 인라인 설정을
 * **가장 마지막에** 얹는다. 그래서 `app.windows`를 우리가 내보내는 순간, 그
 * 배열은 `tauri.macos.conf.json`이 넣어 둔 창 설정을 통째로 갈아치운다.
 * 2026-07-30에 macOS 창 설정(`titleBarStyle: Overlay`, `hiddenTitle`,
 * `transparent`, `backgroundThrottling`)이 Linux 패키징 작업에서 플랫폼 파일로
 * 옮겨졌고, dev 앱만 그 뒤로 네이티브 타이틀바가 달린 불투명 창이 됐다 —
 * 앱 안에 앱이 든 것처럼 보였다. 패키징 빌드는 멀쩡했으므로 아무도 못 봤다.
 *
 * 그래서 dev 설정을 만들기 **전에** 우리가 먼저 플랫폼 파일을 얹어 Tauri와 같은
 * 우선순위를 재현한다. (같은 부류의 사고가 이 함수 위쪽 주석에 한 번 더 있다:
 * `macOSPrivateApi`가 dev 앱에 닿지 않았던 건.)
 */
export function mergeTauriConfigs(base, overlay) {
  if (overlay === undefined) return base;
  if (
    base === null ||
    overlay === null ||
    typeof base !== "object" ||
    typeof overlay !== "object" ||
    Array.isArray(base) ||
    Array.isArray(overlay)
  ) {
    return overlay;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in base ? mergeTauriConfigs(base[key], value) : value;
  }
  return merged;
}

export function buildDevTauriConfig({
  worktreeRoot,
  vitePort,
  viteHost = DEV_SERVER_HOST,
  baseConfig,
  instance,
}) {
  if (!Number.isInteger(vitePort) || vitePort < 1 || vitePort > 65_535) {
    throw new Error("vitePort must be a valid TCP port");
  }
  if (viteHost !== DEV_SERVER_HOST && viteHost !== "127.0.0.1") {
    throw new Error(`viteHost must be ${DEV_SERVER_HOST} or 127.0.0.1`);
  }
  const identity = worktreeDevIdentity(worktreeRoot, instance);
  const webviewStore = devWebviewStore(worktreeRoot, instance);
  const windows = (baseConfig.app?.windows ?? []).map((window, index) => ({
    ...window,
    ...(index === 0 ? { title: identity.windowTitle } : {}),
    ...(webviewStore ? { dataDirectory: webviewStore.dataDirectory } : {}),
  }));
  if (windows.length === 0) {
    throw new Error("base Tauri config must define a main window");
  }
  return {
    identity,
    webviewStore,
    config: {
      productName: identity.productName,
      identifier: identity.identifier,
      build: {
        devUrl: `http://${viteHost}:${vitePort}`,
        beforeDevCommand: null,
      },
      app: {
        // Carry the base app settings through explicitly. Only `windows` was
        // being forwarded, so anything else under `app` depended on Tauri
        // merging this override into tauri.conf.json rather than replacing the
        // object — and macOSPrivateApi, which window transparency needs on
        // macOS, silently did not reach the dev app.
        ...(baseConfig.app ?? {}),
        windows,
      },
    },
  };
}

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appControlDirectory,
  buildDevTauriConfig,
  canonicalAppChannelEnvironment,
  deterministicDevServerPort,
  devWebviewEnvironment,
  devHmuxEnvironment,
  devHmuxToolPaths,
  DEV_SERVER_HOST_ENV,
  DEV_SERVER_PORT_ENV,
  DEV_WEBVIEW_DATA_STORE_ENV,
  mergeTauriConfigs,
  platformTauriConfigFile,
  resolveDevServer,
  resolveAppChannel,
  validateAppChannel,
  worktreeDevIdentity,
} from "./app-channel.mjs";

const baseConfig = {
  app: {
    windows: [
      {
        title: "Hebbian",
        width: 1480,
        height: 940,
        hiddenTitle: true,
      },
    ],
  },
};
const guardPath = fileURLToPath(
  new URL("../guard-dev-channel.mjs", import.meta.url),
);
const channelResolverPath = fileURLToPath(
  new URL("../resolve-dev-app-channel.mjs", import.meta.url),
);

describe("app channel planning", () => {
  it("uses Dure as authority and keeps Hebbian as an input-only fallback", () => {
    expect(
      resolveAppChannel({
        DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
        HEBBIAN_APP_CHANNEL: "dev-legacy-decoy-a1b2c3d4",
      }),
    ).toBe("dev-canonical-a1b2c3d4");
    expect(
      resolveAppChannel({
        HEBBIAN_APP_CHANNEL: "dev-legacy-a1b2c3d4",
      }),
    ).toBe("dev-legacy-a1b2c3d4");
    expect(resolveAppChannel({})).toBe("stable");

    expect(
      canonicalAppChannelEnvironment(
        "dev-canonical-a1b2c3d4",
        {
          DURE_APP_CHANNEL: "dev-stale-dure",
          HEBBIAN_APP_CHANNEL: "dev-stale-hebbian",
          VITE_DURE_APP_CHANNEL: "dev-stale-vite-dure",
          VITE_HEBBIAN_APP_CHANNEL: "dev-stale-vite-hebbian",
          PATH: "/bin",
        },
        { includeVite: true },
      ),
    ).toEqual({
      DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
      VITE_DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
      PATH: "/bin",
    });
  });

  it("preserves the stable control path and isolates development paths", () => {
    expect(appControlDirectory("/Users/me", "stable")).toBe(
      "/Users/me/.dure",
    );
    expect(appControlDirectory("/Users/me", "dev-feature-a1b2c3d4")).toBe(
      "/Users/me/.dure/channels/dev-feature-a1b2c3d4",
    );
  });

  it("derives stable, distinct worktree development identities", () => {
    const first = worktreeDevIdentity("/repo/.worktrees/feature-a");
    const again = worktreeDevIdentity("/repo/.worktrees/feature-a");
    const second = worktreeDevIdentity("/repo/.worktrees/feature-b");

    expect(again).toEqual(first);
    expect(second.channel).not.toBe(first.channel);
    expect(second.identifier).not.toBe(first.identifier);
    expect(first.channel).toMatch(/^dev-feature-a-[a-f0-9]{10}$/);
    expect(first.identifier).toBe(`io.hebbian.ade.dev.${first.hash}`);
    expect(first.productName).toBe("Dure Dev feature-a");
    expect(first.windowTitle).toBe("Dure Dev · feature-a");
  });

  it("keeps development Hmux current and commands inside the app channel", () => {
    const paths = devHmuxToolPaths(
      "/Users/me",
      "dev-feature-a-a1b2c3d4",
    );
    expect(paths.installRoot).toBe(
      "/Users/me/.local/share/hmux/channels/dev-feature-a-a1b2c3d4",
    );
    expect(paths.commandDirectory).toBe(`${paths.installRoot}/bin`);
    expect(paths.hmuxCommand).toBe(
      `${paths.commandDirectory}/hmux${process.platform === "win32" ? ".exe" : ""}`,
    );
    expect(
      devHmuxEnvironment(
        "/Users/me",
        "dev-feature-a-a1b2c3d4",
        "/usr/bin",
      ),
    ).toMatchObject({
      HMUX_INSTALL_ROOT: paths.installRoot,
      HMUX_INSTALL_DIR: paths.commandDirectory,
      HEBBIAN_HMUX_BIN: paths.hmuxCommand,
      PATH: `${paths.commandDirectory}${delimiter}/usr/bin`,
    });
    expect(() => devHmuxToolPaths("/Users/me", "stable")).toThrow(
      "isolated dev channel",
    );
  });

  it("resolves the current worktree instead of inherited app or Git pointers", () => {
    const resolved = spawnSync(process.execPath, [channelResolverPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: "/fixture/wrong-repository",
        HEBBIAN_APP_CHANNEL: "dev-inherited-wrong-a1b2c3d4",
      },
    });

    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe(
      worktreeDevIdentity(realpathSync(process.cwd())).channel,
    );
  });

  it("uses the same explicit instance as the dev app launcher", () => {
    const worktreeRoot = realpathSync(process.cwd());
    const channel = worktreeDevIdentity(worktreeRoot, "chat-pane-v1").channel;
    const resolved = spawnSync(process.execPath, [channelResolverPath], {
      cwd: worktreeRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "dev-inherited-wrong-canonical-a1b2c3d4",
        HEBBIAN_APP_CHANNEL: "dev-inherited-wrong-a1b2c3d4",
        HEBBIAN_DEV_INSTANCE: "chat-pane-v1",
      },
    });

    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe(channel);
  });

  it("derives one stable origin per worktree and distinct defaults", () => {
    const first = resolveDevServer("/repo/.worktrees/feature-a");
    const again = resolveDevServer("/repo/.worktrees/feature-a");
    const second = resolveDevServer("/repo/.worktrees/feature-b");

    expect(again).toEqual(first);
    expect(second.origin).not.toBe(first.origin);
    expect(first.port).toBe(
      deterministicDevServerPort("/repo/.worktrees/feature-a"),
    );
    expect(first).toMatchObject({
      host: "localhost",
      source: "worktree-hash",
    });
  });

  it("supports an explicit stable port for legacy profile continuity", () => {
    expect(DEV_SERVER_PORT_ENV).toBe("DURE_DEV_PORT");
    expect(resolveDevServer("/repo/.worktrees/feature-a", "1420")).toEqual({
      host: "localhost",
      port: 1420,
      origin: "http://localhost:1420",
      source: "environment",
    });

    for (const port of ["", "abc", "80", "65536"]) {
      expect(() =>
        resolveDevServer("/repo/.worktrees/feature-a", port),
      ).toThrow(DEV_SERVER_PORT_ENV);
    }

    expect(
      resolveDevServer(
        "/repo/.worktrees/feature-a",
        "54201",
        "127.0.0.1",
      ),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 54_201,
      origin: "http://127.0.0.1:54201",
    });
    expect(() =>
      resolveDevServer("/repo/.worktrees/feature-a", "1420", "0.0.0.0"),
    ).toThrow(DEV_SERVER_HOST_ENV);
  });

  it("overlays a deterministic origin and identity without dropping window options", () => {
    const plan = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 14_321,
      baseConfig,
    });

    expect(plan.config.build.devUrl).toBe("http://localhost:14321");
    expect(plan.config.build.beforeDevCommand).toBeNull();
    expect(plan.config.identifier).toBe(plan.identity.identifier);
    expect(plan.config.app.windows[0]).toMatchObject({
      title: plan.identity.windowTitle,
      width: 1480,
      height: 940,
      hiddenTitle: true,
    });
  });

  it("isolates persistent WebView state for each explicit dev instance", () => {
    const first = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 54_201,
      baseConfig,
      instance: "onboarding-a",
    });
    const restarted = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 54_201,
      baseConfig,
      instance: "onboarding-a",
    });
    const other = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 54_201,
      baseConfig,
      instance: "onboarding-b",
    });
    const ordinary = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 54_201,
      baseConfig,
    });

    expect(first.webviewStore.dataStoreIdentifier).toHaveLength(16);
    expect(first.webviewStore.dataStoreIdentifier).toEqual(
      restarted.webviewStore.dataStoreIdentifier,
    );
    expect(first.webviewStore.dataStoreIdentifier).not.toEqual(
      other.webviewStore.dataStoreIdentifier,
    );
    expect(first.config.app.windows[0].dataDirectory).toMatch(
      /^dure-dev-[a-f0-9]{32}$/,
    );
    expect(first.config.app.windows[0].dataDirectory).toBe(
      restarted.config.app.windows[0].dataDirectory,
    );
    expect(first.config.app.windows[0].dataDirectory).not.toBe(
      other.config.app.windows[0].dataDirectory,
    );
    expect(ordinary.webviewStore).toBeUndefined();
    expect(ordinary.config.app.windows[0]).not.toHaveProperty("dataDirectory");
    expect(devWebviewEnvironment(first.webviewStore)).toEqual({
      [DEV_WEBVIEW_DATA_STORE_ENV]: first.webviewStore.identifier,
    });
    expect(devWebviewEnvironment(ordinary.webviewStore)).toEqual({});
    expect(() =>
      devWebviewEnvironment({ identifier: "../shared" }),
    ).toThrow("32 lowercase hex");
  });

  it("rejects path-like or unbounded channel names", () => {
    for (const channel of ["../stable", "Dev-main", "dev/main", "dev_main"]) {
      expect(() => validateAppChannel(channel)).toThrow();
    }
    expect(() => validateAppChannel("x".repeat(65))).toThrow();
  });

  it("refuses raw stable-channel development and accepts an isolated channel", () => {
    const environment = { ...process.env };
    delete environment.DURE_APP_CHANNEL;
    delete environment.HEBBIAN_APP_CHANNEL;
    const stable = spawnSync(process.execPath, [guardPath], {
      encoding: "utf8",
      env: { ...environment, DURE_APP_CHANNEL: "stable" },
    });
    const isolated = spawnSync(process.execPath, [guardPath], {
      encoding: "utf8",
      env: {
        ...environment,
        HEBBIAN_APP_CHANNEL: "dev-feature-a1b2c3d4",
      },
    });

    expect(stable.status).toBe(1);
    expect(stable.stderr).toContain("Refusing an unisolated Tauri dev app");
    expect(isolated.status).toBe(0);

    const canonical = spawnSync(process.execPath, [guardPath], {
      encoding: "utf8",
      env: {
        ...environment,
        DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
        HEBBIAN_APP_CHANNEL: "stable",
      },
    });
    expect(canonical.status).toBe(0);
  });
});

describe("platform Tauri config", () => {
  it("Tauri가 얹는 플랫폼 파일 이름을 그대로 쓴다", () => {
    expect(platformTauriConfigFile("darwin")).toBe("tauri.macos.conf.json");
    expect(platformTauriConfigFile("linux")).toBe("tauri.linux.conf.json");
    expect(platformTauriConfigFile("win32")).toBe("tauri.windows.conf.json");
    expect(platformTauriConfigFile("aix")).toBeNull();
  });

  it("객체는 재귀 병합, 배열은 교체 — Tauri와 같은 규칙", () => {
    expect(
      mergeTauriConfigs(
        { app: { security: { csp: null }, windows: [{ a: 1 }, { b: 2 }] } },
        { app: { windows: [{ a: 9 }] } },
      ),
    ).toEqual({ app: { security: { csp: null }, windows: [{ a: 9 }] } });
  });

  it("overlay가 없으면 base 그대로", () => {
    const base = { app: { windows: [{ a: 1 }] } };
    expect(mergeTauriConfigs(base, undefined)).toBe(base);
  });

  it("null은 값으로 덮어쓴다 (Tauri의 csp: null을 지우지 않는다)", () => {
    expect(mergeTauriConfigs({ csp: "x" }, { csp: null })).toEqual({ csp: null });
  });
});

// dev 앱의 창이 실제 저장소 설정과 어긋나지 않는지 — 픽스처가 아니라 진짜 파일로 본다.
//
// 왜 픽스처가 아니라 실제 파일인가: 이 회귀가 두 번 났고 두 번 다 픽스처는
// 통과했다. macOS 창 설정이 tauri.conf.json에서 tauri.macos.conf.json으로
// 옮겨졌을 때, 위쪽 buildDevTauriConfig 테스트의 baseConfig 픽스처에는
// hiddenTitle이 그대로 남아 있어 green이었고, 실제 dev 앱만 네이티브 타이틀바가
// 달린 불투명 창이 됐다. 키가 어느 파일에 있든 dev 앱에 닿는지를 본다.
describe("dev 앱 macOS 창 계약", () => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const configDirectory = `${repositoryRoot}src-tauri`;
  const merged = mergeTauriConfigs(
    JSON.parse(readFileSync(`${configDirectory}/tauri.conf.json`, "utf8")),
    JSON.parse(readFileSync(`${configDirectory}/tauri.macos.conf.json`, "utf8")),
  );

  it("dev 설정이 투명 창·오버레이 타이틀바를 그대로 들고 간다", () => {
    const plan = buildDevTauriConfig({
      worktreeRoot: "/repo/.worktrees/feature-a",
      vitePort: 14_321,
      baseConfig: merged,
    });

    expect(plan.config.app.windows[0]).toMatchObject({
      titleBarStyle: "Overlay",
      hiddenTitle: true,
      transparent: true,
      backgroundThrottling: "disabled",
    });
    // 투명 창은 macOS에서 이 플래그 없이는 동작하지 않는다.
    expect(plan.config.app.macOSPrivateApi).toBe(true);
    expect(plan.config.app.windows[0].title).toBe(plan.identity.windowTitle);
  });
});

describe("dev WebView data-store adapter contract", () => {
  it("keeps the launcher and Rust startup adapter on one exact env key", () => {
    const adapter = readFileSync(
      fileURLToPath(
        new URL("../../src-tauri/src/webview_storage.rs", import.meta.url),
      ),
      "utf8",
    );

    expect(adapter).toContain(
      `const DEV_WEBVIEW_DATA_STORE_ENV: &str = "${DEV_WEBVIEW_DATA_STORE_ENV}";`,
    );
  });
});

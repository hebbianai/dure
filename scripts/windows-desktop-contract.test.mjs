import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  assessWindowsDesktopHost,
  rustHostFromVerboseVersion,
} from "./qa/windows-desktop-doctor.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (relativePath) =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const json = (relativePath) => JSON.parse(read(relativePath));

describe("Windows desktop configuration boundary", () => {
  test("uses a Windows-only build path with native Hmux sidecars", () => {
    const windows = json("src-tauri/tauri.windows.conf.json");

    expect(windows.build.beforeDevCommand).toBe("pnpm dev:windows");
    expect(windows.build.beforeBuildCommand).toBe("pnpm build:windows");
    expect(windows.bundle.externalBin).toEqual([
      "binaries/hmux-runtime",
      "binaries/hmux",
    ]);
    expect(windows.bundle.resources).toEqual({
      "resources/remote-git-checkout-helper/":
        "resources/remote-git-checkout-helper/",
    });
    expect(windows.bundle.icon).toEqual(["icons/icon.ico"]);
  });

  test("ships one current-user NSIS preview and defers updater publication", () => {
    const windows = json("src-tauri/tauri.windows.conf.json");

    expect(windows.bundle.targets).toEqual(["nsis"]);
    expect(windows.bundle.createUpdaterArtifacts).toBe(false);
    expect(windows.bundle.windows.nsis.installMode).toBe("currentUser");
    expect(windows.bundle.windows.webviewInstallMode.type).toBe(
      "downloadBootstrapper",
    );
  });
});

describe("Windows desktop build gate", () => {
  const packageJson = json("package.json");

  test("uses the toolchain-owned COFF linker for every Windows Cargo boundary", () => {
    const cargoConfig = read(".cargo/config.toml");

    expect(cargoConfig).toContain("[target.x86_64-pc-windows-msvc]");
    expect(cargoConfig).toContain('linker = "rust-lld"');
    expect(cargoConfig).toContain('linker-flavor=lld-link');
  });

  test("has native verify, bundle, and frontend-only Windows build commands", () => {
    expect(packageJson.scripts["dev:windows"]).toBe("vite");
    expect(packageJson.scripts["build:windows"]).toBe(
      "pnpm git-checkout:remote:stage && pnpm typecheck && pnpm build:frontend",
    );
    expect(packageJson.scripts["app:windows:doctor"]).toBe(
      "node scripts/qa/windows-desktop-doctor.mjs",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "--package hmux-client --test windows_named_pipe_attach",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "--package hmux-runtime --test discovery_census_worker",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "pnpm hmux:runtime:stage:release",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "pnpm git-checkout:remote:stage",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "sh scripts/build-hmux-product-runtime.sh x86_64-pc-windows-msvc",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "--features hmux-runtime/terminal-state-stream",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "cargo +1.85.0 clippy --locked --manifest-path hmux/Cargo.toml",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "cargo test --locked --manifest-path src-tauri/Cargo.toml --bin dure",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "cargo clippy --locked --manifest-path src-tauri/Cargo.toml --bin dure -- -D warnings",
    );
    expect(packageJson.scripts["app:windows:verify"]).toContain(
      "pnpm verify:frontend",
    );
    expect(packageJson.scripts["verify:push:desktop"]).toContain(
      "src/lib/workspace/window/windows.test.ts",
    );
    expect(packageJson.scripts["app:windows:build"]).toContain(
      "run-with-build-storage.mjs full",
    );
    expect(packageJson.scripts["app:windows:build:implementation"]).toContain(
      "tauri build --bundles nsis",
    );
    expect(packageJson.scripts["app:windows:build:implementation"]).toContain(
      "pnpm hmux:runtime:stage:release",
    );
  });

  test("rejects non-Windows, inherited config, and the wrong Rust host", () => {
    expect(
      assessWindowsDesktopHost({
        platform: "darwin",
        architecture: "arm64",
        tauriConfig: '{"app":{"macOSPrivateApi":true}}',
        commandAvailable: () => true,
        rustHost: "aarch64-apple-darwin",
      }),
    ).toEqual([
      "platform:darwin",
      "architecture:arm64",
      "environment:TAURI_CONFIG",
      "rust-host:aarch64-apple-darwin",
    ]);
    expect(
      rustHostFromVerboseVersion(
        "rustc 1.97.1\r\nbinary: rustc\r\nhost: x86_64-pc-windows-msvc\r\n",
      ),
    ).toBe("x86_64-pc-windows-msvc");
    expect(
      assessWindowsDesktopHost({
        platform: "win32",
        architecture: "x64",
        tauriConfig: undefined,
        commandAvailable: (command) => command !== "bash",
        rustHost: "x86_64-pc-windows-msvc",
      }),
    ).toEqual(["command:bash"]);
  });

  test("advertises native local Hmux only with the matching adapter commands", () => {
    const backend = read("src-tauri/src/windows.rs");

    expect(backend).toContain('"windows.desktop-native-v1"');
    expect(backend).toContain('"git.local-v1"');
    expect(backend).toContain('"git.remote-checkout-helper-v1"');
    expect(backend).toContain('"ssh.utility-v1"');
    expect(backend).toContain('"hmux.terminal-state-binary-v1"');
    expect(backend).toContain('"hmux.standalone-terminal-surface-v1"');
    expect(backend).not.toContain('"hmux.standalone-controller-canary-v1"');
    expect(backend).toContain('"hmux.managed-create-v1"');
    expect(backend).toContain('"hmux.managed-shell-v1"');
    expect(backend).toContain('"hmux.managed-stop-v1"');
    expect(backend).toContain('"hmux.initial-agent-prompt-v1"');
    expect(backend).toContain("hmux_managed_create");
    expect(backend).toContain("hmux_initial_agent_prompt");
    expect(backend).toContain("hmux_structured_terminal_attach");
    expect(backend).toContain("prepare_remote_git_checkout_helper");
    expect(backend).not.toContain("dure-backend-windows-preview");
  });

  test("checks the installed application and its bundled runtime", () => {
    const smoke = read("scripts/qa/windows-desktop-smoke.ps1");
    expect(smoke).toContain('"*-setup.exe"');
    expect(smoke).toContain('"/D=$installRoot"');
    expect(smoke).toContain('Join-Path $installRoot "dure.exe"');
    expect(smoke).toContain('Join-Path $installRoot "uninstall.exe"');
    expect(smoke).toContain('"hmux-runtime.exe"');
    expect(smoke).toContain('"hmux.exe"');
    expect(smoke).toContain('"--no-autostart"');
    expect(smoke).toContain('"hmux-build-info"');
    expect(smoke).toContain('"structured-terminal-v1"');
  });
});

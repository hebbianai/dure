import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { buildLocalApp } from "./build-local-app.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

test.each([true, false])("the macOS build prepares its native library before packaging (input present: %s)", (inputPresent) => {
  const root = mkdtempSync(join(tmpdir(), "dure-macos-preparation-"));
  try {
    const bin = join(root, "bin");
    const scripts = join(root, "scripts");
    const packageRoot = join(root, "node_modules", "serve-sim");
    const native = join(packageRoot, "dist", "native");
    for (const directory of [bin, scripts, native]) mkdirSync(directory, { recursive: true });
    const receipt = join(root, "stages.log");
    const library = join(root, "src-tauri", "resources", "mobile-runtime", "serve-sim-native.dylib");
    const bytes = "fixture native library";
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "serve-sim", type: "module", exports: { "./middleware": "./dist/middleware.mjs" },
    }));
    writeFileSync(join(packageRoot, "dist", "middleware.mjs"), "");
    if (inputPresent) writeFileSync(join(native, "serve-sim-native.node"), bytes);
    copyFileSync(fileURLToPath(new URL("./stage-mobile-runtime.mjs", import.meta.url)), join(scripts, "stage-mobile-runtime.mjs"));
    writeFileSync(join(scripts, "stage-dure-cli.mjs"), `import fs from 'node:fs'; fs.appendFileSync(process.env.DURE_TEST_RECEIPT, 'cli\\n');\n`);
    const build = `const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'build') throw new Error('unexpected package command');
if (fs.readFileSync(${JSON.stringify(library)}, 'utf8') !== ${JSON.stringify(bytes)}) throw new Error('native library was not staged');
fs.appendFileSync(process.env.DURE_TEST_RECEIPT, 'build\\n');\n`;
    if (process.platform === "win32") {
      writeFileSync(join(bin, "pnpm-fixture.cjs"), build);
      writeFileSync(join(bin, "pnpm.cmd"), `@"${process.execPath}" "%~dp0pnpm-fixture.cjs" %*\r\n`);
    } else {
      writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env node\n${build}`, { mode: 0o755 });
    }
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
    const result = spawnSync(config.build.beforeBuildCommand, {
      cwd: root,
      shell: true,
      env: scriptTestEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH}`, DURE_TEST_RECEIPT: receipt }),
      encoding: "utf8",
    });
    if (inputPresent) {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(library, "utf8")).toBe(bytes);
      expect(readFileSync(receipt, "utf8")).toBe("build\ncli\n");
    } else {
      expect(result.status).not.toBe(0);
      expect(existsSync(library)).toBe(false);
      expect(existsSync(receipt)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["linux", "arm64"], ["win32", "x64"], ["darwin", "x64"],
])("does not start unsupported %s/%s builds", async (platform, architecture) => {
  const execute = vi.fn();
  await expect(buildLocalApp([], { platform, architecture, execute })).rejects.toThrow("Apple Silicon macOS");
  expect(execute).not.toHaveBeenCalled();
});

test("help works before platform admission and unexpected options cannot change the build", async () => {
  const execute = vi.fn();
  const log = vi.fn();
  expect(await buildLocalApp(["--help"], { platform: "linux", execute, log })).toBe(0);
  await expect(buildLocalApp(["--config", "unreviewed.json"], { execute })).rejects.toThrow("usage:");
  expect(execute).not.toHaveBeenCalled();
});

test("keeps storage admission outside Tauri and returns a failed build status", async () => {
  const execute = vi.fn(() => 23);
  expect(await buildLocalApp([], { platform: "darwin", architecture: "arm64", execute })).toBe(23);
  const [kind, separator, command, entrypoint, ...args] = execute.mock.calls[0][0];
  expect([kind, separator, command]).toEqual(["full", "--", process.execPath]);
  expect(entrypoint).toBe(fileURLToPath(new URL("./lib/dev-tauri-cli.mjs", import.meta.url)));
  expect(args.slice(-2)).toEqual(["--", "--locked"]);
  expect(JSON.parse(args[args.indexOf("--config") + 1])).toEqual({ bundle: { createUpdaterArtifacts: false } });
  expect(args).toContain("--no-sign");
  expect(args[args.indexOf("--runner") + 1]).toBe(fileURLToPath(new URL("./native/cargo-build.sh", import.meta.url)));
});

test("propagates an admission refusal without starting another build path", async () => {
  const execute = vi.fn(() => { throw new Error("storage admission refused"); });
  await expect(buildLocalApp([], { platform: "darwin", architecture: "arm64", execute })).rejects.toThrow("storage admission refused");
  expect(execute).toHaveBeenCalledOnce();
});

test.skipIf(process.platform === "win32")("the real Cargo runner preserves arguments and the leaf exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "dure-local-app-test-"));
  try {
    const bin = join(root, "tools with spaces");
    mkdirSync(bin);
    const cargo = join(bin, "cargo");
    const receipt = join(root, "cargo.json");
    writeFileSync(cargo, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.DURE_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))); process.exit(29);\n`);
    chmodSync(cargo, 0o755);
    const args = ["build", "--locked", "--manifest-path", "path with spaces/Cargo.toml", "literal;$value"];
    const result = spawnSync(fileURLToPath(new URL("./native/cargo-build.sh", import.meta.url)), args, {
      cwd: root,
      env: scriptTestEnvironment({
        PATH: `${bin}:${process.env.PATH}`,
        DURE_TEST_RECEIPT: receipt,
        DURE_NATIVE_BUILD_SLOT_ROOT: join(root, "slot"),
      }),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(29);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

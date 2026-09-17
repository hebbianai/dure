import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  devTauriCliInvocation,
  resolveDevTauriCliEntrypoint,
} from "./dev-tauri-cli.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeManifest(bin) {
  const root = mkdtempSync(join(tmpdir(), "dure-tauri-cli-"));
  const packageRoot = join(root, "node_modules", "@tauri-apps", "cli");
  temporaryRoots.push(root);
  mkdirSync(join(packageRoot, "nested"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin }));
  writeFileSync(join(packageRoot, "nested", "entry.cjs"), "");
  return { root, entrypoint: join(packageRoot, "nested", "entry.cjs") };
}

describe("dev Tauri CLI", () => {
  it.each([
    "./nested/entry.cjs",
    { other: "./wrong.cjs", tauri: "./nested/entry.cjs" },
  ])("resolves the package manifest bin %j", (bin) => {
    const { root, entrypoint } = writeManifest(bin);
    const resolvedEntrypoint = realpathSync(entrypoint);

    expect(resolveDevTauriCliEntrypoint(root)).toBe(resolvedEntrypoint);
    expect(devTauriCliInvocation(["--version"])).toEqual({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./dev-tauri-cli.mjs", import.meta.url)),
        "--version",
      ],
    });
  });

  it("rejects a package without a Tauri bin", () => {
    const { root } = writeManifest({ other: "./nested/entry.cjs" });

    expect(() => resolveDevTauriCliEntrypoint(root)).toThrow(
      "the installed @tauri-apps/cli package has no Tauri entrypoint",
    );
  });

  it("resolves late and execs the manifest bin in the wrapper process", () => {
    const { root } = writeManifest("./nested/entry.cjs");
    const packageRoot = join(root, "node_modules", "@tauri-apps", "cli");
    const receipt = join(root, "tauri-main.json");
    const invocation = devTauriCliInvocation(["dev"]);
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ bin: { tauri: "./nested/replacement.cjs" } }),
    );
    writeFileSync(
      join(packageRoot, "nested", "replacement.cjs"),
      `if (require.main !== module) process.exit(65);
require("node:fs").writeFileSync(
  process.env.DURE_TEST_TAURI_MAIN_RECEIPT,
  JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }),
);
`,
    );

    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: { ...process.env, DURE_TEST_TAURI_MAIN_RECEIPT: receipt },
    });

    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
      pid: result.pid,
      args: ["dev"],
    });
  });
});

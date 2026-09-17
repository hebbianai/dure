import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COREPACK_EXECUTABLE_ENV } from "./lib/corepack-install.mjs";
import {
  PACKAGE_SCRIPT_SHELL_ENV,
  POSIX_SHELL_EXECUTABLE_ENV,
} from "./lib/unix-process-tools.mjs";
import {
  inspectNodeDependencyInstall,
  installNodeDependencies,
  requireCurrentNodeDependencyInstall,
} from "./node-dependency-preflight.mjs";

const workspaces = [];
const script = fileURLToPath(
  new URL("./node-dependency-preflight.mjs", import.meta.url),
);

function fixture({ installedLock, projectLock = "lockfileVersion: '9.0'\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-node-dependency-preflight-"));
  workspaces.push(root);
  writeFileSync(join(root, "pnpm-lock.yaml"), projectLock);
  if (installedLock !== undefined) {
    mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), installedLock);
  }
  return root;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { force: true, recursive: true });
  }
});

describe("node dependency preflight", () => {
  it("accepts node_modules installed from the exact project lockfile", () => {
    const lockfile = "lockfileVersion: '9.0'\npackages: {}\n";
    const root = fixture({ installedLock: lockfile, projectLock: lockfile });

    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "current",
      ok: true,
    });
    expect(() => requireCurrentNodeDependencyInstall(root)).not.toThrow();
  });

  it("accepts the same lockfile across Windows checkout line endings", () => {
    const root = fixture({
      installedLock: "lockfileVersion: '9.0'\npackages: {}\n",
      projectLock: "lockfileVersion: '9.0'\r\npackages: {}\r\n",
    });

    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "current",
      ok: true,
    });
    const before = requireCurrentNodeDependencyInstall(root).fingerprint;
    expect(before).toMatch(/^pnpm-lock-v1:[0-9a-f]{64}$/);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
    expect(requireCurrentNodeDependencyInstall(root).fingerprint).toBe(before);
  });

  it("binds the validated dependency graph including changed patch hashes", () => {
    const oldLock = "lockfileVersion: '9.0'\npatchedDependencies:\n  fixture@1:\n    hash: old\n";
    const root = fixture({ installedLock: oldLock, projectLock: oldLock });
    const before = requireCurrentNodeDependencyInstall(root).fingerprint;
    expect(before).toMatch(/^pnpm-lock-v1:[0-9a-f]{64}$/);
    const next = oldLock.replace("hash: old", "hash: new");
    writeFileSync(join(root, "pnpm-lock.yaml"), next);
    expect(() => requireCurrentNodeDependencyInstall(root)).toThrow(/different pnpm-lock/);
    writeFileSync(join(root, "node_modules/.pnpm/lock.yaml"), next);
    expect(requireCurrentNodeDependencyInstall(root).fingerprint).not.toBe(before);
  });

  it("fails early with an actionable install command when node_modules is absent", () => {
    const root = fixture();

    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "installed_lock_missing",
      ok: false,
    });
    expect(() => requireCurrentNodeDependencyInstall(root)).toThrowError(
      /node_dependency_preflight_failed[\s\S]*corepack pnpm install --frozen-lockfile/,
    );
  });

  it("rejects node_modules installed from a stale lockfile", () => {
    const root = fixture({
      installedLock: "lockfileVersion: '9.0'\npackages: {}\n",
      projectLock: "lockfileVersion: '9.0'\npackages:\n  dependency-cruiser: {}\n",
    });

    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "installed_lock_mismatch",
      ok: false,
    });
    expect(() => requireCurrentNodeDependencyInstall(root)).toThrowError(
      /different pnpm-lock\.yaml[\s\S]*corepack pnpm install --frozen-lockfile/,
    );

    const cli = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(
      /node_dependency_preflight_failed[\s\S]*corepack pnpm install --frozen-lockfile/,
    );
  });

  it("repairs a stale install through the frozen-install boundary", () => {
    const root = fixture({
      installedLock: "lockfileVersion: '9.0'\npackages: {}\n",
      projectLock: "lockfileVersion: '9.0'\npackages:\n  @bufbuild/protobuf: {}\n",
    });
    // Ambient corepack is the install boundary now; shadow it on PATH so the
    // fixture observes the exact frozen-lockfile invocation.
    const shimBin = join(root, "shim-bin");
    mkdirSync(shimBin, { recursive: true });
    const corepack = join(shimBin, "corepack");
    writeFileSync(
      corepack,
      "#!/bin/sh\n" +
        'test "$*" = "pnpm install --frozen-lockfile --force" || exit 44\n' +
        "mkdir -p node_modules/.pnpm\n" +
        "cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml\n" +
        'printf "%s\\n" "$*" > install-args.txt\n',
    );
    chmodSync(corepack, 0o755);

    const cli = spawnSync(process.execPath, [script, "--install"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(cli.status, cli.stderr).toBe(0);
    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "current",
      ok: true,
    });
    expect(readFileSync(join(root, "install-args.txt"), "utf8").trim()).toBe(
      "pnpm install --frozen-lockfile --force",
    );
  });

  it("repairs through the explicitly supplied release environment", () => {
    const root = fixture({
      installedLock: "lockfileVersion: '9.0'\npackages: {}\n",
      projectLock: "lockfileVersion: '9.0'\npackages:\n  vitest: {}\n",
    });
    const shimBin = join(root, "shim-bin");
    const isolatedHome = join(root, "release-home");
    const isolatedCorepack = join(root, "release-corepack");
    const isolatedTemp = join(root, "release-tmp");
    mkdirSync(shimBin, { recursive: true });
    for (const directory of [isolatedHome, isolatedCorepack, isolatedTemp]) {
      mkdirSync(directory);
    }
    const corepack = join(shimBin, "corepack");
    const packageScriptShell = "/nix/store/dure-shell/bin/sh";
    writeFileSync(
      corepack,
      "#!/bin/sh\n" +
        'test "$*" = "pnpm install --frozen-lockfile --force" || exit 44\n' +
        'printf "%s\\n" "$HOME|$COREPACK_HOME|$TMPDIR|$DURE_POSIX_SHELL|$npm_config_script_shell" > install-env.txt\n' +
        "mkdir -p node_modules/.pnpm\n" +
        "cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml\n",
    );
    chmodSync(corepack, 0o755);

    installNodeDependencies(root, {
      ...process.env,
      COREPACK_HOME: isolatedCorepack,
      [COREPACK_EXECUTABLE_ENV]: corepack,
      [POSIX_SHELL_EXECUTABLE_ENV]: packageScriptShell,
      [PACKAGE_SCRIPT_SHELL_ENV]: packageScriptShell,
      HOME: isolatedHome,
      TMPDIR: isolatedTemp,
    });

    expect(readFileSync(join(root, "install-env.txt"), "utf8").trim()).toBe(
      `${isolatedHome}|${isolatedCorepack}|${isolatedTemp}|${packageScriptShell}|${packageScriptShell}`,
    );
    expect(inspectNodeDependencyInstall(root)).toMatchObject({
      code: "current",
      ok: true,
    });
  });
});

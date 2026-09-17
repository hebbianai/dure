import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readProcessCwd,
  resolveExecutableFile,
  resolveLsofExecutable,
  resolvePosixShellExecutable,
  resolveUnixDevChainTools,
} from "./unix-process-tools.mjs";

const ALTERNATE_BIN = "/nix/store/dure-tools/bin";
const ALTERNATE_TOOLS = Object.freeze({
  ps: `${ALTERNATE_BIN}/ps`,
  lsof: `${ALTERNATE_BIN}/lsof`,
  env: `${ALTERNATE_BIN}/env`,
  sh: `${ALTERNATE_BIN}/sh`,
});

describe("Unix process tools", () => {
  it("resolves one immutable dev-chain capability from absolute PATH entries", () => {
    const executablePaths = new Set(Object.values(ALTERNATE_TOOLS));
    const considered = [];
    const capability = resolveUnixDevChainTools({
      platform: "linux",
      environment: { PATH: ["relative-bin", ALTERNATE_BIN].join(delimiter) },
      resolveExecutablePath: (pathname) => {
        considered.push(pathname);
        return executablePaths.has(pathname) ? pathname : null;
      },
    });

    expect(capability).toEqual({
      status: "available",
      observationStatus: "available",
      tools: {
        processCensusExecutable: ALTERNATE_TOOLS.ps,
        processCwdExecutable: ALTERNATE_TOOLS.lsof,
        portCensusExecutable: ALTERNATE_TOOLS.lsof,
        environmentExecutable: ALTERNATE_TOOLS.env,
        shellExecutable: ALTERNATE_TOOLS.sh,
      },
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.tools)).toBe(true);
    expect(considered).toEqual(Object.values(ALTERNATE_TOOLS));
  });

  it.each([
    {
      label: "process census",
      available: [
        ALTERNATE_TOOLS.lsof,
        ALTERNATE_TOOLS.env,
        ALTERNATE_TOOLS.sh,
      ],
      missing: ["process census (ps)"],
      observationMissing: ["process census (ps)"],
    },
    {
      label: "process cwd and port census",
      available: [
        ALTERNATE_TOOLS.ps,
        ALTERNATE_TOOLS.env,
        ALTERNATE_TOOLS.sh,
      ],
      missing: ["process cwd (lsof)", "port census (lsof)"],
      observationMissing: ["process cwd (lsof)", "port census (lsof)"],
    },
    {
      label: "environment launch",
      available: [
        ALTERNATE_TOOLS.ps,
        ALTERNATE_TOOLS.lsof,
        ALTERNATE_TOOLS.sh,
      ],
      missing: ["environment launch (env)"],
      observationMissing: [],
    },
    {
      label: "POSIX shell",
      available: [
        ALTERNATE_TOOLS.ps,
        ALTERNATE_TOOLS.lsof,
        ALTERNATE_TOOLS.env,
      ],
      missing: ["POSIX shell (sh)"],
      observationMissing: [],
    },
  ])("reports unavailable when $label is missing", ({
    available,
    missing,
    observationMissing,
  }) => {
    const executablePaths = new Set(available);
    const capability = resolveUnixDevChainTools({
      platform: "linux",
      environment: { PATH: ALTERNATE_BIN },
      resolveExecutablePath: (pathname) =>
        executablePaths.has(pathname) ? pathname : null,
    });
    expect(capability).toEqual({
      status: "unavailable",
      observationStatus:
        observationMissing.length === 0 ? "available" : "unavailable",
      tools: {
        processCensusExecutable: executablePaths.has(ALTERNATE_TOOLS.ps)
          ? ALTERNATE_TOOLS.ps
          : null,
        processCwdExecutable: executablePaths.has(ALTERNATE_TOOLS.lsof)
          ? ALTERNATE_TOOLS.lsof
          : null,
        portCensusExecutable: executablePaths.has(ALTERNATE_TOOLS.lsof)
          ? ALTERNATE_TOOLS.lsof
          : null,
        environmentExecutable: executablePaths.has(ALTERNATE_TOOLS.env)
          ? ALTERNATE_TOOLS.env
          : null,
        shellExecutable: executablePaths.has(ALTERNATE_TOOLS.sh)
          ? ALTERNATE_TOOLS.sh
          : null,
      },
      ...(observationMissing.length === 0
        ? {}
        : {
            observationReason:
              `required Unix tools are unavailable: ${observationMissing.join(", ")}`,
          }),
      missing,
      reason: `required Unix tools are unavailable: ${missing.join(", ")}`,
    });
    expect(Object.isFrozen(capability.tools)).toBe(true);
  });

  it("does not advertise Unix tooling on Windows", () => {
    expect(resolveUnixDevChainTools({ platform: "win32" })).toEqual({
      status: "unavailable",
      observationStatus: "unavailable",
      tools: {
        processCensusExecutable: null,
        processCwdExecutable: null,
        portCensusExecutable: null,
        environmentExecutable: null,
        shellExecutable: null,
      },
      observationReason:
        "required Unix tools are unavailable: Unix process adapter",
      missing: ["Unix process adapter"],
      reason: "required Unix tools are unavailable: Unix process adapter",
    });
  });

  it("canonicalizes executable files and rejects unsafe filesystem entries", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-unix-tools-"));
    const executable = join(root, "executable");
    const link = join(root, "link");
    const nonExecutable = join(root, "non-executable");
    const emptyExecutable = join(root, "empty-executable");
    const directory = join(root, "directory");
    try {
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
      symlinkSync(executable, link);
      writeFileSync(nonExecutable, "not executable\n", { mode: 0o600 });
      chmodSync(nonExecutable, 0o600);
      writeFileSync(emptyExecutable, "", { mode: 0o700 });
      mkdirSync(directory);

      expect(resolveExecutableFile(link)).toBe(realpathSync(executable));
      expect(resolveExecutableFile(nonExecutable)).toBeNull();
      expect(resolveExecutableFile(emptyExecutable)).toBeNull();
      expect(resolveExecutableFile(directory)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a validated shell alias for multicall executables", () => {
    const alias = "/fixture/bin/sh";
    expect(
      resolvePosixShellExecutable({
        platform: "linux",
        environment: { PATH: "/fixture/bin" },
        resolveExecutablePath: (pathname) =>
          pathname === alias ? "/fixture/bin/busybox" : null,
      }),
    ).toBe(alias);
  });

  it("resolves lsof through the same executable boundary", () => {
    expect(
      resolveLsofExecutable({
        platform: "linux",
        environment: { PATH: ALTERNATE_BIN },
        resolveExecutablePath: (pathname) =>
          pathname === ALTERNATE_TOOLS.lsof ? pathname : null,
      }),
    ).toBe(ALTERNATE_TOOLS.lsof);
    expect(
      resolveLsofExecutable({
        platform: "linux",
        environment: { PATH: ALTERNATE_BIN },
        resolveExecutablePath: (pathname) =>
          pathname === ALTERNATE_TOOLS.lsof
            ? "/nix/store/dure-tools-real/bin/lsof"
            : null,
      }),
    ).toBe("/nix/store/dure-tools-real/bin/lsof");
    expect(
      resolveLsofExecutable({ resolveExecutablePath: () => null }),
    ).toBeNull();
  });

  it("reads a process cwd through the selected executable", () => {
    const calls = [];
    const cwd = readProcessCwd(42, {
      executable: ALTERNATE_TOOLS.lsof,
      execute: (command, arguments_, options) => {
        calls.push({ command, arguments_, options });
        return "p42\nfcwd\nn/repo/.worktrees/feature\n";
      },
    });

    expect(cwd).toBe("/repo/.worktrees/feature");
    expect(calls).toEqual([
      {
        command: ALTERNATE_TOOLS.lsof,
        arguments_: ["-nP", "-a", "-p", "42", "-d", "cwd", "-Fn"],
        options: { encoding: "utf8", timeout: 10_000 },
      },
    ]);
  });

  it("does not invoke a command when lsof is unavailable", () => {
    let invoked = false;
    expect(
      readProcessCwd(42, {
        executable: null,
        execute: () => {
          invoked = true;
        },
      }),
    ).toBeUndefined();
    expect(invoked).toBe(false);
  });
});

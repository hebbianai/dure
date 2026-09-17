import { describe, expect, it } from "vitest";
import { corepackInstallInvocation } from "./corepack-install.mjs";

describe("corepack install invocation", () => {
  it("uses the executable directly outside Windows", () => {
    expect(
      corepackInstallInvocation({
        packageManager: "pnpm@10.34.5",
        platform: "darwin",
      }),
    ).toEqual({
      file: "corepack",
      arguments: [
        "pnpm@10.34.5",
        "--config.node-linker=hoisted",
        "install",
        "--frozen-lockfile",
        "--prod",
        "--ignore-scripts",
      ],
    });
  });

  it("uses an exact executable capability outside Windows", () => {
    expect(
      corepackInstallInvocation({
        packageManager: "pnpm@10.34.5",
        platform: "linux",
        environment: {
          DURE_COREPACK_EXECUTABLE: "/nix/store/corepack/bin/corepack",
        },
      }).file,
    ).toBe("/nix/store/corepack/bin/corepack");
  });

  it("enters the Windows command interpreter without interpolating paths", () => {
    expect(
      corepackInstallInvocation({
        packageManager: "pnpm@10.34.5",
        platform: "win32",
        commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/s",
        "/c",
        "corepack",
        "pnpm@10.34.5",
        "--config.node-linker=hoisted",
        "install",
        "--frozen-lockfile",
        "--prod",
        "--ignore-scripts",
      ],
    });
  });

  it("rejects an unpinned package-manager selector", () => {
    expect(() =>
      corepackInstallInvocation({ packageManager: "pnpm@latest" }),
    ).toThrow(/exactly pinned/i);
  });
});

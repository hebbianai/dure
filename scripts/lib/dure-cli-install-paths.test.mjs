import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuiltDureControlPlane } from "./dure-cli-install-paths.mjs";

describe("Dure CLI install paths", () => {
  it("uses Cargo's configured target directory", () => {
    expect(
      resolveBuiltDureControlPlane({
        cargoTargetDirectory: "/runner/targets/verify",
        command: "dure-control-plane",
        repositoryRoot: "/repo",
      }),
    ).toBe(join(resolve("/runner/targets/verify"), "release", "dure-control-plane"));
  });

  it("resolves relative Cargo target directories from the build cwd", () => {
    expect(
      resolveBuiltDureControlPlane({
        cargoTargetDirectory: "runner-target",
        command: "dure-control-plane",
        repositoryRoot: "/repo",
      }),
    ).toBe(join(resolve("/repo", "runner-target"), "release", "dure-control-plane"));
  });

  it("keeps the workspace-local default when Cargo has no override", () => {
    expect(
      resolveBuiltDureControlPlane({
        command: "dure-control-plane.exe",
        repositoryRoot: "/repo",
      }),
    ).toBe(
      join(
        "/repo",
        "crates",
        "dure-app",
        "target",
        "release",
        "dure-control-plane.exe",
      ),
    );
  });
});

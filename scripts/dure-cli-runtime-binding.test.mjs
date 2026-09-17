import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bindBundledDureRuntime } from "../cli/lib/dure-cli-bundled-runtime.mjs";
import { resolveHmuxToolchainIdentity } from "../cli/lib/local-backend.mjs";
import {
  createDureCliInstallerFixture,
  dureCliInstallerFixtureEnvironment,
  writeControlPlaneFixture,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

let root;
let cli;
let hmux;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-runtime-binding-"));
  fs.mkdirSync(path.join(root, "discovery"), { mode: 0o700 });
  const repository = createDureCliInstallerFixture(root);
  const installRoot = path.join(root, "installed");
  hmux = path.join(root, "control-plane-fixture");
  writeControlPlaneFixture(hmux);
  execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
    cwd: repository,
    env: dureCliInstallerFixtureEnvironment(repository, scriptTestEnvironment({
      HOME: root,
      DURE_HOME: path.join(root, ".dure"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      DURE_APP_CHANNEL: "dev-runtime-binding",
      DURE_CLI_INSTALL_ROOT: installRoot,
      DURE_CLI_INSTALL_DIR: path.join(root, "bin"),
      DURE_CONTROL_PLANE_BIN: hmux,
      DURE_HMUX_BIN: hmux,
      DURE_HMUX_RUNTIME_BIN: hmux,
      DURE_HMUX_BUILD_ID: "hmux-runtime-binding-test",
    })),
    stdio: "pipe",
    timeout: 30_000,
  });
  const version = fs.realpathSync(path.join(installRoot, "current"));
  expect(JSON.parse(fs.readFileSync(path.join(version, "install.json"))).bundle.hmux.schemaVersion).toBe(1);
  expect(fs.existsSync(path.join(version, "bin", "node"))).toBe(false);
  cli = path.join(version, "bin", "dure.mjs");
}, 30_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it.each([undefined, "/missing-ambient-hmux"])(
  "resolves the installed development Hmux tuple with ambient path %s",
  (ambient) => {
    const environment = scriptTestEnvironment({
      HOME: root,
      DURE_HOME: path.join(root, ".dure"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      PATH: path.dirname(process.execPath),
      DURE_HMUX_BIN: ambient,
      DURE_HMUX_RUNTIME_BIN: ambient,
    });
    bindBundledDureRuntime(cli, environment);
    const identity = resolveHmuxToolchainIdentity(environment);
    expect(identity.executablePath).toBe(fs.realpathSync(hmux));
    expect(identity.runtimeExecutablePath).toBe(fs.realpathSync(hmux));
    expect(identity.discoveryRoot).toBe(fs.realpathSync(path.join(root, "discovery")));
  },
);

it("preserves explicit runtime configuration for a source-checkout CLI", () => {
  const environment = { DURE_HMUX_BIN: "/source-hmux", DURE_HMUX_RUNTIME_BIN: "/source-runtime" };
  const before = { ...environment };
  bindBundledDureRuntime(path.resolve("cli/dure.mjs"), environment);
  expect(environment).toEqual(before);
});

it("refuses a portable runtime with missing install metadata", () => {
  const bin = path.join(root, "portable-without-metadata", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "node"), "fixture-node");
  fs.writeFileSync(path.join(bin, "dure.mjs"), "");
  expect(() => bindBundledDureRuntime(path.join(bin, "dure.mjs"), {})).toThrow();
});

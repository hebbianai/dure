import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDureCliInstallerFixture } from "./lib/dure-cli-install-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(arguments_, environment = {}) {
  const home = mkdtempSync(join(tmpdir(), "dure-cli-development-build-"));
  roots.push(home);
  const repository = createDureCliInstallerFixture(home);
  // This fixture observes the installer's actual build invocation. It neither
  // compiles native code nor reserves storage for a compiler that cannot run.
  writeFileSync(join(repository, "scripts/lib/build-storage-admission.mjs"),
    "export function ensureHeadroom() { return { ok: true }; }\n");
  const bin = join(home, "bin");
  mkdirSync(bin);
  const receipt = join(home, "cargo.json");
  writeFileSync(join(bin, "cargo"), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
process.exit(71);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ["scripts/install-dure-cli.mjs", ...arguments_], {
    cwd: repository,
    encoding: "utf8",
    env: scriptTestEnvironment({
      HOME: home,
      DURE_HOME: join(home, "data"),
      HMUX_DISCOVERY_ROOT: join(home, "discovery"),
      DURE_NATIVE_BUILD_SLOT_ROOT: join(home, "native-slot"),
      DURE_CLI_INSTALL_ROOT: join(home, "installed"),
      DURE_CLI_INSTALL_DIR: join(home, "commands"),
      DURE_APP_CHANNEL: "dev-browser-fixture",
      PATH: `${bin}:${process.env.PATH}`,
      ...environment,
    }),
  });
  let cargo;
  try { cargo = JSON.parse(readFileSync(receipt, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { result, cargo };
}

it("builds the explicitly selected development Browser in the optimized backend", () => {
  const { result, cargo } = invoke(["--development"]);
  expect(result.status).not.toBe(0);
  expect(cargo).toEqual([
    "build", "--release", "--locked", "--manifest-path", expect.any(String),
    "--package", "dure-control-plane", "--features", "browser-development",
  ]);
});

it("keeps ordinary installations Basic-only even with a development channel name", () => {
  const { cargo } = invoke([]);
  expect(cargo).toEqual([
    "build", "--release", "--locked", "--manifest-path", expect.any(String),
    "--package", "dure-control-plane",
  ]);
});

it("prepares development agent tools with the same explicit Browser build", () => {
  const home = mkdtempSync(join(tmpdir(), "dure-cli-development-prepare-"));
  roots.push(home);
  const scripts = join(home, "scripts");
  mkdirSync(scripts);
  copyFileSync("scripts/prepare-agent-tools.sh", join(scripts, "prepare-agent-tools.sh"));
  for (const [name, contents] of Object.entries({
    "hmux-dev-build-id.mjs": 'console.log("fixture-build");',
    "resolve-dev-app-channel.mjs": 'console.log("dev-browser-fixture");',
    "dev-agent-tools-current.mjs": 'process.exit(process.argv.includes("--verify") ? 0 : 1);',
    "prepare-hmux-dev-tools.sh": "exit 0\n",
    "install-dure-cli.mjs": 'import fs from "node:fs"; fs.writeFileSync("install-args.json", JSON.stringify(process.argv.slice(2)));',
  })) writeFileSync(join(scripts, name), contents);
  const environment = scriptTestEnvironment({ HOME: home, DURE_HOME: join(home, "data") });
  execFileSync("git", ["init", "--quiet", home], { env: environment });
  execFileSync("sh", ["scripts/prepare-agent-tools.sh"], { cwd: home, env: environment });
  expect(JSON.parse(readFileSync(join(home, "install-args.json"), "utf8")))
    .toEqual(["--development"]);
});

it.each([
  [["--development"], { DURE_APP_CHANNEL: "stable" }],
  [["--development"], { DURE_APP_CHANNEL: "" }],
  [["--development"], { DURE_CONTROL_PLANE_BIN: "/unverified/backend" }],
  [["--development", "--bundle", "/uncreated/browser-bundle"], {}],
  [["--bundle", "/uncreated/browser-bundle", "--development"], {}],
])("rejects unsupported development installation inputs before any build: %j", (args, environment) => {
  const { result, cargo } = invoke(args, environment);
  expect(result.status).not.toBe(0);
  expect(cargo).toBeUndefined();
});

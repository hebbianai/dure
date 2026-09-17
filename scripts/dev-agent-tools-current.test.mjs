import { spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID, CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION, CONTROL_PLANE_IDENTITY_KIND,
} from "../cli/lib/control-plane-contract.mjs";
import { devAgentToolsCurrent } from "./dev-agent-tools-current.mjs";
import {
  createDureCliInstallerFixture, dureCliInstallerFixtureEnvironment,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const temporaryRoots = [];
const channel = "dev-startup-fixture";
const hmuxBuildId = "hmux-test-v1";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dure-dev-tools-"));
  temporaryRoots.push(home);
  const root = createDureCliInstallerFixture(home);
  const scripts = join(root, "scripts");
  const controlPlane = join(home, "dure-control-plane");
  const identity = {
    schemaVersion: 1,
    apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
    kind: CONTROL_PLANE_IDENTITY_KIND,
    buildId: CONTROL_PLANE_BUILD_ID,
    capabilities: CONTROL_PLANE_CAPABILITIES,
  };
  writeFileSync(controlPlane,
    `#!/bin/sh\n[ "$1" = identity ] || exit 64\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
    { mode: 0o755 });
  writeFileSync(join(home, "dure-claude-process-relay"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const name of ["prepare-agent-tools.sh", "dev-agent-tools-current.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), join(scripts, name));
  }
  writeFileSync(join(scripts, "hmux-dev-build-id.mjs"), `console.log(${JSON.stringify(hmuxBuildId)});\n`);
  writeFileSync(join(scripts, "resolve-dev-app-channel.mjs"), `console.log(${JSON.stringify(channel)});\n`);
  const hmuxBin = join(home, ".local/share/hmux/channels", channel, "bin");
  mkdirSync(hmuxBin, { recursive: true });
  writeFileSync(join(scripts, "stage-fixture.mjs"), `
import { appendFileSync, copyFileSync } from "node:fs";
appendFileSync(process.env.DURE_TEST_PREPARE_EVENTS, "hmux\\n");
for (const name of ["hmux", "hmux-runtime"]) {
  copyFileSync(process.env.DURE_TEST_CONTROL_PLANE_FIXTURE, ${JSON.stringify(hmuxBin)} + "/" + name);
}
`);
  writeFileSync(join(scripts, "prepare-hmux-dev-tools.sh"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(scripts, "stage-fixture.mjs")}"\n`);
  // Model the source-build invocation without compiling or reserving native storage.
  writeFileSync(join(scripts, "lib/build-storage-admission.mjs"),
    "export function ensureHeadroom() { return { ok: true }; }\n");
  writeFileSync(join(root, ".test-bin/cargo"), `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { copyFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
assert.deepEqual(process.argv.slice(2), [
  "build", "--release", "--locked", "--manifest-path",
  ${JSON.stringify(join(realpathSync(root), "crates/dure-app/Cargo.toml"))},
  "--package", "dure-control-plane", "--features", "browser-development",
]);
const release = join(process.env.CARGO_TARGET_DIR, "release");
mkdirSync(release, { recursive: true });
for (const name of ["dure-control-plane", "dure-claude-process-relay"]) {
  copyFileSync(join(dirname(process.env.DURE_TEST_CONTROL_PLANE_FIXTURE), name), join(release, name));
}
`, { mode: 0o755 });
  const environment = dureCliInstallerFixtureEnvironment(root, scriptTestEnvironment({
    HOME: home, DURE_HOME: join(home, ".dure"),
    HMUX_DISCOVERY_ROOT: join(home, "discovery"),
    DURE_APP_CHANNEL: channel,
    DURE_TEST_CONTROL_PLANE_FIXTURE: controlPlane,
    CARGO_TARGET_DIR: join(home, "cargo-target"),
    DURE_TEST_PREPARE_EVENTS: join(home, "events"),
  }));
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root, env: environment }).status).toBe(0);
  // Fixture Git work must finish before afterEach removes its owned repository.
  for (const [key, value] of [["maintenance.auto", "false"], ["gc.auto", "0"]]) {
    expect(spawnSync("git", ["config", "--local", key, value], { cwd: root, env: environment }).status).toBe(0);
  }
  const prepare = () => spawnSync("/bin/sh", [join(scripts, "prepare-agent-tools.sh")], {
    cwd: root, env: environment, encoding: "utf8", timeout: 20_000,
  });
  const commit = () => {
    for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"]]) {
      const result = spawnSync("git", args, { cwd: root, env: environment, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  };
  writeFileSync(join(root, ".gitignore"), ".test-corepack-invoked\n");
  commit();
  const current = (options = {}) => devAgentToolsCurrent({
    root, home, channel, hmuxBuildId, environment, ...options,
  });
  const installed = join(home, ".local/share/hebbian-ide-cli/channels", channel, "current");
  return { root, scripts, home, prepare, current, installed, environment, commit };
}

describe.skipIf(process.platform === "win32")("development agent tool admission", () => {
  it("prepares a missing channel once and reuses the verified bundle without installers", () => {
    const f = fixture();
    expect(f.current()).toBe(false);
    const cold = f.prepare();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    expect(f.current()).toBe(true);
    const installed = realpathSync(f.installed);
    const warm = f.prepare();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(warm.stdout).toContain("reusing the verified channel bundle");
    expect(realpathSync(f.installed)).toBe(installed);
    expect(readFileSync(f.environment.DURE_TEST_PREPARE_EVENTS, "utf8")).toBe("hmux\n");
    expect(existsSync(join(f.home, ".dure"))).toBe(false);
    expect(existsSync(f.environment.HMUX_DISCOVERY_ROOT)).toBe(false);
    expect(existsSync(join(f.home, ".local/bin"))).toBe(false);

    appendFileSync(join(f.root, "cli/dure.mjs"), "\n// changed launch source\n");
    expect(f.current()).toBe(false);
    writeFileSync(join(f.scripts, "install-dure-cli.mjs"), "throw new Error('fixture preparation failed');\n");
    const failed = f.prepare();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("fixture preparation failed");
    expect(realpathSync(f.installed)).toBe(installed);
  });

  it("upgrades an intact old CLI bundle and rejects stale, damaged or cross-channel tools", () => {
    const f = fixture();
    const manifestPath = join(f.root, "cli/package.json");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), version: "0.1.4" }));
    f.commit();
    const old = f.prepare();
    expect(old.status, old.stdout + old.stderr).toBe(0);
    const oldVersion = realpathSync(f.installed);
    writeFileSync(manifestPath, manifest);
    expect(f.current()).toBe(false);
    f.commit();
    const upgrade = f.prepare();
    expect(upgrade.status, upgrade.stdout + upgrade.stderr).toBe(0);
    expect(f.current()).toBe(true);
    expect(realpathSync(f.installed)).not.toBe(oldVersion);
    expect(f.current({ hmuxBuildId: "hmux-next" })).toBe(false);
    expect(f.current({ channel: "dev-other" })).toBe(false);
    expect(f.current({ channel: "stable" })).toBe(false);
    appendFileSync(join(f.installed, "bin/dure-control-plane"), "\n# corrupted\n");
    expect(f.current()).toBe(false);
  });

  it("reuses a frontend-only revision but prepares native changes even without a contract version bump", () => {
    const f = fixture();
    const cold = f.prepare();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    mkdirSync(join(f.root, "src"));
    writeFileSync(join(f.root, "src/frontend.ts"), "export const label = 'new';\n");
    f.commit();
    expect(f.current()).toBe(true);
    const nativeSource = join(f.root, "crates/dure-app/control-plane/src/main.rs");
    appendFileSync(nativeSource, "\n// native implementation changed\n");
    expect(f.current()).toBe(false);
    f.commit();
    expect(f.current()).toBe(false);
  });

  it("does not admit a successful installer that leaves the channel incomplete", () => {
    const f = fixture();
    writeFileSync(join(f.scripts, "install-dure-cli.mjs"), "process.exit(0);\n");
    const incomplete = f.prepare();
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain("not ready after preparation; app launch was not admitted");
    expect(f.current()).toBe(false);
  });
});

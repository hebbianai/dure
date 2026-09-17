import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devHmuxToolPaths } from "./app-channel.mjs";
import { DEV_HMUX_STANDALONE_OPERATION_CAPABILITY } from "./dev-hmux-operation-contract.mjs";
import { ensureDevHmuxTool } from "./dev-hmux-tool.mjs";

const roots = [];

function installFixture(
  home,
  channel,
  capabilities,
  { buildId = "0.1.4+dev.tool-fixture", activate = true } = {},
) {
  const paths = devHmuxToolPaths(home, channel);
  const version = join(paths.installRoot, "versions", buildId);
  const executable = join(version, "bin", "hmux");
  const runtime = join(version, "bin", "hmux-runtime");
  const capabilityFile = join(version, "capabilities.json");
  mkdirSync(join(version, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.commandDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(version, "install.json"),
    `${JSON.stringify({ schemaVersion: 1, buildId })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    capabilityFile,
    JSON.stringify({
      schemaVersion: 2,
      buildInfo: { buildId, source: "hmux_cli" },
      capabilities,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(require(${JSON.stringify(capabilityFile)})));\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    runtime,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({schemaVersion:1,buildId:${JSON.stringify(buildId)},source:"hmux_runtime"}));\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  chmodSync(runtime, 0o700);
  if (activate) {
    const current = join(paths.installRoot, "current");
    if (existsSync(paths.hmuxCommand)) unlinkSync(paths.hmuxCommand);
    if (existsSync(current)) unlinkSync(current);
    symlinkSync(`versions/${buildId}`, current);
    symlinkSync(join(current, "bin", "hmux"), paths.hmuxCommand);
  }
  return { buildId, executable, runtime, capabilityFile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("development Hmux tool authority", () => {
  it("prepares one exact target build instead of reusing an older capable build", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-tool-"));
    roots.push(home);
    const channel = "dev-tool-fixture-1234567890";
    installFixture(home, channel, [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY], {
      buildId: "0.1.4+dev.old-fixture",
    });
    const targetBuildId = "0.1.4+dev.target-fixture";
    const shellExecutable = "/nix/store/dure-tools/bin/sh";
    let target;
    let preparations = 0;

    const executable = ensureDevHmuxTool(
      {
        root: "/repo",
        home,
        channel,
        expectedBuildId: targetBuildId,
        shellExecutable,
      },
      {
        prepare: (request) => {
          preparations += 1;
          expect(request).toMatchObject({
            channel,
            expectedBuildId: targetBuildId,
            shellExecutable,
          });
          target = installFixture(
            home,
            channel,
            [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY],
            { buildId: targetBuildId, activate: false },
          );
        },
      },
    );

    expect(preparations).toBe(1);
    expect(executable).toBe(realpathSync(target.executable));
  });

  it("rejects a mislabeled exact build without preparing over it", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-mismatch-"));
    roots.push(home);
    const channel = "dev-tool-mismatch-1234567890";
    const fixture = installFixture(
      home,
      channel,
      [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY],
      { buildId: "0.1.4+dev.expected-fixture" },
    );
    writeFileSync(
      fixture.capabilityFile,
      JSON.stringify({
        schemaVersion: 2,
        buildInfo: { buildId: "0.1.4+dev.other-fixture", source: "hmux_cli" },
        capabilities: [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY],
      }),
    );
    let preparations = 0;

    expect(() =>
      ensureDevHmuxTool(
        {
          root: "/repo",
          home,
          channel,
          expectedBuildId: fixture.buildId,
        },
        { prepare: () => (preparations += 1) },
      ),
    ).toThrow("not self-consistent");
    expect(preparations).toBe(0);
  });

  it("leaves runtime resolution to an operation that reaches a new launch", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-lazy-runtime-"));
    roots.push(home);
    const channel = "dev-lazy-runtime-1234567890";
    const fixture = installFixture(
      home,
      channel,
      [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY],
      { buildId: "0.1.4+dev.lazy-runtime" },
    );
    unlinkSync(fixture.runtime);
    let preparations = 0;

    expect(
      ensureDevHmuxTool(
        {
          root: "/repo",
          home,
          channel,
          expectedBuildId: fixture.buildId,
        },
        { prepare: () => (preparations += 1) },
      ),
    ).toBe(realpathSync(fixture.executable));
    expect(preparations).toBe(0);
  });

  it("contains preparation output larger than the queued executor buffer", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-output-home-"));
    const root = mkdtempSync(join(tmpdir(), "dure-dev-hmux-output-root-"));
    roots.push(home, root);
    const channel = "dev-output-bound-1234567890";
    const buildId = "0.1.4+dev.output-bound";
    const shellExecutable = "/nix/store/dure-tools/bin/sh";
    const paths = devHmuxToolPaths(home, channel);
    const version = join(paths.installRoot, "versions", buildId);
    const executable = join(version, "bin", "hmux");
    const runtime = join(version, "bin", "hmux-runtime");
    const capabilities = join(version, "capabilities.json");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "run-with-build-storage.mjs"),
      `import fs from "node:fs";
if (process.argv[4] !== ${JSON.stringify(shellExecutable)}) throw new Error("wrong shell argument");
if (process.env.DURE_POSIX_SHELL !== ${JSON.stringify(shellExecutable)}) throw new Error("wrong nested shell");
fs.mkdirSync(${JSON.stringify(join(version, "bin"))}, { recursive: true, mode: 0o700 });
fs.writeFileSync(${JSON.stringify(join(version, "install.json"))}, ${JSON.stringify(`${JSON.stringify({ schemaVersion: 1, buildId })}\n`)}, { mode: 0o600 });
fs.writeFileSync(${JSON.stringify(capabilities)}, ${JSON.stringify(JSON.stringify({ schemaVersion: 2, buildInfo: { buildId, source: "hmux_cli" }, capabilities: [DEV_HMUX_STANDALONE_OPERATION_CAPABILITY] }))}, { mode: 0o600 });
fs.writeFileSync(${JSON.stringify(executable)}, ${JSON.stringify(`#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(require(${JSON.stringify(capabilities)})));\n`)}, { mode: 0o700 });
fs.writeFileSync(${JSON.stringify(runtime)}, ${JSON.stringify(`#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({schemaVersion:1,buildId:${JSON.stringify(buildId)},source:"hmux_runtime"}));\n`)}, { mode: 0o700 });
process.stderr.write("x".repeat(2 * 1024 * 1024));
`,
    );

    expect(
      ensureDevHmuxTool({
        root,
        home,
        channel,
        expectedBuildId: buildId,
        shellExecutable,
        timeoutMs: 5_000,
      }),
    ).toBe(realpathSync(executable));
  });

  it("bounds a hung exact-build preparation", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-timeout-home-"));
    const root = mkdtempSync(join(tmpdir(), "dure-dev-hmux-timeout-root-"));
    roots.push(home, root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "run-with-build-storage.mjs"),
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);\n",
    );
    const startedAtMs = Date.now();

    expect(() =>
      ensureDevHmuxTool({
        root,
        home,
        channel: "dev-prepare-timeout-1234567890",
        expectedBuildId: "0.1.4+dev.prepare-timeout",
        timeoutMs: 50,
      }),
    ).toThrow(/timed out|ETIMEDOUT/i);
    expect(Date.now() - startedAtMs).toBeLessThan(2_000);
  });

  it("rejects a hung exact capability probe without rebuilding over it", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-hmux-tool-hung-"));
    roots.push(home);
    const channel = "dev-tool-hung-1234567890";
    const fixture = installFixture(home, channel, [
      DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
    ]);
    writeFileSync(
      fixture.executable,
      `#!/usr/bin/env node
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
`,
      { mode: 0o700 },
    );
    let preparations = 0;
    const startedAtMs = Date.now();

    expect(() =>
      ensureDevHmuxTool(
        { root: "/repo", home, channel, expectedBuildId: fixture.buildId },
        { prepare: () => (preparations += 1) },
      ),
    ).toThrow("target capability probe failed");

    expect(Date.now() - startedAtMs).toBeLessThan(5_000);
    expect(preparations).toBe(0);
  });
});

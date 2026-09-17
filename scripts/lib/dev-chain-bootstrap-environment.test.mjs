import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { devHmuxToolPaths } from "./app-channel.mjs";
import { DEV_HMUX_STANDALONE_OPERATION_CAPABILITY } from "./dev-hmux-operation-contract.mjs";
import { scriptTestEnvironment } from "./script-test-environment.mjs";

it.skipIf(process.platform === "win32").each(["unset", "empty", "portable"])(
  "cold bootstrap launches with the requested %s app home and isolated discovery",
  (selection) => {
    const fixture = mkdtempSync(join(tmpdir(), "dure-bootstrap-environment-"));
    const home = join(fixture, "home");
    const root = join(fixture, "worktree");
    const portableHome = join(fixture, "portable app's home $literal");
    const capture = join(fixture, "environment.json");
    const channel = "dev-bootstrap-environment-1234567890";
    const buildId = "0.1.4+dev.environment-fixture";
    const version = join(devHmuxToolPaths(home, channel).installRoot, "versions", buildId);
    mkdirSync(join(version, "bin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(version, "install.json"), JSON.stringify({ schemaVersion: 1, buildId }), { mode: 0o600 });
    writeFileSync(join(root, "scripts", "run-dev-app.mjs"), `
import { appRoot } from ${JSON.stringify(new URL("./dure-home.mjs", import.meta.url).href)};
import { defaultDiscoveryRoots } from ${JSON.stringify(new URL("./hmux-version-gc.mjs", import.meta.url).href)};
process.stdout.write(JSON.stringify({
  home: process.env.HOME,
  dureHome: process.env.DURE_HOME ?? null,
  appRoot: appRoot(),
  discoveryRoot: defaultDiscoveryRoots()[0],
  hmuxDiscoveryRoot: process.env.HMUX_DISCOVERY_ROOT ?? null,
  secret: process.env.DURE_TEST_SECRET ?? null,
  providerContext: process.env.CLAUDECODE ?? null,
}));
`);
    writeFileSync(join(version, "bin", "hmux"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    buildInfo: { buildId: ${JSON.stringify(buildId)}, source: "hmux_cli" },
    capabilities: [${JSON.stringify(DEV_HMUX_STANDALONE_OPERATION_CAPABILITY)}],
  }));
  process.exit(0);
}
const frame = fs.readFileSync(0);
const request = JSON.parse(frame.subarray(4));
// Hmux's standalone pane inherits its hosting catalog; the command must scrub it.
const child = spawnSync(request.command[0], request.command.slice(1), {
  encoding: "utf8",
  env: { ...process.env, HMUX_DISCOVERY_ROOT: args[1] },
});
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  parent: {
    home: process.env.HOME,
    dureHome: process.env.DURE_HOME ?? null,
    hmuxDiscoveryRoot: process.env.HMUX_DISCOVERY_ROOT ?? null,
    secret: process.env.DURE_TEST_SECRET ?? null,
  },
  args, command: request.command, child,
}));
const payload = Buffer.from(JSON.stringify({
  schemaVersion: 1, operationId: request.operationId,
  outcome: "pending", errorCode: "hmux_fixture_capture_complete",
}));
const response = Buffer.alloc(payload.length + 4);
response.writeUInt32BE(payload.length);
payload.copy(response, 4);
process.stdout.write(response);
`, { mode: 0o700 });
    try {
      const runner = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { executeDevChainColdBootstrap } from ${JSON.stringify(new URL("./dev-chain-recovery.mjs", import.meta.url).href)};
const result = await executeDevChainColdBootstrap(${JSON.stringify({
  root, home, channel, hmuxBuildId: buildId, port: 1420,
  sourceGeneration: "a".repeat(64), requestGeneration: "b".repeat(32),
  operationId: "c".repeat(64), initialRows: 31, initialColumns: 97, timeoutMs: 5000,
})}, {
  resolveTools: () => ({ status: "available", tools: {
    environmentExecutable: "/usr/bin/env", shellExecutable: "/bin/sh",
  } }),
});
process.stdout.write(JSON.stringify(result));
`], {
        cwd: root,
        encoding: "utf8",
        env: scriptTestEnvironment({
          HOME: home,
          DURE_HOME: selection === "portable" ? portableHome : selection === "empty" ? "" : undefined,
          HMUX_DISCOVERY_ROOT: join(fixture, "requesting-pane-catalog"),
          DURE_TEST_SECRET: "dummy-secret-must-not-cross-bootstrap",
          CLAUDECODE: "agent-parent",
        }),
      });
      expect(runner.status, runner.stderr).toBe(0);
      expect(JSON.parse(runner.stdout).hmuxErrorCode).toBe("hmux_fixture_capture_complete");
      const observed = JSON.parse(readFileSync(capture, "utf8"));
      expect(observed.parent).toEqual({ home, dureHome: null, hmuxDiscoveryRoot: null, secret: null });
      expect(observed.args[1]).toBe(join(home, ".dure", "state", "dev-launch-hosts"));
      expect(observed.child.status, observed.child.stderr).toBe(0);
      const expectedHome = selection === "portable" ? portableHome : join(home, ".dure");
      expect(JSON.parse(observed.child.stdout)).toEqual({
        home,
        dureHome: selection === "portable" ? portableHome : null,
        appRoot: expectedHome,
        discoveryRoot: join(expectedHome, "state", "hmux-hosts"),
        hmuxDiscoveryRoot: null,
        secret: null,
        providerContext: null,
      });
      expect(observed.command.join(" ")).not.toContain("dummy-secret-must-not-cross-bootstrap");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

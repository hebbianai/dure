import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID, CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION, CONTROL_PLANE_IDENTITY_KIND,
} from "../cli/lib/control-plane-contract.mjs";
import {
  createDureCliInstallerFixture, dureCliInstallerFixtureEnvironment,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const roots = [];
const identity = "Developer ID Application: Fixture (TEAM123456)";
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ failAt = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-sign-"));
  roots.push(root);
  const repository = createDureCliInstallerFixture(root);
  const controlPlane = path.join(root, "dure-control-plane");
  const relay = path.join(root, "dure-claude-process-relay");
  const contract = { schemaVersion: 1, apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
    kind: CONTROL_PLANE_IDENTITY_KIND, buildId: CONTROL_PLANE_BUILD_ID,
    capabilities: CONTROL_PLANE_CAPABILITIES };
  fs.writeFileSync(controlPlane, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(contract)}'\n`, { mode: 0o755 });
  fs.writeFileSync(relay, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const original = [controlPlane, relay].map((file) => ({ file, digest: digest(file) }));
  const log = path.join(root, "signing.jsonl");
  fs.writeFileSync(log, "");
  // Mutate only disposable staged bytes, just as codesign does. A different
  // seal on each invocation catches signing inside snapshot stabilization.
  fs.writeFileSync(path.join(repository, ".test-bin", "codesign"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = args.at(-1);
const log = ${JSON.stringify(log)};
const count = fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).length + 1;
if (!file.includes("dure-cli-build-") || !file.includes("/generation-") || !file.includes("/version/bin/")) process.exit(64);
fs.appendFileSync(log, JSON.stringify({ args, file, count }) + "\\n");
if (count === ${failAt}) { process.stderr.write("fixture signing refused\\n"); process.exit(1); }
fs.appendFileSync(file, "\\n# fixture secure signing seal " + count + " " + Date.now() + "\\n");
`, { mode: 0o755 });
  const bundle = path.join(root, "bundle");
  const environment = dureCliInstallerFixtureEnvironment(repository, scriptTestEnvironment({
    HOME: path.join(root, "home"), DURE_APP_CHANNEL: "stable",
    DURE_CONTROL_PLANE_BIN: controlPlane, DURE_CLAUDE_PROCESS_RELAY_BIN: relay,
    DURE_HMUX_BIN: controlPlane, DURE_HMUX_RUNTIME_BIN: controlPlane,
    DURE_HMUX_BUILD_ID: "hmux-signing-fixture", DURE_CLI_SOURCE_REVISION: "a".repeat(40),
    APPLE_SIGNING_IDENTITY: identity,
  }));
  const result = spawnSync(process.execPath, ["scripts/install-dure-cli.mjs", "--bundle", bundle], {
    cwd: repository, env: environment, encoding: "utf8", timeout: 30_000,
  });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { root, original, bundle, result, calls };
}

test.skipIf(process.platform !== "darwin")("seals each staged native CLI resource once before computing its immutable identity", async () => {
  const { original, bundle, result, calls } = fixture();
  expect(result.status, result.stderr).toBe(0);
  expect(calls).toHaveLength(4);
  expect(calls.map(({ file }) => path.basename(file)).sort()).toEqual([
    "dure-claude-process-relay", "dure-control-plane", "hmux", "hmux-runtime",
  ]);
  for (const { args } of calls) {
    expect(args.slice(0, -1)).toEqual(["--force", "--sign", identity, "--options", "runtime", "--timestamp"]);
  }
  const versionRoot = fs.realpathSync(path.join(bundle, "current"));
  const metadata = JSON.parse(fs.readFileSync(path.join(versionRoot, "install.json"), "utf8"));
  const { artifactDigest } = await import(pathToFileURL(path.join(versionRoot, "bin/lib/dure-cli-channel-launcher.mjs")));
  expect(metadata.bundle.artifactDigest).toBe(artifactDigest(versionRoot));
  expect(metadata.bundle.hmux.executableDigest).toBe(digest(path.join(versionRoot, "bin/hmux")));
  expect(metadata.bundle.hmux.runtimeExecutableDigest).toBe(digest(path.join(versionRoot, "bin/hmux-runtime")));
  const { currentControlPlaneBundleIdentity } = await import(pathToFileURL(path.join(versionRoot, "bin/lib/control-plane-contract.mjs")));
  expect(metadata.bundle.controlPlane).toEqual(currentControlPlaneBundleIdentity(path.join(versionRoot, "bin/dure-control-plane")));
  for (const item of original) expect(digest(item.file)).toBe(item.digest);
  // Node keeps its existing vendor signature/entitlements; it is not re-signed.
  expect(digest(path.join(versionRoot, "bin/node"))).toBe(digest(process.execPath));
}, 40_000);

test.skipIf(process.platform !== "darwin")("refuses a failed resource signature without retry or publishing an immutable CLI", () => {
  const { original, bundle, result, calls } = fixture({ failAt: 2 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("fixture signing refused");
  expect(calls).toHaveLength(2);
  expect(fs.existsSync(bundle)).toBe(false);
  for (const item of original) expect(digest(item.file)).toBe(item.digest);
}, 40_000);

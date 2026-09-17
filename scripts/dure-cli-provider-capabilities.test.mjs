import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import { PROVIDERS } from "../src/lib/agents/providerCatalog.ts";
import { PROVIDERS as SHARED_PROVIDERS } from "../cli/lib/contracts/provider-catalog.mjs";
import { projectProviderCapabilities } from "../cli/lib/provider-capabilities.mjs";

const cliRoot = fileURLToPath(new URL("../cli/", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(packaged) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-provider-capabilities-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const data = path.join(home, ".dure");
  fs.mkdirSync(data, { recursive: true });
  for (const name of ["agents.json", "server.json", "backend-profiles.json"]) {
    fs.writeFileSync(path.join(data, name), "invalid fixture state\n");
  }
  const packageRoot = packaged ? path.join(root, "package") : cliRoot;
  if (packaged) {
    fs.mkdirSync(packageRoot);
    for (const name of ["dure.mjs", "package.json", "lib"]) {
      fs.cpSync(path.join(cliRoot, name), path.join(packageRoot, name), { recursive: true });
    }
  }
  const environment = scriptTestEnvironment({
    HOME: home,
    DURE_HOME: data,
    DURE_APP_CHANNEL: "stable",
    DURE_BACKEND_PROFILE: "unavailable-fixture-backend",
    HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
    PATH: path.join(root, "no-executables"),
  });
  const runtimeCalls = path.join(root, "runtime-calls");
  const preload = path.join(root, "observe-runtime.cjs");
  fs.writeFileSync(preload, `
    const fs = require("node:fs");
    const reject = (name) => () => {
      fs.appendFileSync(${JSON.stringify(runtimeCalls)}, name + "\\n");
      throw new Error("unexpected runtime probe: " + name);
    };
    const childProcess = require("node:child_process");
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
      childProcess[name] = reject(name);
    }
    require("node:net").Socket.prototype.connect = reject("connect");
    require("node:module").syncBuiltinESMExports();
  `);
  const node = process.env.DURE_CLI_TEST_NODE || process.execPath;
  const run = (args) => spawnSync(node, ["--require", preload, path.join(packageRoot, "dure.mjs"), ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { root, home, data, runtimeCalls, run };
}

describe("read-only provider capability CLI", () => {
  it.each([false, true])("exports declarations without an app or provider (packaged=%s)", (packaged) => {
    const { root, home, data, runtimeCalls, run } = fixture(packaged);
    const before = fs.readdirSync(home, { recursive: true });
    const first = run(["providers", "capabilities", "--json"]);
    expect(first.status, first.stderr).toBe(0);
    const report = JSON.parse(first.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.provider-capabilities/v1",
      kind: "dure.provider_capabilities",
      source: { kind: "bundled_catalog", installation: "source", buildId: null },
      runtimeObservation: "not_performed",
    });
    const provider = (id) => report.providers.find((entry) => entry.id === id);
    expect(provider("claude")).toMatchObject({
      resume: "exact", conversationList: "local_records", conversationFork: "copy_and_flag",
      accountProfiles: true, structuredChat: true, workflowDelegation: true,
    });
    expect(provider("continue")).toMatchObject({ resume: "latest_only", conversationFork: "none" });
    expect(provider("qwen-code")).toMatchObject({ resume: "exact", accountProfiles: false, structuredChat: false });
    expect(provider("kimi")).toMatchObject({ resume: "exact", accountProfiles: true, structuredChat: false });
    const ids = report.providers.map(({ id }) => id);
    expect(ids).toEqual(Object.keys(PROVIDERS).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(report.catalogFingerprint).toBe(`sha256:${createHash("sha256").update(JSON.stringify(report.providers)).digest("hex")}`);
    expect(run(["providers", "capabilities", "--json"]).stdout).toBe(first.stdout);
    expect(fs.readdirSync(home, { recursive: true })).toEqual(before);
    for (const name of ["agents.json", "server.json", "backend-profiles.json"]) {
      expect(fs.readFileSync(path.join(data, name), "utf8")).toBe("invalid fixture state\n");
    }
    fs.rmSync(data, { recursive: true, force: true });
    expect(run(["providers", "capabilities", "--json"]).stdout).toBe(first.stdout);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.existsSync(path.join(root, "discovery"))).toBe(false);
    expect(fs.existsSync(runtimeCalls)).toBe(false);
  });

  it("refuses runtime selection instead of implying remote capability observation", () => {
    const { run } = fixture(false);
    const result = run(["providers", "capabilities", "--backend", "ssh-a", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "provider_capabilities_arguments_invalid" },
    });
  });

  it("uses the frontend catalog authority and includes added adapters without invoking them", () => {
    expect(SHARED_PROVIDERS).toBe(PROVIDERS);
    const added = {
      label: "Fixture provider", cmd: "fixture-cli", credentialFiles: [],
      resumeId: () => { throw new Error("capability reads must not invoke launch adapters"); },
      structuredChat: true,
    };
    const catalog = { ...PROVIDERS, "fixture-provider": added };
    const projected = projectProviderCapabilities(catalog);
    expect(projected.find(({ id }) => id === "fixture-provider")).toMatchObject({
      resume: "exact", structuredChat: true, accountProfiles: false,
    });
    expect(projectProviderCapabilities(Object.fromEntries(Object.entries(catalog).reverse()))).toEqual(projected);
    expect(PROVIDERS).not.toHaveProperty("fixture-provider");
  });

  it("checks the shared JavaScript catalog against its provider type declarations", () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--noEmit", "--allowJs", "--checkJs", "--strict", "--skipLibCheck",
      "--module", "nodenext", "--target", "ES2020",
      path.join(cliRoot, "lib/contracts/provider-catalog.mjs"),
    ], { encoding: "utf8", env: scriptTestEnvironment(), timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

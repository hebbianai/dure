import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactDigest } from "../cli/lib/dure-cli-channel-launcher.mjs";
import {
  createDiagnosticReport,
  evaluateDiagnosticCheck,
  formatDiagnosticReport,
  inspectAppRuntime,
  inspectCliIdentity,
  parseDiagnosticRequirements,
  supportsHmuxCapability,
} from "../cli/lib/runtime-diagnostics.mjs";
import { dureCliVersionExpectation } from "./lib/dure-cli-version-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const temporaryDirectories = [];

function temporaryDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

function writeLauncherVersion({ buildId, executable, installRoot }) {
  const versionRoot = path.join(installRoot, "versions", buildId);
  const binaryRoot = path.join(versionRoot, "bin");
  const libraryRoot = path.join(binaryRoot, "lib");
  fs.mkdirSync(libraryRoot, { recursive: true });
  const scriptPath = path.join(binaryRoot, "dure.mjs");
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.symlinkSync("dure.mjs", path.join(binaryRoot, "dure"));
  fs.copyFileSync(
    path.resolve("cli/lib/dure-cli-channel-launcher.mjs"),
    path.join(libraryRoot, "dure-cli-channel-launcher.mjs"),
  );
  const executablePath = fs.realpathSync(executable);
  const executableDigest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(executablePath))
    .digest("hex");
  const metadata = {
    schemaVersion: 3,
    buildId,
    packageVersion: "0.1.4",
    sourceDigest: crypto.createHash("sha256").update(buildId).digest("hex"),
    command: "dure",
    controlPlaneCommand:
      process.platform === "win32"
        ? "dure-control-plane.exe"
        : "dure-control-plane",
    compatibilityCommands: ["hebbian-ade", "hebbian-ide"],
    bundle: {
      schemaVersion: 2,
      artifactDigest: artifactDigest(versionRoot),
      app: { schemaVersion: 1, channel: "stable" },
      controlPlane: { buildId: "dure-control-plane/v1-test" },
      orchestration: {},
      hmux: {
        schemaVersion: 1,
        channel: "stable",
        buildId: "hmux-test-v1",
        executablePath,
        executableDigest,
        runtimeExecutablePath: executablePath,
        runtimeExecutableDigest: executableDigest,
      },
    },
  };
  fs.writeFileSync(
    path.join(versionRoot, "install.json"),
    `${JSON.stringify(metadata)}\n`,
  );
  return { scriptPath, versionRoot };
}

function selectLauncherVersion({ commandDirectory, installRoot, versionRoot }) {
  const current = path.join(installRoot, "current");
  const launcher = path.join(installRoot, "launcher", "dure.mjs");
  const command = path.join(commandDirectory, "dure");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(commandDirectory, { recursive: true });
  fs.rmSync(current, { force: true });
  fs.symlinkSync(path.relative(installRoot, versionRoot), current);
  fs.copyFileSync(
    path.join(versionRoot, "bin", "lib", "dure-cli-channel-launcher.mjs"),
    launcher,
  );
  fs.chmodSync(launcher, 0o755);
  fs.rmSync(command, { force: true });
  fs.symlinkSync(launcher, command);
  return { command, launcher };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serverDescriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    apiVersion: 1,
    packageVersion: "0.1.4",
    buildId: "0.1.4+app",
    port: 6767,
    token: "secret-control-token",
    channel: "stable",
    generation: "generation-1",
    processId: 42,
    startedAtUnixMs: 123,
    ...overrides,
  };
}

function currentCompatibility() {
  return {
    mode: "current",
    comparisonBasis: "runtime-fingerprint",
    frontendBuildId: "0.1.4+frontend",
    frontendSourceRevision: "0123456789ab",
    frontendWorktreeOverlay: "present",
    frontendRuntimeFingerprint:
      "git-object-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    backend: {
      name: "Dure",
      packageVersion: "0.1.4",
      protocolVersion: 1,
      buildId: "0.1.4+backend",
      runtimeFingerprint:
        "git-object-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      features: ["app.runtime-fingerprint-v1"],
    },
    missingFeatures: [],
  };
}

describe("Dure runtime diagnostics", () => {
  it("accepts additive Hmux capability manifests", () => {
    const capability = "managed_screen_read_v1";

    expect(
      supportsHmuxCapability(
        { schemaVersion: 1, capabilities: [capability] },
        capability,
      ),
    ).toBe(true);
    expect(
      supportsHmuxCapability(
        {
          schemaVersion: 2,
          capabilities: [capability],
          buildInfo: { source: "hmux_cli" },
        },
        capability,
      ),
    ).toBe(true);
    expect(
      supportsHmuxCapability(
        { schemaVersion: 2, capabilities: [] },
        capability,
      ),
    ).toBe(false);
    expect(
      supportsHmuxCapability(
        { schemaVersion: 0, capabilities: [capability] },
        capability,
      ),
    ).toBe(false);
  });

  it("reads immutable identity and detects the exact PATH binary", () => {
    const root = temporaryDirectory("dure-cli-identity-");
    const versionRoot = path.join(root, "versions", "0.1.4+fixture");
    const binary = path.join(versionRoot, "bin", "dure");
    const commandDirectory = path.join(root, "commands");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.mkdirSync(commandDirectory);
    fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(versionRoot, "install.json"),
      JSON.stringify({
        schemaVersion: 3,
        command: "dure",
        packageVersion: "0.1.4",
        buildId: "0.1.4+fixture",
      }),
    );
    const command = path.join(commandDirectory, "dure");
    fs.symlinkSync(binary, command);
    const resolvedBinary = fs.realpathSync(binary);

    expect(
      inspectCliIdentity({
        scriptPath: binary,
        invocationPath: command,
        invokedAs: "dure",
        environment: { PATH: commandDirectory },
      }),
    ).toMatchObject({
      packageVersion: "0.1.4",
      buildId: "0.1.4+fixture",
      installation: "immutable",
      resolvedPath: resolvedBinary,
      pathResolvedPath: resolvedBinary,
      pathMatchesCurrent: true,
    });
  });

  it("recognizes the verified PATH launcher selecting the current payload", () => {
    const root = temporaryDirectory("dure-cli-launcher-diagnostics-");
    const installRoot = path.join(root, "share", "dure-cli");
    const commandDirectory = path.join(root, "bin");
    const executable = path.join(root, "hmux");
    for (const pathname of [installRoot, commandDirectory, executable]) {
      expect(path.relative(root, pathname)).not.toMatch(/^\.\.(?:\/|$)/);
    }
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const initial = writeLauncherVersion({
      buildId: "0.1.4+fixture",
      executable,
      installRoot,
    });
    const selected = selectLauncherVersion({
      commandDirectory,
      installRoot,
      versionRoot: initial.versionRoot,
    });
    const command = selected.command;
    const launcher = fs.realpathSync(selected.launcher);
    const scriptPath = initial.scriptPath;

    expect(fs.realpathSync(command)).toBe(
      path.join(fs.realpathSync(installRoot), "launcher", "dure.mjs"),
    );
    expect(
      inspectCliIdentity({
        scriptPath,
        invocationPath: scriptPath,
        invokedAs: "dure",
        environment: {
          HOME: root,
          PATH: commandDirectory,
          DURE_APP_CHANNEL: "stable",
        },
      }),
    ).toMatchObject({
      pathResolvedPath: launcher,
      pathMatchesCurrent: true,
    });

    fs.appendFileSync(launcher, "\n// tampered launcher\n");
    expect(
      inspectCliIdentity({
        scriptPath,
        environment: {
          HOME: root,
          PATH: commandDirectory,
          DURE_APP_CHANNEL: "stable",
        },
      }).pathMatchesCurrent,
    ).toBe(false);

    const replacement = writeLauncherVersion({
      buildId: "0.1.4+replacement",
      executable,
      installRoot,
    });
    selectLauncherVersion({
      commandDirectory,
      installRoot,
      versionRoot: replacement.versionRoot,
    });
    expect(
      inspectCliIdentity({
        scriptPath,
        environment: {
          HOME: root,
          PATH: commandDirectory,
          DURE_APP_CHANNEL: "stable",
        },
      }).pathMatchesCurrent,
    ).toBe(false);

    fs.unlinkSync(command);
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(
      inspectCliIdentity({
        scriptPath,
        environment: { HOME: root, PATH: commandDirectory },
      }).pathMatchesCurrent,
    ).toBe(false);
  });

  it("fences the app descriptor and never emits its bearer token", async () => {
    const root = temporaryDirectory("dure-app-diagnostics-");
    const descriptorPath = path.join(root, "server.json");
    fs.writeFileSync(descriptorPath, JSON.stringify(serverDescriptor()));
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/ping")) {
        return response({
          ok: true,
          channel: "stable",
          generation: "generation-1",
          processId: 42,
        });
      }
      return response({
        ok: true,
        schemaVersion: 1,
        compatibility: currentCompatibility(),
      });
    });

    const app = await inspectAppRuntime({ descriptorPath, fetchImpl });

    expect(app).toMatchObject({
      state: "running",
      channel: "stable",
      packageVersion: "0.1.4",
      buildId: "0.1.4+app",
      compatibility: {
        state: "available",
        mode: "current",
        detail: {
          frontendSourceRevision: "0123456789ab",
          frontendWorktreeOverlay: "present",
        },
      },
    });
    expect(JSON.stringify(app)).not.toContain("secret-control-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses a stale generation before requesting compatibility", async () => {
    const root = temporaryDirectory("dure-stale-diagnostics-");
    const descriptorPath = path.join(root, "server.json");
    fs.writeFileSync(descriptorPath, JSON.stringify(serverDescriptor()));
    const fetchImpl = vi.fn(async () =>
      response({
        ok: true,
        channel: "stable",
        generation: "replacement-generation",
        processId: 42,
      }),
    );

    await expect(
      inspectAppRuntime({ descriptorPath, fetchImpl }),
    ).resolves.toMatchObject({
      state: "stale_descriptor",
      compatibility: { state: "unavailable" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("degrades safely when an old app has no diagnostics endpoint", async () => {
    const root = temporaryDirectory("dure-old-app-diagnostics-");
    const descriptorPath = path.join(root, "server.json");
    fs.writeFileSync(descriptorPath, JSON.stringify(serverDescriptor()));
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/ping")
        ? response({
            ok: true,
            channel: "stable",
            generation: "generation-1",
            processId: 42,
          })
        : response({ ok: false }, 404),
    );

    await expect(
      inspectAppRuntime({ descriptorPath, fetchImpl }),
    ).resolves.toMatchObject({
      state: "running",
      compatibility: { state: "unsupported", mode: null },
    });
  });

  it("classifies any skew or unavailable dependency as degraded", () => {
    expect(
      createDiagnosticReport({
        now: 123,
        cli: { pathMatchesCurrent: true },
        app: {
          state: "running",
          compatibility: { state: "available", mode: "version-skew" },
        },
        hmux: { compatible: true },
      }),
    ).toMatchObject({ schemaVersion: 1, generatedAtMs: 123, status: "degraded" });
    expect(
      createDiagnosticReport({
        cli: { pathMatchesCurrent: true },
        app: {
          state: "running",
          compatibility: { state: "available", mode: "version-skew" },
        },
        hmux: { compatible: true },
      }).issues,
    ).toEqual(["app_version_skew"]);
  });

  it("parses bounded requirements and evaluates only the selected domains", () => {
    expect(parseDiagnosticRequirements()).toEqual(["app", "hmux", "path"]);
    expect(parseDiagnosticRequirements("path, app,path")).toEqual([
      "path",
      "app",
    ]);
    expect(() => parseDiagnosticRequirements("app,unknown")).toThrow();
    expect(() => parseDiagnosticRequirements("")).toThrow();

    const report = createDiagnosticReport({
      cli: { pathMatchesCurrent: false },
      app: {
        state: "running",
        compatibility: { state: "available", mode: "current" },
      },
      hmux: { compatible: true },
    });
    expect(evaluateDiagnosticCheck(report, ["app", "hmux"])).toEqual({
      required: ["app", "hmux"],
      failed: [],
      passed: true,
    });
    expect(evaluateDiagnosticCheck(report, ["path", "app"])).toEqual({
      required: ["path", "app"],
      failed: ["path"],
      passed: false,
    });
    expect(
      formatDiagnosticReport({
        ...report,
        check: evaluateDiagnosticCheck(report, ["path", "app"]),
      }),
    ).toContain("required: path,app\n  passed: no\n  failed: path");
  });

  it("supports version and offline JSON diagnostics without a registry", () => {
    const cliVersion = dureCliVersionExpectation(process.cwd());
    const home = temporaryDirectory("dure-cli-offline-");
    const hmux = path.join(home, "hmux");
    fs.writeFileSync(
      hmux,
      `#!/bin/sh
if [ "$1" = "capabilities" ]; then
  printf '%s\\n' '{"schemaVersion":2,"capabilities":["bounded_screen_read_v1"],"buildInfo":{"source":"hmux_cli"}}'
elif [ "$1" = "--version" ]; then
  printf '%s\\n' 'hmux 0.1.4'
fi
`,
      { mode: 0o755 },
    );
    const environment = scriptTestEnvironment({
      HOME: home,
      DURE_HMUX_BIN: hmux,
    });

    const version = spawnSync(process.execPath, ["cli/dure.mjs", "--version"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    const diagnostics = spawnSync(
      process.execPath,
      ["cli/dure.mjs", "diagnostics", "--json"],
      {
        cwd: process.cwd(),
        env: { ...environment, DURE_INVOKED_AS: "hebbian-ade" },
        encoding: "utf8",
      },
    );

    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(cliVersion.sourceOutput);
    expect(diagnostics.status).toBe(0);
    const diagnosticsReceipt = JSON.parse(diagnostics.stdout);
    expect(diagnosticsReceipt).toMatchObject({
      schemaVersion: 1,
      status: "degraded",
      issues: expect.arrayContaining(["cli_path_mismatch", "app_not_running"]),
      cli: {
        command: "dure",
        invokedAs: "hebbian-ade",
        deprecatedInvocation: true,
        packageVersion: cliVersion.packageVersion,
      },
      app: { state: "not_running" },
      hmux: { version: "0.1.4", compatible: true },
    });
    expect(diagnosticsReceipt).not.toHaveProperty("check");
    expect(diagnostics.stderr).toBe(
      "[deprecated] hebbian-ade is deprecated; use dure instead.\n",
    );
  });

  it("uses explicit requirements for a machine-readable strict exit status", () => {
    const home = temporaryDirectory("dure-cli-check-");
    const hmux = path.join(home, "hmux");
    fs.writeFileSync(
      hmux,
      `#!/bin/sh
if [ "$1" = "capabilities" ]; then
  printf '%s\\n' '{"schemaVersion":1,"capabilities":["bounded_screen_read_v1"]}'
elif [ "$1" = "--version" ]; then
  printf '%s\\n' 'hmux 0.1.4'
fi
`,
      { mode: 0o755 },
    );
    const environment = scriptTestEnvironment({
      HOME: home,
      DURE_HMUX_BIN: hmux,
    });

    const passed = spawnSync(
      process.execPath,
      [
        "cli/dure.mjs",
        "diagnostics",
        "--check",
        "--require",
        "hmux",
        "--json",
      ],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    const failed = spawnSync(
      process.execPath,
      [
        "cli/dure.mjs",
        "diagnostics",
        "--check",
        "--require",
        "app,hmux,path",
        "--json",
      ],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );

    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout).check).toEqual({
      required: ["hmux"],
      failed: [],
      passed: true,
    });
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).check).toEqual({
      required: ["app", "hmux", "path"],
      failed: ["app", "path"],
      passed: false,
    });
  });

  it("rejects invalid check options before probing Hmux", () => {
    const home = temporaryDirectory("dure-cli-invalid-check-");
    const marker = path.join(home, "probe-ran");
    const hmux = path.join(home, "hmux");
    fs.writeFileSync(
      hmux,
      "#!/bin/sh\nprintf touched > \"$DURE_HMUX_PROBE_MARKER\"\n",
      { mode: 0o755 },
    );
    const environment = scriptTestEnvironment({
      HOME: home,
      DURE_HMUX_BIN: hmux,
      DURE_HMUX_PROBE_MARKER: marker,
    });

    const withoutCheck = spawnSync(
      process.execPath,
      ["cli/dure.mjs", "diagnostics", "--require", "app"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    const unknown = spawnSync(
      process.execPath,
      ["cli/dure.mjs", "diagnostics", "--check", "--require", "unknown"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );

    expect(withoutCheck.status).toBe(1);
    expect(unknown.status).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION,
  CONTROL_PLANE_IDENTITY_KIND,
} from "../cli/lib/control-plane-contract.mjs";
import {
  promoteDureCli,
  reconcileDureCliLauncher,
} from "../cli/lib/dure-cli-promotion.mjs";
import { artifactDigest } from "../cli/lib/dure-cli-channel-launcher.mjs";
import { orchestrationPayloadIdentity } from "../cli/lib/orchestration-integration-bundle.mjs";
import { inspectCliIdentity } from "../cli/lib/runtime-diagnostics.mjs";
import { resolveLocalBackendExecutable } from "../cli/lib/local-backend.mjs";
import {
  createDureCliInstallerFixture as copyInstallerFixture,
  dureCliInstallerFixtureCorepackInvocation,
  dureCliInstallerFixtureCorepackMarker,
  dureCliInstallerFixtureEnvironment,
  writeClaudeRelayFixture,
  writeControlPlaneFixture,
} from "./lib/dure-cli-install-test-fixture.mjs";
import { dureCliVersionExpectation } from "./lib/dure-cli-version-test-fixture.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import { agentRuntimeBackendEnvelope } from "../src/test/dureAgentRuntimeFixtures.ts";

const temporaryDirectories = [];
const fixtureEnvironment = scriptTestEnvironment();

function fixtureClaudeDriverRoot(repository) {
  return path.join(
    repository,
    "crates",
    "dure-app",
    "control-plane",
    "provider-drivers",
    "claude",
  );
}

function controlPlaneFixtureBuildId(sequenceOffset, suffix) {
  const match = /^dure-control-plane\/v([1-9][0-9]*)-/u.exec(
    CONTROL_PLANE_BUILD_ID,
  );
  const sequence = Number(match?.[1]) + sequenceOffset;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("control-plane fixture sequence is invalid");
  }
  return `dure-control-plane/v${sequence}-${suffix}`;
}

function writeSourceMutatingControlPlaneFixture(pathname) {
  const identity = JSON.stringify({
    schemaVersion: 1,
    apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
    kind: CONTROL_PLANE_IDENTITY_KIND,
    buildId: CONTROL_PLANE_BUILD_ID,
    capabilities: CONTROL_PLANE_CAPABILITIES,
  });
  fs.writeFileSync(
    pathname,
    `#!/bin/sh\nif [ "$1" = identity ]; then\n  if [ "\${DURE_TEST_MUTATE_SOURCE:-}" = "1" ] && { [ -z "\${DURE_TEST_MUTATION_SENTINEL:-}" ] || [ ! -e "$DURE_TEST_MUTATION_SENTINEL" ]; }; then\n    if [ -n "\${DURE_TEST_MUTATION_SENTINEL:-}" ]; then\n      : > "$DURE_TEST_MUTATION_SENTINEL"\n    fi\n    if [ -n "\${DURE_TEST_REPLACEMENT_SOURCE:-}" ]; then\n      cp "$DURE_TEST_REPLACEMENT_SOURCE" "$DURE_TEST_MUTATION_TARGET"\n    else\n      printf '\\n// source changed during install\\n' >> "$DURE_TEST_MUTATION_TARGET"\n    fi\n    if [ -n "\${DURE_TEST_SECOND_REPLACEMENT_SOURCE:-}" ]; then\n      cp "$DURE_TEST_SECOND_REPLACEMENT_SOURCE" "$DURE_TEST_SECOND_MUTATION_TARGET"\n    fi\n    if [ -n "\${DURE_TEST_REPLACEMENT_CONTROL_PLANE:-}" ]; then\n      cp "$DURE_TEST_REPLACEMENT_CONTROL_PLANE" "$DURE_CONTROL_PLANE_BIN"\n    fi\n  fi\n  printf '%s\\n' '${identity}'\n  exit 0\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  writeClaudeRelayFixture(pathname);
}

function hashLegacyInstallSource(hash, cliRoot, pathname) {
  const stat = fs.lstatSync(pathname);
  const relativePath = path.relative(cliRoot, pathname).replaceAll("\\", "/");
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${relativePath}\0${fs.readlinkSync(pathname)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    for (const entry of fs
      .readdirSync(pathname, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      hashLegacyInstallSource(hash, cliRoot, path.join(pathname, entry.name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error("unsupported legacy install input");
  hash.update(`file\0${relativePath}\0${stat.mode & 0o111}\0`);
  hash.update(fs.readFileSync(pathname));
  hash.update("\0");
}

function legacyDefaultBuildId(fixtureRepository, controlPlane) {
  const cliRoot = path.join(fixtureRepository, "cli");
  const sourceHash = crypto.createHash("sha256");
  for (const pathname of [
    path.join(cliRoot, "dure.mjs"),
    path.join(cliRoot, "lib"),
    path.join(cliRoot, "skills"),
    path.join(fixtureRepository, "orchestration", "integration"),
    path.join(
      fixtureRepository,
      "crates",
      "dure-app",
      "control-plane",
      "Cargo.toml",
    ),
    path.join(
      fixtureRepository,
      "crates",
      "dure-app",
      "control-plane",
      "src",
    ),
  ]) {
    hashLegacyInstallSource(sourceHash, cliRoot, pathname);
  }
  const executablePath = fs.realpathSync(controlPlane);
  const executableDigest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(executablePath))
    .digest("hex");
  sourceHash.update("control-plane-binary\0");
  sourceHash.update(fs.readFileSync(executablePath));
  sourceHash.update("\0hmux-bundle\0");
  sourceHash.update(
    JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      buildId: "hmux-test-v1",
      executablePath,
      executableDigest,
      runtimeExecutablePath: executablePath,
      runtimeExecutableDigest: executableDigest,
    }),
  );
  sourceHash.update("\0");
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"),
  ).version;
  return `${packageVersion}+${sourceHash.digest("hex").slice(0, 16)}`;
}

function prepareMockVersion(
  sourceVersion,
  preparedRoot,
  buildId,
  target,
  channel = "stable",
) {
  const versions = path.join(preparedRoot, "versions");
  const version = path.join(versions, buildId);
  fs.mkdirSync(versions, { recursive: true });
  fs.cpSync(sourceVersion, version, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const script = path.join(version, "bin", "dure.mjs");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.appendFileSync(process.env.DURE_HANDOFF_LOG, JSON.stringify({ target: ${JSON.stringify(target)}, argv: process.argv.slice(2), backend: process.env.DURE_BACKEND_PROFILE ?? null, sessionId: process.env.HMUX_SESSION_ID ?? null, workspaceId: process.env.HMUX_WORKSPACE_ID ?? null, bindingGeneration: process.env.DURE_CHECKPOINT_BINDING_GENERATION ?? null }) + "\\n");\n`,
    { mode: 0o755 },
  );
  // Real stable/dev installs can carry different, individually verified launchers.
  fs.appendFileSync(
    path.join(version, "bin", "lib", "dure-cli-channel-launcher.mjs"),
    `\n// Immutable launcher revision: ${target}\n`,
  );
  const metadataPath = path.join(version, "install.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.buildId = buildId;
  metadata.sourceDigest = target.repeat(64).slice(0, 64).replaceAll(/[^a-f0-9]/g, "a");
  metadata.bundle.app.channel = channel;
  metadata.bundle.hmux.channel = channel;
  metadata.bundle.orchestration = orchestrationPayloadIdentity(script);
  metadata.bundle.artifactDigest = artifactDigest(version);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return version;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dure CLI installation", () => {
  it("upgrades an intact older managed CLI without requiring the new control-plane contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-upgrade-"));
    temporaryDirectories.push(root);
    const repository = copyInstallerFixture(root);
    const preparedRoot = path.join(root, "prepared");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: repository,
      env: dureCliInstallerFixtureEnvironment(repository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_HOME: path.join(root, ".dure"),
        HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_ROOT: preparedRoot,
        DURE_CLI_INSTALL_DIR: path.join(root, "prepared-bin"),
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
      stdio: "pipe",
    });
    const incoming = fs.realpathSync(path.join(preparedRoot, "current"));
    const installRoot = path.join(root, "installed");
    const commandDirectory = path.join(installRoot, "bin");
    const oldVersion = prepareMockVersion(
      incoming, installRoot, "0.2.2+previous-fixture", "old",
    );
    const oldControlPlane = path.join(oldVersion, "bin", "dure-control-plane");
    const oldBuildId = controlPlaneFixtureBuildId(-1, "previous-fixture");
    writeControlPlaneFixture(oldControlPlane, oldBuildId);
    const metadataPath = path.join(oldVersion, "install.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.bundle.controlPlane.buildId = oldBuildId;
    metadata.bundle.controlPlane.digest = crypto.createHash("sha256")
      .update(fs.readFileSync(oldControlPlane)).digest("hex");
    metadata.bundle.artifactDigest = artifactDigest(oldVersion);
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.symlinkSync(`versions/${metadata.buildId}`, path.join(installRoot, "current"));
    const oldBytes = fs.readFileSync(metadataPath);
    const promote = () => promoteDureCli({
      sourceVersionDirectory: incoming, installRoot, commandDirectory, reconcileManaged: true,
    });

    // The incoming bundle still has to satisfy this release's contract.
    expect(() => promoteDureCli({
      sourceVersionDirectory: oldVersion,
      installRoot: path.join(root, "wrong-incoming"),
      commandDirectory: path.join(root, "wrong-incoming-bin"),
      reconcileManaged: true,
    })).toThrow("control-plane build does not match");
    expect(fs.existsSync(path.join(root, "wrong-incoming"))).toBe(false);

    const oldScript = path.join(oldVersion, "bin", "dure.mjs");
    const scriptBytes = fs.readFileSync(oldScript);
    fs.appendFileSync(oldScript, "\n// altered installation\n");
    expect(promote).toThrow("immutable bundle digest does not match");
    expect(fs.realpathSync(path.join(installRoot, "current")))
      .toBe(fs.realpathSync(oldVersion));
    fs.writeFileSync(oldScript, scriptBytes);

    const result = promote();

    expect(result.buildId).toBe(path.basename(incoming));
    expect(fs.realpathSync(path.join(installRoot, "current")))
      .toBe(fs.realpathSync(path.join(installRoot, "versions", path.basename(incoming))));
    expect(fs.readFileSync(metadataPath)).toEqual(oldBytes);
    expect(artifactDigest(oldVersion)).toBe(metadata.bundle.artifactDigest);
    expect(promoteDureCli({
      sourceVersionDirectory: incoming, installRoot, commandDirectory, reconcileManaged: true,
    }).status).toBe("current");
  });

  it.each(["standalone", "bundled"])("upgrades a schema-2 %s CLI without executing or changing it", (layout) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-schema-two-"));
    temporaryDirectories.push(root);
    const repository = copyInstallerFixture(root);
    const preparedRoot = path.join(root, "prepared");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: repository,
      env: dureCliInstallerFixtureEnvironment(repository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_HOME: path.join(root, ".dure"),
        HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_ROOT: preparedRoot,
        DURE_CLI_INSTALL_DIR: path.join(root, "prepared-bin"),
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
      stdio: "pipe",
    });
    const incoming = fs.realpathSync(path.join(preparedRoot, "current"));
    const installRoot = path.join(root, "installed");
    const sourceDigest = "a".repeat(64);
    const buildId = `0.1.4+${sourceDigest.slice(0, 16)}`;
    const legacy = path.join(installRoot, "versions", buildId);
    const bin = path.join(legacy, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, layout === "standalone" ? "dure" : "dure.mjs");
    const scriptBytes = "#!/bin/sh\nexit 99\n";
    fs.writeFileSync(script, scriptBytes, { mode: 0o755 });
    if (layout === "bundled") fs.symlinkSync("dure.mjs", path.join(bin, "dure"));
    for (const name of ["hebbian-ade", "hebbian-ide"]) fs.symlinkSync("dure", path.join(bin, name));
    const metadata = {
      schemaVersion: 2, buildId, packageVersion: "0.1.4", sourceDigest,
      command: "dure", compatibilityCommands: ["hebbian-ade", "hebbian-ide"],
      ...(layout === "bundled" ? {
        controlPlaneCommand: path.basename(controlPlane),
        bundle: { schemaVersion: 1, controlPlane: { digest: "b".repeat(64) }, orchestration: { digest: "c".repeat(64) } },
      } : {}),
    };
    const metadataPath = path.join(legacy, "install.json");
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const oldBytes = fs.readFileSync(metadataPath);
    const current = path.join(installRoot, "current");
    fs.symlinkSync(`versions/${buildId}`, current);
    const globalCommands = path.join(root, "global-bin");
    fs.mkdirSync(globalCommands);
    for (const name of ["dure", "hebbian-ade", "hebbian-ide"]) {
      // Old launchers can pin the previous immutable version directly.
      fs.symlinkSync(path.join(bin, name), path.join(globalCommands, name));
    }
    const promote = () => promoteDureCli({ sourceVersionDirectory: incoming, installRoot,
      commandDirectory: path.join(installRoot, "bin"), reconcileManaged: true });
    expect(() => promoteDureCli({ sourceVersionDirectory: legacy, installRoot: path.join(root, "invalid-source"),
      commandDirectory: path.join(root, "invalid-bin"), reconcileManaged: true })).toThrow();
    expect(fs.existsSync(path.join(root, "invalid-source"))).toBe(false);
    fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, sourceDigest: "b".repeat(64) }));
    expect(promote).toThrow();
    expect(fs.realpathSync(current)).toBe(fs.realpathSync(legacy));
    fs.writeFileSync(metadataPath, oldBytes);
    fs.unlinkSync(current);
    const outside = path.join(root, "outside", "versions", buildId);
    fs.cpSync(legacy, outside, { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync(outside, current);
    expect(promote).toThrow();
    expect(fs.realpathSync(current)).toBe(fs.realpathSync(outside));
    fs.unlinkSync(current);
    fs.symlinkSync(`versions/${buildId}`, current);
    fs.unlinkSync(script);
    fs.symlinkSync(path.join(outside, "bin", path.basename(script)), script);
    expect(promote).toThrow();
    fs.unlinkSync(script);
    fs.writeFileSync(script, scriptBytes, { mode: 0o755 });
    expect(promote().buildId).toBe(path.basename(incoming));
    expect(reconcileDureCliLauncher({ sourceVersionDirectory: incoming, installRoot,
      commandDirectory: globalCommands }).status).toBe("repaired");
    for (const name of ["dure", "hebbian-ade", "hebbian-ide"]) {
      expect(fs.realpathSync(path.join(globalCommands, name)))
        .toBe(fs.realpathSync(path.join(installRoot, "launcher", "dure.mjs")));
    }
    expect(fs.readFileSync(metadataPath)).toEqual(oldBytes);
    expect(fs.readFileSync(script, "utf8")).toBe(scriptBytes);
    expect(promote().status).toBe("current");
  });

  it("runs the channel CLI in the invoking Node without process replacement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-node-runtime-"));
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "dure-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    const environment = {
      ...fixtureEnvironment,
      HOME: root,
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_INSTALL_DIR: commandDirectory,
      DURE_CLI_INSTALL_ROOT: installRoot,
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
    };
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, environment),
      stdio: "pipe",
    });
    const preload = path.join(root, "without-execve.cjs");
    const observation = path.join(root, "node-runtime.json");
    fs.writeFileSync(preload, [
      "process.execve = undefined;",
      'process.on("exit", () => require("node:fs").writeFileSync(',
      `  ${JSON.stringify(observation)},`,
      "  JSON.stringify({ pid: process.pid, executable: process.execPath, argv: process.argv }),",
      "));",
    ].join("\n"));
    const node = process.env.DURE_CLI_TEST_NODE || process.execPath;
    const versionRoot = fs.realpathSync(path.join(installRoot, "current"));
    const installedScript = path.join(versionRoot, "bin", "dure.mjs");
    for (const [name, args, status] of [
      ["dure", ["version", "--json"], 0],
      ["dure", ["providers", "capabilities", "--json"], 0],
      ["hebbian-ide", ["--help"], 0],
      ["dure", ["--channel-invalid-command"], 1],
    ]) {
      const result = spawnSync(
        node,
        ["--require", preload, path.join(commandDirectory, name), ...args],
        {
          encoding: "utf8",
          // The explicit Node remains authoritative even without a node on PATH.
          env: { ...environment, PATH: commandDirectory },
        },
      );
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).not.toContain("cli_update_required");
      expect(JSON.parse(fs.readFileSync(observation, "utf8"))).toEqual({
        pid: result.pid,
        executable: fs.realpathSync(node),
        argv: [fs.realpathSync(node), installedScript, ...args],
      });
      if (args[0] === "version") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          installation: "immutable",
          binary: installedScript,
        });
      }
      if (args[0] === "providers") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          apiVersion: "dure.provider-capabilities/v1",
          source: { installation: "immutable", buildId: path.basename(versionRoot) },
          runtimeObservation: "not_performed",
        });
      }
      if (name === "hebbian-ide") {
        expect(result.stdout).toContain("dure client pane");
        expect(result.stderr).toContain("[deprecated] hebbian-ide");
      }
    }
    // A verified payload's failure is a command failure, not an install hint.
    fs.writeFileSync(installedScript, 'throw new Error("fixture command failure");\n');
    const metadataPath = path.join(versionRoot, "install.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.bundle.artifactDigest = artifactDigest(versionRoot);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const failure = spawnSync(node, [path.join(commandDirectory, "dure")], {
      encoding: "utf8",
      env: { ...environment, PATH: commandDirectory },
    });
    expect(failure.status, failure.stderr).toBe(1);
    expect(failure.stderr).toContain("fixture command failure");
    expect(failure.stderr).not.toContain("cli_update_required");
  });

  it("seals the Claude SDK host and native process relay into the immutable CLI payload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-claude-runtime-"));
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "dure-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    const claudeRelay = path.join(root, "dure-claude-process-relay");
    const sourceDriver = fixtureClaudeDriverRoot(fixtureRepository);
    const sourceDriverDigest = artifactDigest(sourceDriver);
    const sourceRevision = "a".repeat(40);
    writeControlPlaneFixture(controlPlane);

    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_DIR: commandDirectory,
        DURE_CLI_INSTALL_ROOT: installRoot,
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_CLAUDE_PROCESS_RELAY_BIN: claudeRelay,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
        DURE_CLI_SOURCE_REVISION: sourceRevision,
      }),
      stdio: "pipe",
    });
    const corepackReceipt = JSON.parse(
      fs.readFileSync(
        dureCliInstallerFixtureCorepackMarker(fixtureRepository),
        "utf8",
      ),
    );
    expect(corepackReceipt.argv).toEqual(
      dureCliInstallerFixtureCorepackInvocation(fixtureRepository).argv,
    );
    expect(path.basename(corepackReceipt.cwd)).toBe(
      "claude-driver-dependencies",
    );
    expect(corepackReceipt.cwd).not.toBe(fs.realpathSync(sourceDriver));
    expect(fs.existsSync(corepackReceipt.cwd)).toBe(false);
    expect(artifactDigest(sourceDriver)).toBe(sourceDriverDigest);

    const versionRoot = fs.realpathSync(path.join(installRoot, "current"));
    const installedRuntime = await import(
      pathToFileURL(
        path.join(versionRoot, "bin", "lib", "agent-runtime-command.mjs"),
      ).href
    );
    const result = agentRuntimeBackendEnvelope().result;
    expect(
      await installedRuntime.collectAgentRuntimeCommand({
        args: ["switch", "agent-1", "chat"],
        resolveBackend: async () => ({ profile: { id: "local" } }),
        requestBackend: async () => ({ result }),
      }),
    ).toMatchObject({ ok: true, result });
    const installedMetadataPath = path.join(versionRoot, "install.json");
    const installedMetadata = JSON.parse(
      fs.readFileSync(installedMetadataPath, "utf8"),
    );
    expect(installedMetadata.bundle.app).toEqual({
      schemaVersion: 2,
      channel: "stable",
      sourceRevision,
    });
    const installedRelay = path.join(
      versionRoot,
      "bin",
      "dure-claude-process-relay",
    );
    const installedDriver = path.join(
      versionRoot,
      "bin",
      "provider-drivers",
      "claude",
    );
    expect(fs.statSync(installedRelay).mode & 0o111).not.toBe(0);
    expect(
      fs.statSync(path.join(installedDriver, "shared-sdk-host-entrypoint.mjs"))
        .isFile(),
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(installedDriver, "package.json"), "utf8"),
      ).dependencies["@anthropic-ai/claude-agent-sdk"],
    ).toBe("0.3.234");
    expect(
      fs.statSync(
        path.join(
          installedDriver,
          "node_modules",
          "@anthropic-ai",
          "claude-agent-sdk",
          "package.json",
        ),
      ).isFile(),
    ).toBe(true);
    const installedSdk = path.join(
      installedDriver,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
    );
    expect(fs.lstatSync(installedSdk).isDirectory()).toBe(true);
    expect(fs.lstatSync(installedSdk).isSymbolicLink()).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          installedDriver,
          "node_modules",
          "@anthropic-ai",
          "claude-agent-sdk-darwin-arm64",
        ),
      ),
    ).toBe(false);
    const installedSdkRelative = path.relative(
      versionRoot,
      fs.realpathSync(installedSdk),
    );
    expect(
      path.isAbsolute(installedSdkRelative) ||
        installedSdkRelative === ".." ||
        installedSdkRelative.startsWith(`..${path.sep}`),
    ).toBe(false);
    expect(fs.existsSync(path.join(sourceDriver, "node_modules"))).toBe(false);
    const installedSdkRuntime = await import(
      pathToFileURL(path.join(installedDriver, "sdk-runtime.mjs")).href
    );
    expect((await installedSdkRuntime.loadPinnedClaudeSdk()).sdkVersion).toBe(
      "0.3.234",
    );

    const tamperedMetadata = structuredClone(installedMetadata);
    tamperedMetadata.bundle.app.sourceRevision = "b".repeat(40);
    fs.writeFileSync(
      installedMetadataPath,
      `${JSON.stringify(tamperedMetadata, null, 2)}\n`,
    );
    expect(() =>
      promoteDureCli({
        sourceVersionDirectory: versionRoot,
        installRoot: path.join(root, "source-tampered-install"),
        commandDirectory: path.join(root, "source-tampered-bin"),
      }),
    ).toThrow(/source-bound bundle identity does not match/i);
    fs.writeFileSync(
      installedMetadataPath,
      `${JSON.stringify(installedMetadata, null, 2)}\n`,
    );

    fs.appendFileSync(
      path.join(installedDriver, "shared-sdk-host-entrypoint.mjs"),
      "\n// tampered\n",
    );
    expect(() =>
      promoteDureCli({
        sourceVersionDirectory: versionRoot,
        installRoot: path.join(root, "tampered-install"),
        commandDirectory: path.join(root, "tampered-bin"),
      }),
    ).toThrow(/immutable bundle digest does not match/i);
  });

  it("rejects package-manager invocation drift before materializing the Claude SDK", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-corepack-drift-"));
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const corepackBoundary = path.join(
      fixtureRepository,
      "scripts",
      "lib",
      "corepack-install.mjs",
    );
    const originalBoundary = fs.readFileSync(corepackBoundary, "utf8");
    const mutatedBoundary = originalBoundary.replace(
      '  "--ignore-scripts",',
      '  "--ignore-scriptz",',
    );
    expect(mutatedBoundary).not.toBe(originalBoundary);
    fs.writeFileSync(corepackBoundary, mutatedBoundary);
    const sourceDriver = fixtureClaudeDriverRoot(fixtureRepository);
    const sourceDriverDigest = artifactDigest(sourceDriver);

    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    const result = spawnSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      encoding: "utf8",
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_DIR: path.join(root, "bin"),
        DURE_CLI_INSTALL_ROOT: path.join(root, "share", "dure-cli"),
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/corepack fixture invocation mismatch/i);
    expect(
      fs.existsSync(dureCliInstallerFixtureCorepackMarker(fixtureRepository)),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(sourceDriver, "node_modules")),
    ).toBe(false);
    expect(artifactDigest(sourceDriver)).toBe(sourceDriverDigest);
  });

  // Was "installs the human-first checkpoint policy": it asserted four phrases
  // describing how to write a `dure checkpoint` line. #896 retired that command
  // and rewrote the skill, so those phrases went away and this test has been
  // red on main ever since. The half worth keeping is that the installer ships
  // the skills payload at all — more valuable now that #912 gives skills a
  // tracked lifecycle keyed on their bytes — so it now asserts every bundled
  // skill arrives byte-for-byte, which is what that lifecycle actually depends
  // on.
  it("installs every bundled skill byte-for-byte in the immutable CLI payload", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-checkpoint-guidance-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "dure-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);

    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_DIR: commandDirectory,
        DURE_CLI_INSTALL_ROOT: installRoot,
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
      stdio: "pipe",
    });

    const sourceSkills = path.join(fixtureRepository, "cli", "skills");
    const installedSkills = path.join(
      fs.realpathSync(path.join(installRoot, "current")),
      "bin",
      "skills",
    );
    const bundled = fs
      .readdirSync(sourceSkills)
      .filter((name) =>
        fs.existsSync(path.join(sourceSkills, name, "SKILL.md")),
      )
      .sort();

    expect(bundled.length).toBeGreaterThan(0);
    for (const name of bundled) {
      expect(fs.readFileSync(path.join(installedSkills, name, "SKILL.md"))).toEqual(
        fs.readFileSync(path.join(sourceSkills, name, "SKILL.md")),
      );
    }
  });

  it("hands every backend command family to one verified channel CLI without changing context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-handoff-"));
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const seedRoot = path.join(root, "seed");
    const seedCommands = path.join(seedRoot, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_DIR: seedCommands,
        DURE_CLI_INSTALL_ROOT: seedRoot,
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
      stdio: "pipe",
    });
    const seedVersion = fs.realpathSync(path.join(seedRoot, "current"));
    const globalRoot = path.join(root, "share", "hebbian-ide-cli");
    const globalCommands = path.join(root, "login-bin");
    const channel = "dev-handoff";
    const channelRoot = path.join(globalRoot, "channels", channel);
    const stableVersion = prepareMockVersion(
      seedVersion,
      path.join(root, "prepared-stable"),
      "0.1.4+stable-handoff",
      "stable",
    );
    const channelVersion = prepareMockVersion(
      seedVersion,
      path.join(root, "prepared-channel"),
      "0.1.4+channel-handoff",
      "channel",
      channel,
    );
    promoteDureCli({
      sourceVersionDirectory: stableVersion,
      installRoot: globalRoot,
      commandDirectory: globalCommands,
    });
    promoteDureCli({
      sourceVersionDirectory: channelVersion,
      installRoot: channelRoot,
      commandDirectory: path.join(channelRoot, "bin"),
    });
    const log = path.join(root, "handoff.jsonl");
    const commands = [
      ["run", "--backend", "remote-a", "--idempotency-key", "idem-run"],
      ["spawn", "--backend", "remote-a", "--idempotency-key", "idem-spawn"],
      ["projects", "list", "--backend", "remote-a", "--json"],
      ["checkpoint", "--backend", "remote-a", "--json"],
      ["orchestration", "invoke", "read_events", "--backend", "remote-a", "--idempotency-key", "idem-orchestration"],
    ];
    const environment = {
      ...fixtureEnvironment,
      HOME: root,
      DURE_APP_CHANNEL: channel,
      DURE_BACKEND_PROFILE: "session-backend",
      DURE_CHECKPOINT_BINDING_GENERATION: "17",
      DURE_CLI_INSTALL_ROOT: globalRoot,
      DURE_HANDOFF_LOG: log,
      HMUX_SESSION_ID: "session-exact-1",
      HMUX_WORKSPACE_ID: "workspace-exact-1",
    };
    for (const argv of commands) {
      const result = spawnSync(path.join(globalCommands, "dure"), argv, {
        encoding: "utf8",
        env: environment,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    const records = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(commands.length);
    expect(records.map((record) => record.argv)).toEqual(commands);
    for (const record of records) {
      expect(record).toMatchObject({
        target: "channel",
        backend: "session-backend",
        sessionId: "session-exact-1",
        workspaceId: "workspace-exact-1",
        bindingGeneration: "17",
      });
    }
    const assertStableAndChannel = () => {
      for (const selectedChannel of ["stable", channel]) {
        const result = spawnSync(path.join(globalCommands, "dure"), commands[0], {
          encoding: "utf8",
          env: { ...environment, DURE_APP_CHANNEL: selectedChannel },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(
          JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)),
        ).toMatchObject({
          target: selectedChannel === "stable" ? "stable" : "channel",
          argv: commands[0],
        });
        const selectedRoot = selectedChannel === "stable" ? globalRoot : channelRoot;
        expect(inspectCliIdentity({
          scriptPath: path.join(selectedRoot, "current", "bin", "dure.mjs"),
          environment: { ...environment, DURE_APP_CHANNEL: selectedChannel, PATH: globalCommands },
        }).pathMatchesCurrent).toBe(true);
      }
    };
    assertStableAndChannel();
    const globalLauncherPath = path.join(globalRoot, "launcher", "dure.mjs");
    const stableLauncher = fs.readFileSync(globalLauncherPath);
    reconcileDureCliLauncher({
      sourceVersionDirectory: channelVersion,
      installRoot: globalRoot,
      commandDirectory: globalCommands,
    });
    assertStableAndChannel();
    expect(fs.readFileSync(globalLauncherPath)).toEqual(stableLauncher);
    expect(fs.realpathSync(path.join(globalRoot, "current"))).toBe(
      path.join(fs.realpathSync(globalRoot), "versions", path.basename(stableVersion)),
    );
    // A later stable install must still leave dev selection usable.
    promoteDureCli({
      sourceVersionDirectory: stableVersion,
      installRoot: globalRoot,
      commandDirectory: globalCommands,
    });
    assertStableAndChannel();
    const expectHandoffRefused = (reason, env = environment) => {
      const before = fs.readFileSync(log, "utf8");
      const result = spawnSync(path.join(globalCommands, "dure"), commands[0], {
        encoding: "utf8",
        env,
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "cli_update_required",
        error: { reason },
      });
      expect(fs.readFileSync(log, "utf8")).toBe(before);
    };
    fs.appendFileSync(globalLauncherPath, "\n// tampered bootstrap\n");
    expectHandoffRefused("channel launcher does not match its immutable version");
    fs.writeFileSync(globalLauncherPath, stableLauncher);

    const installedStable = fs.realpathSync(path.join(globalRoot, "current"));
    const stableScript = path.join(installedStable, "bin", "dure.mjs");
    const stableScriptBytes = fs.readFileSync(stableScript);
    fs.appendFileSync(stableScript, "\n// tampered owner payload\n");
    expectHandoffRefused("immutable bundle digest does not match");
    expect(() =>
      reconcileDureCliLauncher({
        sourceVersionDirectory: channelVersion,
        installRoot: globalRoot,
        commandDirectory: globalCommands,
      }),
    ).toThrow("immutable bundle digest does not match");
    expect(fs.readFileSync(globalLauncherPath)).toEqual(stableLauncher);
    fs.writeFileSync(stableScript, stableScriptBytes);

    for (const [installRoot, escapedVersion] of [
      [globalRoot, stableVersion],
      [channelRoot, channelVersion],
    ]) {
      const pointer = path.join(installRoot, "current");
      const original = fs.readlinkSync(pointer);
      fs.unlinkSync(pointer);
      fs.symlinkSync(escapedVersion, pointer);
      expectHandoffRefused("channel current pointer escaped immutable versions");
      fs.unlinkSync(pointer);
      fs.symlinkSync(original, pointer);
    }
    expectHandoffRefused("app channel is invalid", {
      ...environment, DURE_APP_CHANNEL: "../stable",
    });
    expectHandoffRefused(
      "channel bundle identity does not match the requested app",
      { ...environment, DURE_APP_CHANNEL: "dev-not-installed" },
    );

    const installedChannel = fs.realpathSync(path.join(channelRoot, "current"));
    const channelMetadataPath = path.join(installedChannel, "install.json");
    const channelMetadataBytes = fs.readFileSync(channelMetadataPath);
    const wrongChannel = JSON.parse(channelMetadataBytes);
    wrongChannel.bundle.app.channel = "dev-wrong";
    fs.writeFileSync(channelMetadataPath, JSON.stringify(wrongChannel));
    expectHandoffRefused("channel bundle identity does not match the requested app");
    fs.writeFileSync(channelMetadataPath, channelMetadataBytes);

    const channelCommand = path.join(installedChannel, "bin", "dure");
    const originalCommand = fs.readlinkSync(channelCommand);
    fs.unlinkSync(channelCommand);
    fs.symlinkSync(stableScript, channelCommand);
    const escapedCommandMetadata = JSON.parse(channelMetadataBytes);
    escapedCommandMetadata.bundle.artifactDigest = artifactDigest(installedChannel);
    fs.writeFileSync(channelMetadataPath, JSON.stringify(escapedCommandMetadata));
    expectHandoffRefused("channel command escaped its immutable version");
    fs.unlinkSync(channelCommand);
    fs.symlinkSync(originalCommand, channelCommand);
    fs.writeFileSync(channelMetadataPath, channelMetadataBytes);
    assertStableAndChannel();
    const backendRoot = path.join(root, "dure-state", "backend");
    fs.mkdirSync(backendRoot, { recursive: true, mode: 0o700 });
    const pointer = path.join(backendRoot, "control-plane.json");
    fs.writeFileSync(
      pointer,
      `${JSON.stringify({
        schemaVersion: 4,
        buildId: CONTROL_PLANE_BUILD_ID,
        generation: "local-v1-11111111111111111111111111111111",
        controlPlaneIdentity: {
          executablePath: controlPlane,
          executableDevice: "1",
          executableInode: "2",
          executableSize: "3",
          executableModified: "4:5",
          executableSha256: "a".repeat(64),
        },
        processId: process.pid,
      })}\n`,
      { mode: 0o600 },
    );
    const schemaFour = spawnSync(path.join(globalCommands, "dure"), commands[0], {
      encoding: "utf8",
      env: { ...environment, DURE_HOME: path.dirname(backendRoot) },
    });
    expect(schemaFour.status, schemaFour.stderr).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)),
    ).toMatchObject({ target: "channel", argv: commands[0] });

    // The verified payload owns backend admission. App control and explicit
    // remote requests must not be blocked by the unrelated local descriptor.
    for (const buildId of [
      controlPlaneFixtureBuildId(1, "newer-fixture"),
      controlPlaneFixtureBuildId(0, "divergent-fixture"),
      "unverifiable-build",
    ]) {
      fs.writeFileSync(
        pointer,
        JSON.stringify({
          schemaVersion: 3,
          buildId,
          generation: "local-v1-11111111111111111111111111111111",
          processId: process.pid,
        }),
        { mode: 0o600 },
      );
      const before = fs.readFileSync(pointer);
      for (const argv of [
        ...commands,
        ["client", "pane", "state", "pane-1", "--json"],
        ["backend", "reconcile", "--json"],
      ]) {
        const handedOff = spawnSync(path.join(globalCommands, "dure"), argv, {
          encoding: "utf8",
          env: { ...environment, DURE_HOME: path.dirname(backendRoot) },
        });
        expect(handedOff.status, handedOff.stderr).toBe(0);
        expect(
          JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)),
        ).toMatchObject({ target: "channel", argv });
        expect(fs.readFileSync(pointer)).toEqual(before);
      }
      expect(fs.existsSync(path.join(backendRoot, "replacement-intents"))).toBe(
        false,
      );
    }
    const pointerBeforeTampering = fs.readFileSync(pointer);
    const beforeRejected = fs.readFileSync(log, "utf8");

    const hmuxBytes = fs.readFileSync(controlPlane);
    fs.appendFileSync(controlPlane, "\n# tampered Hmux fixture\n");
    const unverifiableHmux = spawnSync(
      path.join(globalCommands, "dure"),
      commands[3],
      {
        encoding: "utf8",
        env: { ...environment, DURE_HOME: path.dirname(backendRoot) },
      },
    );
    expect(unverifiableHmux.status).toBe(2);
    expect(JSON.parse(unverifiableHmux.stderr).error.code).toBe(
      "cli_update_required",
    );
    expect(fs.readFileSync(pointer)).toEqual(pointerBeforeTampering);
    expect(fs.readFileSync(log, "utf8")).toBe(beforeRejected);
    fs.writeFileSync(controlPlane, hmuxBytes, { mode: 0o755 });

    const channelScript = path.join(
      fs.realpathSync(path.join(channelRoot, "current")),
      "bin",
      "dure.mjs",
    );
    fs.appendFileSync(channelScript, "\n// tampered\n");
    const pointerBeforeTamper = fs.readFileSync(pointer);
    const unverifiable = spawnSync(
      path.join(globalCommands, "dure"),
      commands[1],
      {
        encoding: "utf8",
        env: { ...environment, DURE_HOME: path.dirname(backendRoot) },
      },
    );
    expect(unverifiable.status).toBe(2);
    expect(JSON.parse(unverifiable.stderr).error.code).toBe(
      "cli_update_required",
    );
    expect(fs.readFileSync(pointer)).toEqual(pointerBeforeTamper);
    expect(fs.readFileSync(log, "utf8")).toBe(beforeRejected);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("repairs a legacy global command when a canonical development channel is staged", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-launcher-migration-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const globalRoot = path.join(
      root,
      ".local",
      "share",
      "hebbian-ide-cli",
    );
    const globalCommands = path.join(root, ".local", "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    const install = (
      channel,
      installRoot,
      commandDirectory,
      hmuxBuildId = "hmux-test-v1",
    ) =>
      execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
        cwd: fixtureRepository,
        env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
          ...fixtureEnvironment,
          HOME: root,
          DURE_APP_CHANNEL: channel,
          DURE_CLI_INSTALL_DIR: commandDirectory,
          DURE_CLI_INSTALL_ROOT: installRoot,
          DURE_CONTROL_PLANE_BIN: controlPlane,
          DURE_HMUX_BIN: controlPlane,
          DURE_HMUX_RUNTIME_BIN: controlPlane,
          DURE_HMUX_BUILD_ID: hmuxBuildId,
        }),
        stdio: "pipe",
      });
    writeControlPlaneFixture(controlPlane);
    install("stable", globalRoot, globalCommands);
    const stableVersion = fs.realpathSync(path.join(globalRoot, "current"));

    fs.unlinkSync(path.join(globalCommands, "dure"));
    const globalCommand = path.join(globalCommands, "dure");
    const customCommand = "#!/bin/sh\nprintf 'custom dure\\n'\n";
    fs.writeFileSync(globalCommand, customCommand, { mode: 0o755 });
    const unmanaged = reconcileDureCliLauncher({
      sourceVersionDirectory: stableVersion,
      installRoot: globalRoot,
      commandDirectory: globalCommands,
    });
    expect(unmanaged.status).toBe("unmanaged");
    expect(fs.readFileSync(globalCommand, "utf8")).toBe(customCommand);

    fs.rmSync(path.join(globalRoot, "launcher"), {
      recursive: true,
      force: true,
    });
    fs.unlinkSync(globalCommand);
    const stableMetadataPath = path.join(stableVersion, "install.json");
    const stableMetadata = JSON.parse(
      fs.readFileSync(stableMetadataPath, "utf8"),
    );
    stableMetadata.schemaVersion = 2;
    stableMetadata.bundle = {
      schemaVersion: 1,
      controlPlane: stableMetadata.bundle.controlPlane,
      orchestration: stableMetadata.bundle.orchestration,
    };
    fs.writeFileSync(
      stableMetadataPath,
      `${JSON.stringify(stableMetadata, null, 2)}\n`,
    );
    fs.symlinkSync(
      path.join(globalRoot, "current", "bin", "dure"),
      globalCommand,
    );

    const channel = "dev-launcher-migration";
    const channelRoot = path.join(globalRoot, "channels", channel);
    install(channel, channelRoot, path.join(channelRoot, "bin"));
    const channelBuild = path.basename(
      fs.realpathSync(path.join(channelRoot, "current")),
    );

    expect(fs.realpathSync(path.join(channelRoot, "bin", "dure"))).toContain(
      `${path.sep}launcher${path.sep}dure.mjs`,
    );
    expect(
      execFileSync(path.join(channelRoot, "bin", "dure"), ["--version"], {
        encoding: "utf8",
        env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: channel },
      }),
    ).toContain(`(${channelBuild})`);
    expect(fs.realpathSync(path.join(globalRoot, "current"))).toBe(
      stableVersion,
    );
    expect(fs.realpathSync(path.join(globalCommands, "dure"))).toContain(
      `${path.sep}launcher${path.sep}dure.mjs`,
    );
    expect(
      execFileSync(path.join(globalCommands, "dure"), ["--version"], {
        encoding: "utf8",
        env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: channel },
      }),
    ).toContain(`(${channelBuild})`);
    const refusedStableReplacement = spawnSync(
      path.join(channelRoot, "bin", "dure"),
      ["install", "--global", "--json"],
      {
        encoding: "utf8",
        env: {
          ...fixtureEnvironment,
          HOME: root,
          DURE_APP_CHANNEL: channel,
          DURE_CLI_INSTALL_DIR: globalCommands,
          DURE_CLI_INSTALL_ROOT: globalRoot,
        },
      },
    );
    expect(refusedStableReplacement.status).toBe(2);
    expect(JSON.parse(refusedStableReplacement.stdout)).toMatchObject({
      error: { code: "dure_cli_install_failed" },
    });
    expect(refusedStableReplacement.stderr).toBe("");
    expect(fs.realpathSync(path.join(globalRoot, "current"))).toBe(
      stableVersion,
    );

    fs.unlinkSync(path.join(globalRoot, "bin", "dure"));
    install(
      channel,
      channelRoot,
      path.join(channelRoot, "bin"),
      "hmux-test-v2",
    );
    const nextChannelBuild = path.basename(
      fs.realpathSync(path.join(channelRoot, "current")),
    );
    expect(nextChannelBuild).not.toBe(channelBuild);
    expect(fs.realpathSync(path.join(globalRoot, "bin", "dure"))).toContain(
      `${path.sep}launcher${path.sep}dure.mjs`,
    );
    expect(
      execFileSync(path.join(globalCommands, "dure"), ["--version"], {
        encoding: "utf8",
        env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: channel },
      }),
    ).toContain(`(${nextChannelBuild})`);
  });

  it("recovers interrupted promotion and launcher reconciliation while preserving immutable builds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-cli-lock-recovery-"));
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const sourceRoot = path.join(root, "source");
    const installRoot = path.join(root, "destination");
    const commandDirectory = path.join(root, "commands");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    const environment = dureCliInstallerFixtureEnvironment(fixtureRepository, {
      ...fixtureEnvironment,
      HOME: root,
      DURE_HOME: path.join(root, "dure-home"),
      HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_INSTALL_ROOT: sourceRoot,
      DURE_CLI_INSTALL_DIR: path.join(sourceRoot, "bin"),
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
    });
    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: environment,
      stdio: "pipe",
    });
    const options = {
      sourceVersionDirectory: fs.realpathSync(path.join(sourceRoot, "current")),
      installRoot,
      commandDirectory,
      lockWaitMs: 0,
    };
    const promotionModule = new URL("../cli/lib/dure-cli-promotion.mjs", import.meta.url).href;
    const interruptMutation = (operation, syscall) => {
      const child = spawnSync(process.execPath, [
        "--input-type=module", "--eval",
        `import fs from 'node:fs';
         import { syncBuiltinESMExports } from 'node:module';
         import { ${operation} } from ${JSON.stringify(promotionModule)};
         fs.${syscall} = () => process.exit(86);
         syncBuiltinESMExports();
         ${operation}(JSON.parse(process.argv[2]));`,
        process.execPath, JSON.stringify(options),
      ], { env: environment, encoding: "utf8" });
      expect(child.status, child.stderr).toBe(86);
      expect(fs.existsSync(path.join(installRoot, ".mutation-lock"))).toBe(true);
    };

    interruptMutation("promoteDureCli", "cpSync");
    const promoted = promoteDureCli(options);
    expect(fs.existsSync(path.join(installRoot, ".mutation-lock"))).toBe(false);
    expect(fs.realpathSync(path.join(installRoot, "current"))).toBe(
      path.join(fs.realpathSync(installRoot), "versions", promoted.buildId),
    );
    interruptMutation("reconcileDureCliLauncher", "copyFileSync");
    expect(reconcileDureCliLauncher(options).status).toBe("current");
    expect(fs.existsSync(path.join(installRoot, ".mutation-lock"))).toBe(false);

    const installedMetadata = path.join(installRoot, "current", "install.json");
    fs.writeFileSync(installedMetadata, "{}\n");
    expect(() => promoteDureCli(options)).toThrow("refusing to replace immutable Dure CLI build");
    expect(fs.readFileSync(installedMetadata, "utf8")).toBe("{}\n");
  });

  it("promotes the running channel CLI into the login-shell install", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-promotion-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const cliVersion = dureCliVersionExpectation(fixtureRepository);
    const channelRoot = path.join(root, "channel");
    const channelCommands = path.join(channelRoot, "bin");
    const globalRoot = path.join(root, "global");
    const globalCommands = path.join(root, "login-bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);

    execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
      cwd: fixtureRepository,
      env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
        ...fixtureEnvironment,
        HOME: root,
        DURE_APP_CHANNEL: "stable",
        DURE_CLI_INSTALL_DIR: channelCommands,
        DURE_CLI_INSTALL_ROOT: channelRoot,
        DURE_CONTROL_PLANE_BIN: controlPlane,
        DURE_HMUX_BIN: controlPlane,
        DURE_HMUX_RUNTIME_BIN: controlPlane,
        DURE_HMUX_BUILD_ID: "hmux-test-v1",
      }),
      stdio: "pipe",
    });

    const promotion = spawnSync(
      path.join(channelCommands, "dure"),
      ["install", "--global", "--json"],
      {
        encoding: "utf8",
        env: {
          ...fixtureEnvironment,
          HOME: root,
          DURE_APP_CHANNEL: "stable",
          DURE_CLI_INSTALL_DIR: globalCommands,
          DURE_CLI_INSTALL_ROOT: globalRoot,
        },
      },
    );

    expect(promotion.status, promotion.stderr).toBe(0);
    expect(JSON.parse(promotion.stdout)).toMatchObject({
      schemaVersion: 1,
      command: path.join(fs.realpathSync(globalCommands), "dure"),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      bundle: {
        schemaVersion: 2,
        controlPlane: {
          buildId: CONTROL_PLANE_BUILD_ID,
          capabilities: CONTROL_PLANE_CAPABILITIES,
        },
      },
    });
    expect(fs.realpathSync(path.join(globalCommands, "dure"))).toContain(
      `${path.sep}global${path.sep}launcher${path.sep}`,
    );
    expect(path.basename(fs.realpathSync(path.join(globalCommands, "dure")))).toBe(
      "dure.mjs",
    );
    fs.rmSync(channelRoot, { recursive: true, force: true });
    expect(
      execFileSync(path.join(globalCommands, "dure"), ["--version"], {
        encoding: "utf8",
        env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" },
      }),
    ).toMatch(cliVersion.installedPrefix);
    expect(
      execFileSync(
        path.join(globalCommands, "dure"),
        ["client", "pane", "--help"],
        {
          encoding: "utf8",
          env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" },
        },
      ),
    ).toContain("dure client pane split");
    expect(
      execFileSync(
        path.join(globalCommands, "dure"),
        ["client", "workspace", "--help"],
        {
          encoding: "utf8",
          env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" },
        },
      ),
    ).toContain("dure client workspace open");
    const installedCommand = path.join(
      fs.realpathSync(path.join(globalRoot, "current")),
      "bin",
      "dure.mjs",
    );
    for (const name of ["dure", "dure-browser"]) {
      const guide = JSON.parse(execFileSync(
        path.join(globalCommands, "dure"), ["skills", "get", name, "--json"],
        { encoding: "utf8", cwd: root, env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" } },
      ));
      expect(guide.markdown).toBe(fs.readFileSync(path.join(fixtureRepository, "cli", "skills", name, "GUIDE.md"), "utf8"));
      expect(guide.cli.buildId).toBe(path.basename(fs.realpathSync(path.join(globalRoot, "current"))));
      if (name === "dure") expect(guide.markdown).toContain("dure client workspace open");
    }
    const explicitModuleBoundary = spawnSync(
      process.execPath,
      [
        "--no-experimental-detect-module",
        path.join(globalCommands, "dure"),
        "--version",
      ],
      {
        encoding: "utf8",
        env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" },
      },
    );
    expect(explicitModuleBoundary.status, explicitModuleBoundary.stderr).toBe(0);
    expect(explicitModuleBoundary.stdout).toMatch(cliVersion.installedPrefix);
    // Guides are part of the immutable payload. A missing guide must refuse
    // the damaged installation rather than return its discovery stub.
    fs.unlinkSync(path.join(path.dirname(installedCommand), "skills", "dure-browser", "GUIDE.md"));
    const missingGuide = spawnSync(path.join(globalCommands, "dure"), ["skills", "get", "dure-browser"], {
      encoding: "utf8", env: { ...fixtureEnvironment, HOME: root, DURE_APP_CHANNEL: "stable" },
    });
    expect(missingGuide.status).toBe(2);
    expect(missingGuide.stdout).toBe("");
    expect(JSON.parse(missingGuide.stderr)).toMatchObject({ error: { code: "cli_update_required", reason: "immutable bundle digest does not match" } });
  });

  it("gives a Dure CLI bundle a new immutable identity when its bound Hmux build changes", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-hmux-identity-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    const install = (hmuxBuildId) =>
      execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
        cwd: fixtureRepository,
        env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
          ...fixtureEnvironment,
          DURE_APP_CHANNEL: "dev-fixture",
          DURE_CLI_INSTALL_DIR: commandDirectory,
          DURE_CLI_INSTALL_ROOT: installRoot,
          DURE_CONTROL_PLANE_BIN: controlPlane,
          DURE_HMUX_BIN: controlPlane,
          DURE_HMUX_RUNTIME_BIN: controlPlane,
          DURE_HMUX_BUILD_ID: hmuxBuildId,
        }),
        stdio: "pipe",
      });

    install("hmux-test-v1");
    const firstVersion = fs.realpathSync(path.join(installRoot, "current"));
    install("hmux-test-v2");
    const secondVersion = fs.realpathSync(path.join(installRoot, "current"));

    expect(secondVersion).not.toBe(firstVersion);
    expect(
      JSON.parse(fs.readFileSync(path.join(secondVersion, "install.json"), "utf8"))
        .bundle.hmux.buildId,
    ).toBe("hmux-test-v2");
  });

  it("promotes the final source after consecutive immutable snapshots stabilize", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-source-race-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    const replacementControlPlane = path.join(
      root,
      "replacement-dure-control-plane",
    );
    const mutationSentinel = path.join(root, "source-mutated");
    const mutationTarget = path.join(
      fixtureRepository,
      "cli",
      "lib",
      "control-plane-build-identity.json",
    );
    const digestContractTarget = path.join(
      fixtureRepository,
      "cli",
      "lib",
      "dure-cli-channel-launcher.mjs",
    );
    const replacementSource = path.join(
      root,
      "replacement-build-identity.json",
    );
    const replacementDigestSource = path.join(
      root,
      "replacement-channel-launcher.mjs",
    );
    const replacementBuildId = controlPlaneFixtureBuildId(
      0,
      "snapshot-fixture",
    );
    const nextBuildIdentity = JSON.parse(
      fs.readFileSync(mutationTarget, "utf8"),
    );
    nextBuildIdentity.currentBuildId = replacementBuildId;
    fs.writeFileSync(
      replacementSource,
      `${JSON.stringify(nextBuildIdentity, null, 2)}\n`,
    );
    const nextDigestContract = fs
      .readFileSync(digestContractTarget, "utf8")
      .replace(
        '  return digest.digest("hex");',
        '  const value = digest.digest("hex");\n  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;',
      );
    expect(nextDigestContract).not.toBe(
      fs.readFileSync(digestContractTarget, "utf8"),
    );
    fs.writeFileSync(replacementDigestSource, nextDigestContract);
    writeSourceMutatingControlPlaneFixture(controlPlane);
    writeControlPlaneFixture(replacementControlPlane, replacementBuildId);
    const environment = dureCliInstallerFixtureEnvironment(fixtureRepository, {
      ...fixtureEnvironment,
      HOME: root,
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_INSTALL_DIR: commandDirectory,
      DURE_CLI_INSTALL_ROOT: installRoot,
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
      DURE_TEST_MUTATION_TARGET: mutationTarget,
      DURE_TEST_MUTATION_SENTINEL: mutationSentinel,
      DURE_TEST_REPLACEMENT_SOURCE: replacementSource,
      DURE_TEST_REPLACEMENT_CONTROL_PLANE: replacementControlPlane,
      DURE_TEST_SECOND_MUTATION_TARGET: digestContractTarget,
      DURE_TEST_SECOND_REPLACEMENT_SOURCE: replacementDigestSource,
    });
    const install = (mutateSource = false) =>
      execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
        cwd: fixtureRepository,
        env: {
          ...environment,
          ...(mutateSource ? { DURE_TEST_MUTATE_SOURCE: "1" } : {}),
        },
        stdio: "pipe",
      });

    install();
    const firstVersion = fs.realpathSync(path.join(installRoot, "current"));
    install(true);

    const stabilizedVersion = fs.realpathSync(path.join(installRoot, "current"));
    expect(stabilizedVersion).not.toBe(firstVersion);
    expect(fs.readFileSync(mutationTarget)).toEqual(
      fs.readFileSync(replacementSource),
    );
    expect(fs.readFileSync(digestContractTarget)).toEqual(
      fs.readFileSync(replacementDigestSource),
    );
    expect(
      fs.readFileSync(
        path.join(
          stabilizedVersion,
          "bin",
          "lib",
          "control-plane-build-identity.json",
        ),
      ),
    ).toEqual(fs.readFileSync(mutationTarget));
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stabilizedVersion, "install.json"), "utf8"),
      ).bundle.controlPlane.buildId,
    ).toBe(replacementBuildId);
  });

  it("fails closed and cleans staging when four source snapshots never stabilize", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-unstable-source-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const stagingDirectory = path.join(root, "tmp");
    const controlPlane = path.join(root, "dure-control-plane");
    const mutationTarget = path.join(
      fixtureRepository,
      "cli",
      "lib",
      "runtime-diagnostics.mjs",
    );
    fs.mkdirSync(stagingDirectory);
    writeSourceMutatingControlPlaneFixture(controlPlane);

    const result = spawnSync(
      process.execPath,
      ["scripts/install-dure-cli.mjs"],
      {
        cwd: fixtureRepository,
        encoding: "utf8",
        env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
          ...fixtureEnvironment,
          HOME: root,
          TMPDIR: stagingDirectory,
          DURE_APP_CHANNEL: "stable",
          DURE_CLI_INSTALL_DIR: commandDirectory,
          DURE_CLI_INSTALL_ROOT: installRoot,
          DURE_CONTROL_PLANE_BIN: controlPlane,
          DURE_HMUX_BIN: controlPlane,
          DURE_HMUX_RUNTIME_BIN: controlPlane,
          DURE_HMUX_BUILD_ID: "hmux-test-v1",
          DURE_TEST_MUTATE_SOURCE: "1",
          DURE_TEST_MUTATION_TARGET: mutationTarget,
        }),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DureCliInstallSourceUnstableError");
    expect(result.stderr).toContain("dure_cli_source_unstable");
    expect(
      fs
        .readFileSync(mutationTarget, "utf8")
        .match(/source changed during install/g),
    ).toHaveLength(4);
    expect(fs.existsSync(installRoot)).toBe(false);
    expect(fs.existsSync(commandDirectory)).toBe(false);
    expect(fs.readdirSync(stagingDirectory)).toEqual([]);
  });

  it("rejects an unsafe default build identity before any path can escape staging", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-unsafe-package-version-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const stagingDirectory = path.join(root, "tmp");
    const controlPlane = path.join(root, "dure-control-plane");
    const packageManifestPath = path.join(
      fixtureRepository,
      "cli",
      "package.json",
    );
    const packageManifest = JSON.parse(
      fs.readFileSync(packageManifestPath, "utf8"),
    );
    packageManifest.version = "../../escaped-build";
    fs.writeFileSync(
      packageManifestPath,
      `${JSON.stringify(packageManifest, null, 2)}\n`,
    );
    fs.mkdirSync(stagingDirectory);
    writeControlPlaneFixture(controlPlane);

    const result = spawnSync(
      process.execPath,
      ["scripts/install-dure-cli.mjs"],
      {
        cwd: fixtureRepository,
        encoding: "utf8",
        env: dureCliInstallerFixtureEnvironment(fixtureRepository, {
          ...fixtureEnvironment,
          HOME: root,
          TMPDIR: stagingDirectory,
          DURE_APP_CHANNEL: "stable",
          DURE_CLI_INSTALL_DIR: commandDirectory,
          DURE_CLI_INSTALL_ROOT: installRoot,
          DURE_CONTROL_PLANE_BIN: controlPlane,
          DURE_HMUX_BIN: controlPlane,
          DURE_HMUX_RUNTIME_BIN: controlPlane,
          DURE_HMUX_BUILD_ID: "hmux-test-v1",
        }),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DURE_CLI_BUILD_ID must be one safe path component",
    );
    expect(fs.existsSync(installRoot)).toBe(false);
    expect(fs.existsSync(commandDirectory)).toBe(false);
    expect(fs.readdirSync(stagingDirectory)).toEqual([]);
  });

  it("leaves a legacy mislabeled immutable build intact and selects a new snapshot identity", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "dure-cli-legacy-race-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    const mutationTarget = path.join(
      fixtureRepository,
      "cli",
      "lib",
      "runtime-diagnostics.mjs",
    );
    writeControlPlaneFixture(controlPlane);
    const legacyBuildId = legacyDefaultBuildId(
      fixtureRepository,
      controlPlane,
    );
    const originalSource = fs.readFileSync(mutationTarget);
    fs.appendFileSync(mutationTarget, "\n// legacy raced payload\n");
    const environment = dureCliInstallerFixtureEnvironment(fixtureRepository, {
      ...fixtureEnvironment,
      HOME: root,
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_INSTALL_DIR: commandDirectory,
      DURE_CLI_INSTALL_ROOT: installRoot,
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
    });
    const install = (buildId) =>
      execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
        cwd: fixtureRepository,
        env: {
          ...environment,
          ...(buildId ? { DURE_CLI_BUILD_ID: buildId } : {}),
        },
        stdio: "pipe",
      });

    install(legacyBuildId);
    const legacyVersion = fs.realpathSync(path.join(installRoot, "current"));
    const legacyMetadata = fs.readFileSync(
      path.join(legacyVersion, "install.json"),
    );
    const legacyArtifactDigest = artifactDigest(legacyVersion);
    fs.writeFileSync(mutationTarget, originalSource);
    install();

    const currentVersion = fs.realpathSync(path.join(installRoot, "current"));
    expect(currentVersion).not.toBe(legacyVersion);
    expect(fs.readFileSync(path.join(legacyVersion, "install.json"))).toEqual(
      legacyMetadata,
    );
    expect(artifactDigest(legacyVersion)).toBe(legacyArtifactDigest);
    expect(
      fs.readFileSync(
        path.join(currentVersion, "bin", "lib", "runtime-diagnostics.mjs"),
      ),
    ).toEqual(originalSource);
  });

  it("installs dure atomically with deprecated compatibility aliases", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hebbian-ide-cli-install-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const cliVersion = dureCliVersionExpectation(fixtureRepository);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    fs.mkdirSync(commandDirectory, { recursive: true });
    const existingHebbian = path.join(commandDirectory, "hebbian");
    const controlPlane = path.join(root, "dure-control-plane");
    fs.writeFileSync(existingHebbian, "#!/bin/sh\necho agents-cli\n", {
      mode: 0o755,
    });
    writeControlPlaneFixture(controlPlane);
    const environment = dureCliInstallerFixtureEnvironment(fixtureRepository, {
      ...fixtureEnvironment,
      HOME: root,
      DURE_HOME: path.join(root, "dure-state"),
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_INSTALL_DIR: commandDirectory,
      DURE_CLI_INSTALL_ROOT: installRoot,
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
    });

    const previousUmask = process.umask(0o077);
    try {
      execFileSync(process.execPath, ["scripts/install-dure-cli.mjs"], {
        cwd: fixtureRepository,
        env: environment,
        stdio: "pipe",
      });
      execFileSync(process.execPath, ["scripts/install-hebbian-ide-cli.mjs"], {
        cwd: fixtureRepository,
        env: environment,
        stdio: "pipe",
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.readFileSync(existingHebbian, "utf8")).toContain("agents-cli");
    expect(
      fs.lstatSync(path.join(commandDirectory, "dure")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs
        .lstatSync(path.join(commandDirectory, "dure-control-plane"))
        .isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(commandDirectory, "hebbian-ade")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(commandDirectory, "hebbian-ide")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.realpathSync(path.join(commandDirectory, "dure")),
    ).toContain("/launcher/");
    expect(fs.realpathSync(path.join(commandDirectory, "hebbian-ade"))).toBe(
      fs.realpathSync(path.join(commandDirectory, "dure")),
    );
    expect(fs.realpathSync(path.join(commandDirectory, "hebbian-ide"))).toBe(
      fs.realpathSync(path.join(commandDirectory, "dure")),
    );
    const currentBinaryDirectory = path.join(
      fs.realpathSync(path.join(installRoot, "current")),
      "bin",
    );
    const currentVersionDirectory = path.dirname(currentBinaryDirectory);
    const installMetadata = JSON.parse(
      fs.readFileSync(path.join(currentVersionDirectory, "install.json"), "utf8"),
    );
    expect(installMetadata.bundle).toMatchObject({
      schemaVersion: 2,
      controlPlane: {
        apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
        buildId: CONTROL_PLANE_BUILD_ID,
        capabilities: CONTROL_PLANE_CAPABILITIES,
      },
      orchestration: {
        apiVersion: "dure.orchestration/v1",
      },
    });
    expect(installMetadata.bundle.controlPlane.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(installMetadata.bundle.orchestration.digest).toMatch(/^[a-f0-9]{64}$/);
    const cataloguePath = path.join(currentBinaryDirectory, "orchestration-mcp-catalogue.json");
    expect(fs.existsSync(cataloguePath)).toBe(true);
    const actualCatalogue = execFileSync(
      process.execPath,
      [path.join(currentBinaryDirectory, "lib", "orchestration-mcp-server.mjs"), "--catalogue"],
      { encoding: "utf8", env: {} },
    );
    expect(JSON.parse(fs.readFileSync(cataloguePath, "utf8"))).toEqual(JSON.parse(actualCatalogue));
    expect(artifactDigest(currentVersionDirectory)).toBe(installMetadata.bundle.artifactDigest);
    const catalogueBytes = fs.readFileSync(cataloguePath);
    fs.appendFileSync(cataloguePath, "\n");
    expect(artifactDigest(currentVersionDirectory)).not.toBe(installMetadata.bundle.artifactDigest);
    fs.writeFileSync(cataloguePath, catalogueBytes);
    expect(
      fs.lstatSync(path.join(currentBinaryDirectory, "hebbian-ade")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.readlinkSync(path.join(currentBinaryDirectory, "hebbian-ade")),
    ).toBe("dure");
    expect(
      fs.lstatSync(path.join(currentBinaryDirectory, "hebbian-ide")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.readlinkSync(path.join(currentBinaryDirectory, "hebbian-ide")),
    ).toBe("dure");
    expect(
      fs.existsSync(
        path.join(
          currentBinaryDirectory,
          "skills",
          "dure",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(currentBinaryDirectory, "dure-control-plane"),
        "utf8",
      ),
    ).toContain("exit 0");
    const installedCli = path.join(currentBinaryDirectory, "dure.mjs");
    expect(
      fs.realpathSync(path.join(commandDirectory, "dure-control-plane")),
    ).toBe(path.join(currentBinaryDirectory, "dure-control-plane"));
    expect(resolveLocalBackendExecutable(installedCli, {})).toBe(
      path.join(path.dirname(installedCli), "dure-control-plane"),
    );
    expect(
      fs.existsSync(
        path.join(currentBinaryDirectory, "lib", "runtime-diagnostics.mjs"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(currentBinaryDirectory, "lib", "session-attach.mjs"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(currentBinaryDirectory, "lib", "schedule-client.mjs"),
      ),
    ).toBe(true);
    const version = execFileSync(path.join(commandDirectory, "dure"), ["--version"], {
      encoding: "utf8",
      env: environment,
    });
    expect(version).toMatch(cliVersion.installedOutput);
    const canonicalHelp = execFileSync(
      path.join(commandDirectory, "dure"),
      ["--help"],
      { encoding: "utf8", env: environment },
    );
    expect(canonicalHelp).toContain("dure enter <name>");
    expect(canonicalHelp).toContain(
      "Deprecated compatibility aliases: hebbian-ade, hebbian-ide",
    );
    for (const alias of ["hebbian-ade", "hebbian-ide"]) {
      const compatibilityHelp = spawnSync(
        path.join(commandDirectory, alias),
        ["--help"],
        { encoding: "utf8", env: environment },
      );
      expect(compatibilityHelp.status).toBe(0);
      expect(compatibilityHelp.stdout).toBe(canonicalHelp);
      expect(compatibilityHelp.stderr).toBe(
        `[deprecated] ${alias} is deprecated; use dure instead.\n`,
      );
    }

    const previousCurrent = fs.realpathSync(path.join(installRoot, "current"));
    const rejectedBuild = `${installMetadata.buildId}.rejected`;
    const preparedVersions = path.join(root, "prepared", "versions");
    const rejectedVersion = path.join(preparedVersions, rejectedBuild);
    fs.mkdirSync(preparedVersions, { recursive: true });
    fs.cpSync(previousCurrent, rejectedVersion, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const rejectedMetadataPath = path.join(rejectedVersion, "install.json");
    const rejectedMetadata = JSON.parse(
      fs.readFileSync(rejectedMetadataPath, "utf8"),
    );
    rejectedMetadata.buildId = rejectedBuild;
    rejectedMetadata.bundle.controlPlane.digest = "0".repeat(64);
    rejectedMetadata.bundle.artifactDigest = artifactDigest(rejectedVersion);
    fs.writeFileSync(
      rejectedMetadataPath,
      `${JSON.stringify(rejectedMetadata, null, 2)}\n`,
    );
    expect(() =>
      promoteDureCli({
        sourceVersionDirectory: rejectedVersion,
        installRoot,
        commandDirectory,
      }),
    ).toThrow(/control-plane digest/);
    expect(fs.realpathSync(path.join(installRoot, "current"))).toBe(
      previousCurrent,
    );
  });

  it("refuses to reuse an immutable build after bundled skill tampering", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hebbian-ide-cli-tamper-"),
    );
    temporaryDirectories.push(root);
    const fixtureRepository = copyInstallerFixture(root);
    const installRoot = path.join(root, "share", "hebbian-ide-cli");
    const commandDirectory = path.join(root, "bin");
    const controlPlane = path.join(root, "dure-control-plane");
    writeControlPlaneFixture(controlPlane);
    const environment = dureCliInstallerFixtureEnvironment(fixtureRepository, {
      ...fixtureEnvironment,
      DURE_APP_CHANNEL: "stable",
      HEBBIAN_IDE_CLI_INSTALL_DIR: commandDirectory,
      HEBBIAN_IDE_CLI_INSTALL_ROOT: installRoot,
      DURE_CONTROL_PLANE_BIN: controlPlane,
      DURE_HMUX_BIN: controlPlane,
      DURE_HMUX_RUNTIME_BIN: controlPlane,
      DURE_HMUX_BUILD_ID: "hmux-test-v1",
    });
    const install = () =>
      execFileSync(process.execPath, ["scripts/install-hebbian-ide-cli.mjs"], {
        cwd: fixtureRepository,
        env: environment,
        stdio: "pipe",
      });

    install();
    const skillPath = path.join(
      fs.realpathSync(path.join(installRoot, "current")),
      "bin",
      "skills",
      "dure",
      "SKILL.md",
    );
    fs.appendFileSync(skillPath, "\ntampered\n");

    expect(install).toThrow(/immutable Dure CLI build/);
  });
});

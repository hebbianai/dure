import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateDevControlPlaneTarget,
  devControlPlaneActivationMatches,
  devControlPlaneArtifactReadiness,
  hasPendingDevControlPlaneActivation,
  installDevControlPlanePayload,
  parseDevControlPlaneActivationProof,
  reconcileDevControlPlaneActivation,
} from "./dev-control-plane-activation.mjs";
import { devHmuxToolPaths, worktreeDevIdentity } from "./app-channel.mjs";
import { artifactDigest } from "../../cli/lib/dure-cli-channel-launcher.mjs";

const TARGET = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const CONTROL_PLANE_DIGEST = "2".repeat(64);
const BACKEND_GENERATION = `local-v1-${"4".repeat(32)}`;
const HMUX_RUNTIME_COMMAND =
  process.platform === "win32" ? "hmux-runtime.exe" : "hmux-runtime";

function metadata(sourceRevision) {
  return {
    buildId: "0.1.4+same-semantic-build",
    bundle: {
      app: { schemaVersion: 2, channel: "dev-test", sourceRevision },
    },
  };
}

function proof(sourceRevision = TARGET) {
  return {
    schemaVersion: 1,
    sourceRevision,
    cliArtifactDigest: "1".repeat(64),
    controlPlaneExecutableSha256: CONTROL_PLANE_DIGEST,
    claudePayloadDigest: "3".repeat(64),
    backendId: "dure-local",
    backendGeneration: BACKEND_GENERATION,
  };
}

function executableIdentity(executablePath, executableSha256) {
  return {
    executablePath,
    executableDevice: "1",
    executableInode: "2",
    executableSize: "3",
    executableModified: "4:5",
    executableSha256,
  };
}

describe("dev control-plane activation", () => {
  it("accepts one verified payload digest across byte-identical locations", () => {
    const immutableIdentity = executableIdentity(
      "/immutable/channel/version/bin/dure-control-plane",
      CONTROL_PLANE_DIGEST,
    );
    const descriptor = {
      backendId: "dure-local",
      generation: BACKEND_GENERATION,
      controlPlaneIdentity: executableIdentity(
        "/workspace/target/release/dure-control-plane",
        CONTROL_PLANE_DIGEST,
      ),
    };
    const receipt = {
      authority: {
        backendId: "dure-local",
        generation: BACKEND_GENERATION,
      },
    };
    const expectedExecutableSha256 = immutableIdentity.executableSha256;

    expect(descriptor.controlPlaneIdentity.executablePath).not.toBe(
      immutableIdentity.executablePath,
    );
    expect(
      devControlPlaneActivationMatches({
        descriptor,
        receipt,
        expectedExecutableSha256,
      }),
    ).toBe(true);
    const mismatches = [
      {
        ...descriptor,
        controlPlaneIdentity: executableIdentity(
          descriptor.controlPlaneIdentity.executablePath,
          "9".repeat(64),
        ),
      },
      { ...descriptor, generation: `local-v1-${"8".repeat(32)}` },
      { ...descriptor, backendId: "other-backend" },
      { ...descriptor, controlPlaneIdentity: null },
    ];
    for (const mismatch of mismatches) {
      expect(
        devControlPlaneActivationMatches({
          descriptor: mismatch,
          receipt,
          expectedExecutableSha256,
        }),
      ).toBe(false);
    }
  });

  it("keeps a deployment pending while the same-build channel still points at the previous source payload", () => {
    expect(
      devControlPlaneArtifactReadiness(metadata(PREVIOUS), TARGET),
    ).toMatchObject({ status: "pending" });
    expect(
      devControlPlaneArtifactReadiness(metadata(TARGET), TARGET),
    ).toEqual({ status: "ready", sourceRevision: TARGET });
  });

  it("binds the executable and Claude payload digests to the exact deployment source", () => {
    expect(parseDevControlPlaneActivationProof(proof(), TARGET)).toEqual(
      proof(),
    );
    expect(() =>
      parseDevControlPlaneActivationProof(proof(PREVIOUS), TARGET),
    ).toThrow(/activation proof is invalid/);
  });

  it("carries forward only unproven application-receipt backend debt", () => {
    expect(
      hasPendingDevControlPlaneActivation({
        backendHead: TARGET,
        appliedAtMs: 1,
      }),
    ).toBe(true);
    expect(
      hasPendingDevControlPlaneActivation({
        backendHead: TARGET,
        appliedAtMs: 1,
        controlPlaneActivation: proof(),
      }),
    ).toBe(false);
    expect(
      hasPendingDevControlPlaneActivation({
        backendHead: TARGET,
        verifiedAtMs: 1,
      }),
    ).toBe(false);
  });

  it("installs the exact target into its isolated app channel", () => {
    const root = process.cwd();
    const homeDirectory = join(root, ".control-plane-activation-test-home");
    let invocation;
    installDevControlPlanePayload({
      root,
      targetHead: TARGET,
      homeDirectory,
      environment: {
        HOME: homeDirectory,
        PATH: process.env.PATH,
        DURE_CLI_BUILD_ID: "stale-build",
        DURE_CONTROL_PLANE_BIN: "/tmp/stale-control-plane",
        DURE_HMUX_BUILD_ID: "stale-hmux",
      },
      execute(file, args, options) {
        invocation = { file, args, options };
        return "";
      },
    });

    const { channel } = worktreeDevIdentity(root);
    const cliRoot = join(
      homeDirectory,
      ".local",
      "share",
      "hebbian-ide-cli",
      "channels",
      channel,
    );
    const hmux = devHmuxToolPaths(homeDirectory, channel);
    expect(invocation).toMatchObject({
      file: process.execPath,
      args: [`${root}/scripts/install-dure-cli.mjs`, "--development"],
      options: {
        cwd: root,
        env: {
          HOME: homeDirectory,
          DURE_APP_CHANNEL: channel,
          DURE_CLI_INSTALL_ROOT: cliRoot,
          DURE_CLI_INSTALL_DIR: join(cliRoot, "bin"),
          DURE_CLI_SOURCE_REVISION: TARGET,
          DURE_HMUX_BIN: hmux.hmuxCommand,
          DURE_HMUX_RUNTIME_BIN: join(
            hmux.commandDirectory,
            HMUX_RUNTIME_COMMAND,
          ),
        },
      },
    });
    expect(invocation.options.env).not.toHaveProperty("DURE_CLI_BUILD_ID");
    expect(invocation.options.env).not.toHaveProperty(
      "DURE_CONTROL_PLANE_BIN",
    );
    expect(invocation.options.env).not.toHaveProperty("DURE_HMUX_BUILD_ID");
  });

  it("stages a missing payload once and waits for its journaled replacement", async () => {
    const inspections = [
      { status: "pending", reason: "old source" },
      { status: "ready", sourceRevision: TARGET },
    ];
    const reconciliations = [
      { status: "pending", reason: "recovering" },
      { status: "ok", reason: "active", proof: proof() },
    ];
    let installs = 0;
    let clock = 0;
    const result = await activateDevControlPlaneTarget(
      {
        root: process.cwd(),
        targetHead: TARGET,
        timeoutMs: 1_000,
      },
      {
        inspect: () => inspections.shift(),
        install: () => {
          installs += 1;
        },
        reconcile: () => reconciliations.shift(),
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );

    expect(installs).toBe(1);
    expect(result).toEqual({
      status: "ok",
      reason: "active",
      proof: proof(),
      staged: true,
    });
  });

  it("returns pending instead of claiming an unactivated payload", async () => {
    let clock = 0;
    const result = await activateDevControlPlaneTarget(
      {
        root: process.cwd(),
        targetHead: TARGET,
        timeoutMs: 250,
      },
      {
        inspect: () => ({ status: "ready", sourceRevision: TARGET }),
        install: () => {
          throw new Error("an exact staged payload must not be rebuilt");
        },
        reconcile: () => ({ status: "pending", reason: "recovering" }),
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );

    expect(result).toEqual({
      status: "pending",
      reason: "recovering",
      staged: false,
    });
  });
});

const reconciliationRoots = [];
afterEach(() => {
  for (const root of reconciliationRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reconciles the verified control plane despite another channel in the inherited environment", () => {
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "dure-control-plane-reconcile-"));
  reconciliationRoots.push(temporaryRoot);
  const root = join(temporaryRoot, "live-checkout");
  const homeDirectory = join(temporaryRoot, "home");
  const dureHome = join(temporaryRoot, "dure");
  const discoveryRoot = join(temporaryRoot, "hmux-discovery");
  for (const directory of [root, homeDirectory, dureHome, discoveryRoot]) mkdirSync(directory, { mode: 0o700 });
  const { channel } = worktreeDevIdentity(root);
  const installRoot = join(homeDirectory, ".local/share/hebbian-ide-cli/channels", channel);
  assert.ok(installRoot.startsWith(`${temporaryRoot}/`));
  const targetHead = "a".repeat(40);
  execFileSync(process.execPath, [join(sourceRoot, "scripts/fixtures/install-dev-control-plane-payload.mjs")], {
    cwd: root,
    env: {
      HOME: homeDirectory,
      DURE_HOME: dureHome,
      HMUX_DISCOVERY_ROOT: discoveryRoot,
      DURE_APP_CHANNEL: channel,
      DURE_CLI_SOURCE_REVISION: targetHead,
      DURE_CLI_INSTALL_ROOT: installRoot,
    },
  });
  const versionRoot = realpathSync(join(installRoot, "current"));
  const cliScriptPath = join(versionRoot, "bin/dure.mjs");
  const targetExecutable = join(versionRoot, "bin/dure-control-plane");
  const staleExecutable = join(temporaryRoot, "qa-channel-control-plane");
  writeFileSync(staleExecutable, "#!/bin/sh\n# Previous QA channel payload\nexit 0\n", { mode: 0o700 });
  const resolverModule = pathToFileURL(join(sourceRoot, "cli/lib/local-backend.mjs")).href;
  writeFileSync(cliScriptPath, `
  import { createHash } from "node:crypto";
  import { execFileSync } from "node:child_process";
  import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { fileURLToPath } from "node:url";
  import { resolveLocalBackendExecutable } from ${JSON.stringify(resolverModule)};
  if (process.argv.slice(2).join(" ") !== "backend activate --json") {
    throw new Error("deployment must explicitly activate its verified bundle, not just connect");
  }
  const executablePath = realpathSync(resolveLocalBackendExecutable(fileURLToPath(import.meta.url), process.env));
  execFileSync(executablePath, [], { env: process.env });
  const executableSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  const generation = "local-v1-" + executableSha256.slice(0, 32);
  const backend = join(process.env.DURE_HOME, "backend");
  mkdirSync(backend, { recursive: true, mode: 0o700 });
  writeFileSync(join(backend, "control-plane.json"), JSON.stringify({
    schemaVersion: 5,
    backendId: "dure-local",
    generation,
    controlPlaneIdentity: {
      executablePath, executableSha256,
      executableDevice: "1", executableInode: "1", executableSize: "1", executableModified: "1:1",
    },
    observedHome: process.env.DURE_HOME,
    observedDiscoveryRoot: process.env.HMUX_DISCOVERY_ROOT,
    observedHmux: process.env.DURE_HMUX_BIN,
    observedRuntime: process.env.DURE_HMUX_RUNTIME_BIN,
  }));
  process.stdout.write(JSON.stringify({
    schemaVersion: 1, apiVersion: "dure.backend-reconcile/v1", kind: "dure.backend.reconcile", status: "ready",
    authority: { backendId: "dure-local", generation },
  }));
  `);
  const metadataPath = join(versionRoot, "install.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.bundle.artifactDigest = artifactDigest(versionRoot);
  metadata.sourceDigest = createHash("sha256")
    .update("dure-cli-stabilized-snapshot-v3\0")
    .update(JSON.stringify({
      schemaVersion: 3,
      packageVersion: metadata.packageVersion,
      artifactDigest: metadata.bundle.artifactDigest,
      app: metadata.bundle.app,
      controlPlane: metadata.bundle.controlPlane,
      orchestration: metadata.bundle.orchestration,
      hmux: metadata.bundle.hmux,
    }))
    .update("\0").digest("hex");
  writeFileSync(metadataPath, JSON.stringify(metadata));

  for (const override of [undefined, staleExecutable]) {
    const result = reconcileDevControlPlaneActivation({
      root, targetHead, homeDirectory,
      environment: {
        HOME: homeDirectory,
        DURE_HOME: dureHome,
        HMUX_DISCOVERY_ROOT: discoveryRoot,
        ...(override ? { DURE_CONTROL_PLANE_BIN: override } : {}),
      },
    });
    const descriptor = JSON.parse(readFileSync(join(dureHome, "backend/control-plane.json"), "utf8"));
    assert.equal(descriptor.observedHome, dureHome);
    assert.equal(descriptor.observedDiscoveryRoot, discoveryRoot);
    assert.equal(descriptor.observedHmux, metadata.bundle.hmux.executablePath);
    assert.equal(descriptor.observedRuntime, metadata.bundle.hmux.runtimeExecutablePath);
    assert.equal(descriptor.controlPlaneIdentity.executablePath, targetExecutable, "deployment must execute its verified channel's control plane despite a stale inherited override");
    assert.equal(result.status, "ok");
  }
});

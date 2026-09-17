import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID,
  PREVIOUS_CONTROL_PLANE_BUILD_ID,
} from "../cli/lib/control-plane-contract.mjs";
import {
  defaultHmuxDiscoveryRoot,
  resolveHmuxToolchainIdentity,
  selectBackendProfileForRequest,
} from "../cli/lib/local-backend.mjs";
import {
  ensureLocalBackendReplacementIntent,
  replacementConfirmationForDescriptor,
  replacementIntentForDescriptor,
  replacementIntentForVerifiedDescriptor,
} from "../cli/lib/local-backend-replacement.mjs";
import {
  identityFileAuth,
  sshBackendProfile,
} from "./lib/dure-cli-ssh-fixture.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-local-backend-selection-"));
  temporaryRoots.push(root);
  return root;
}

function hmuxToolchainIdentity(root) {
  return {
    executablePath: join(root, "hmux"),
    executableDevice: "1",
    executableInode: "2",
    executableSize: "3",
    executableModified: "4:5",
    executableSha256: "a".repeat(64),
    runtimeExecutablePath: join(root, "hmux-runtime"),
    runtimeExecutableDevice: "8",
    runtimeExecutableInode: "9",
    runtimeExecutableSize: "10",
    runtimeExecutableModified: "11:12",
    runtimeExecutableSha256: "b".repeat(64),
    discoveryRoot: join(root, "hmux-discovery"),
    discoveryDevice: "6",
    discoveryInode: "7",
  };
}

function catalog(root) {
  return {
    schemaVersion: 1,
    kind: "dure.backend_profiles",
    profiles: [
      {
        id: "local",
        default: true,
        transport: {
          kind: "local",
          endpoint: {
            kind: "unix_socket",
            path: join(root, "backend/control-plane.sock"),
          },
        },
        auth: { kind: "peer" },
        trust: { kind: "local_peer" },
        expected: {
          backendId: "dure-local",
          generation: "local-v1-11111111111111111111111111111111",
          protocol: {
            minimum: { major: 1, minor: 0 },
            maximum: { major: 1, minor: 0 },
          },
          capabilities: [
            "agent_checkpoint.binding.ensure",
            "agent_checkpoint.observe",
            "agent_checkpoint.read",
            "agent_checkpoint.write",
            "client_view.authority.read",
            "client_view.generation.advance",
            "client_view.read",
            "client_view.write",
            "projects.list",
            "projects.show",
            "sessions.list",
            "sessions.show",
            "workflow.delegate_once",
            "workflow.delegate_once.complete",
            "workflow.delegate_once.show",
          ],
        },
        deadlineMs: 10_000,
      },
      sshBackendProfile({
        id: "remote",
        user: "runner",
        endpointPort: 4317,
        auth: identityFileAuth("remote"),
        capabilities: ["agent_checkpoint.read", "agent_checkpoint.write"],
      }),
    ],
  };
}

function fixture() {
  const root = temporaryRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const config = join(root, "backend-profiles.json");
  writeFileSync(config, JSON.stringify(catalog(root)), { mode: 0o600 });
  chmodSync(config, 0o600);
  return {
    environment: {
      DURE_CONTROL_PLANE_BIN: join(root, "missing-control-plane"),
      DURE_HOME: root,
    },
    root,
  };
}

// The checkpoint command retired 2026-08-27; the profile selection it
// exercised is the generic request path other commands still share.
describe("backend profile selection", () => {
  it("binds the Hmux writer to the canonical Dure home", () => {
    expect(
      defaultHmuxDiscoveryRoot({
        DURE_HOME: "/isolated/dure",
        HOME: "/ambient/home",
        XDG_STATE_HOME: "/ambient/state",
      }),
    ).toBe("/isolated/dure/state/hmux-hosts");
    expect(defaultHmuxDiscoveryRoot({ HOME: "/isolated/home" })).toBe(
      "/isolated/home/.dure/state/hmux-hosts",
    );
  });

  it("binds distinct Hmux CLI and runtime identities with a canonical discovery root", () => {
    const root = temporaryRoot();
    const executable = join(root, "hmux");
    const runtimeExecutable = join(root, "hmux-runtime");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(runtimeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    chmodSync(runtimeExecutable, 0o700);
    const dureHome = join(root, "dure");

    const identity = resolveHmuxToolchainIdentity({
      DURE_HMUX_BIN: executable,
      DURE_HOME: dureHome,
      HOME: join(root, "ambient-home"),
      PATH: "",
    });

    expect(identity.discoveryRoot).toBe(
      realpathSync(join(dureHome, "state/hmux-hosts")),
    );
    expect(identity.executablePath).toBe(realpathSync(executable));
    expect(identity.runtimeExecutablePath).toBe(
      realpathSync(runtimeExecutable),
    );
    expect(existsSync(identity.discoveryRoot)).toBe(true);
    expect(() =>
      resolveHmuxToolchainIdentity({
        DURE_HMUX_BIN: executable,
        DURE_HMUX_RUNTIME_BIN: join(root, "missing-runtime"),
        DURE_HOME: dureHome,
        PATH: "",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "local_backend_hmux_runtime_executable_invalid",
      }),
    );

    const explicit = join(root, "exact-discovery");
    mkdirSync(explicit, { mode: 0o700 });
    expect(
      resolveHmuxToolchainIdentity({
        DURE_HMUX_BIN: executable,
        DURE_HMUX_RUNTIME_BIN: runtimeExecutable,
        DURE_HOME: join(root, "decoy-dure"),
        HMUX_DISCOVERY_ROOT: explicit,
        PATH: "",
      }).discoveryRoot,
    ).toBe(realpathSync(explicit));
    expect(() =>
      resolveHmuxToolchainIdentity({
        DURE_HMUX_BIN: executable,
        DURE_HMUX_RUNTIME_BIN: runtimeExecutable,
        DURE_HOME: dureHome,
        HMUX_DISCOVERY_ROOT: "",
        PATH: "",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "local_backend_hmux_discovery_root_invalid",
      }),
    );
  });

  it("does not bootstrap a broken local backend for an explicit remote profile", async () => {
    const { environment, root } = fixture();
    const selection = await selectBackendProfileForRequest({
      cliScriptPath: join(root, "dure.mjs"),
      environment,
      explicitId: "remote",
    });

    expect(selection.profile.id).toBe("remote");
    expect(selection.managedLocal).toBe(false);
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it("keeps an environment-selected remote profile independent from local", async () => {
    const { environment, root } = fixture();
    const selection = await selectBackendProfileForRequest({
      cliScriptPath: join(root, "dure.mjs"),
      environment: { ...environment, DURE_BACKEND_PROFILE: "remote" },
    });

    expect(selection.profile.id).toBe("remote");
    expect(selection.managedLocal).toBe(false);
    expect(existsSync(join(root, "backend"))).toBe(false);
  });

  it("persists one exact successor per source generation", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "backend"), { mode: 0o700 });
    const sourceGeneration = "local-v1-11111111111111111111111111111111";
    const sourceDescriptor = {
      generation: sourceGeneration,
      buildId: PREVIOUS_CONTROL_PLANE_BUILD_ID,
    };
    const targetHmuxIdentity = hmuxToolchainIdentity(root);
    const targetControlPlaneIdentity = {
      executablePath: join(root, "dure-control-plane"),
      executableDevice: "8",
      executableInode: "9",
      executableSize: "10",
      executableModified: "11:12",
      executableSha256: "c".repeat(64),
    };
    const first = ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor,
      sourceGeneration,
      targetBuildId: CONTROL_PLANE_BUILD_ID,
      targetControlPlaneIdentity,
      targetHmuxIdentity,
      now: () => 10,
    });
    const repeated = ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor,
      sourceGeneration,
      targetBuildId: CONTROL_PLANE_BUILD_ID,
      targetControlPlaneIdentity,
      targetHmuxIdentity,
      now: () => 20,
    });

    expect(repeated).toEqual(first);
    expect(first.createdAtMs).toBe(10);
    expect(
      existsSync(
        join(root, "backend", "replacement-intents", `${sourceGeneration}.json`),
      ),
    ).toBe(true);
    expect(() =>
      ensureLocalBackendReplacementIntent({
        root,
        sourceDescriptor,
        sourceGeneration,
        targetBuildId: CONTROL_PLANE_BUILD_ID,
        targetControlPlaneIdentity: {
          ...targetControlPlaneIdentity,
          executableSha256: "b".repeat(64),
        },
        targetHmuxIdentity,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "local_backend_replacement_intent_conflict",
      }),
    );
    expect(() =>
      ensureLocalBackendReplacementIntent({
        root,
        sourceDescriptor,
        sourceGeneration,
        targetBuildId: CONTROL_PLANE_BUILD_ID,
        targetControlPlaneIdentity,
        targetHmuxIdentity: {
          ...targetHmuxIdentity,
          runtimeExecutableSha256: "d".repeat(64),
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "local_backend_replacement_intent_conflict",
      }),
    );
  });

  it("rejects a downgrade or ambiguous same-sequence build before creating replacement state", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "backend"), { mode: 0o700 });
    const sourceGeneration = "local-v1-11111111111111111111111111111111";

    for (const [sourceBuildId, targetBuildId] of [
      [
        "dure-control-plane/v29-replacement-direction-fence",
        "dure-control-plane/v28-schedule-retention",
      ],
      [
        "dure-control-plane/v29-replacement-direction-fence",
        "dure-control-plane/v29-divergent-build",
      ],
      [CONTROL_PLANE_BUILD_ID, "dure-control-plane/v115-browser-workspace-paths"],
    ]) {
      expect(() =>
        ensureLocalBackendReplacementIntent({
          root,
          sourceDescriptor: {
            generation: sourceGeneration,
            buildId: sourceBuildId,
          },
          sourceGeneration,
          targetBuildId,
          targetControlPlaneIdentity: {
            executablePath: join(root, "dure-control-plane"),
            executableDevice: "8",
            executableInode: "9",
            executableSize: "10",
            executableModified: "11:12",
            executableSha256: "c".repeat(64),
          },
          targetHmuxIdentity: hmuxToolchainIdentity(root),
        }),
      ).toThrowError(
        expect.objectContaining({ code: "local_backend_replacement_downgrade" }),
      );
    }
    expect(existsSync(join(root, "backend", "replacement-intents"))).toBe(
      false,
    );
  });

  it("replaces a proven downgrade intent only while its exact source is live", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "backend"), { mode: 0o700 });
    const sourceGeneration = "local-v1-11111111111111111111111111111111";
    const controlPlaneIdentity = {
      executablePath: join(root, "dure-control-plane"),
      executableDevice: "8",
      executableInode: "9",
      executableSize: "10",
      executableModified: "11:12",
      executableSha256: "c".repeat(64),
    };
    const hmuxIdentity = hmuxToolchainIdentity(root);
    ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor: { generation: sourceGeneration },
      sourceGeneration,
      targetBuildId: "dure-control-plane/v27-schedule-authority",
      targetControlPlaneIdentity: controlPlaneIdentity,
      targetHmuxIdentity: hmuxIdentity,
      now: () => 10,
    });
    const intentPath = join(
      root,
      "backend",
      "replacement-intents",
      `${sourceGeneration}.json`,
    );
    const stale = JSON.parse(readFileSync(intentPath, "utf8"));
    stale.source.buildId = "dure-control-plane/v28-schedule-retention";
    writeFileSync(intentPath, `${JSON.stringify(stale, null, 2)}\n`, {
      mode: 0o600,
    });
    const sourceDescriptor = {
      backendId: "dure-local",
      generation: sourceGeneration,
      buildId: "dure-control-plane/v28-schedule-retention",
    };
    const desired = {
      root,
      sourceDescriptor,
      sourceGeneration,
      targetBuildId: "dure-control-plane/v30-provider-launch-defaults",
      targetControlPlaneIdentity: controlPlaneIdentity,
      targetHmuxIdentity: hmuxIdentity,
      now: () => 20,
    };

    expect(() => ensureLocalBackendReplacementIntent(desired)).toThrowError(
      expect.objectContaining({
        code: "local_backend_replacement_intent_conflict",
      }),
    );
    const replacement = ensureLocalBackendReplacementIntent({
      ...desired,
      sourceObservation: {
        id: "dure-local",
        generation: sourceGeneration,
      },
    });

    expect(replacement.source).toEqual({
      generation: sourceGeneration,
      buildId: sourceDescriptor.buildId,
      hmuxIdentity: null,
    });
    expect(replacement.target.buildId).toBe(
      "dure-control-plane/v30-provider-launch-defaults",
    );
    expect(replacement.createdAtMs).toBe(20);
  });

  it("does not adopt a target descriptor without its exact persisted intent", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "backend"), { mode: 0o700 });
    const targetHmuxIdentity = hmuxToolchainIdentity(root);
    const targetControlPlaneIdentity = {
      executablePath: join(root, "dure-control-plane"),
      executableDevice: "8",
      executableInode: "9",
      executableSize: "10",
      executableModified: "11:12",
      executableSha256: "c".repeat(64),
    };
    const arbitraryDescriptor = {
      generation: "local-v1-22222222222222222222222222222222",
      buildId: "dure-control-plane/v4-sessions",
      hmuxExecutablePath: targetHmuxIdentity.executablePath,
      hmuxExecutableDevice: targetHmuxIdentity.executableDevice,
      hmuxExecutableInode: targetHmuxIdentity.executableInode,
      hmuxExecutableSize: targetHmuxIdentity.executableSize,
      hmuxExecutableModified: targetHmuxIdentity.executableModified,
      hmuxExecutableSha256: targetHmuxIdentity.executableSha256,
      hmuxRuntimeExecutablePath: targetHmuxIdentity.runtimeExecutablePath,
      hmuxRuntimeExecutableDevice: targetHmuxIdentity.runtimeExecutableDevice,
      hmuxRuntimeExecutableInode: targetHmuxIdentity.runtimeExecutableInode,
      hmuxRuntimeExecutableSize: targetHmuxIdentity.runtimeExecutableSize,
      hmuxRuntimeExecutableModified:
        targetHmuxIdentity.runtimeExecutableModified,
      hmuxRuntimeExecutableSha256: targetHmuxIdentity.runtimeExecutableSha256,
      hmuxDiscoveryRoot: targetHmuxIdentity.discoveryRoot,
      hmuxDiscoveryDevice: targetHmuxIdentity.discoveryDevice,
      hmuxDiscoveryInode: targetHmuxIdentity.discoveryInode,
    };

    expect(
      replacementIntentForDescriptor({
        root,
        sourceGeneration: "local-v1-11111111111111111111111111111111",
        targetDescriptor: arbitraryDescriptor,
        targetBuildId: "dure-control-plane/v4-sessions",
        targetControlPlaneIdentity,
        targetHmuxIdentity,
      }),
    ).toBeNull();

    const intent = ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor: {
        generation: "local-v1-11111111111111111111111111111111",
        buildId: "dure-control-plane/v3-exact-observe",
      },
      sourceGeneration: "local-v1-11111111111111111111111111111111",
      targetBuildId: "dure-control-plane/v4-sessions",
      targetControlPlaneIdentity,
      targetHmuxIdentity,
    });
    const mislabeledDescriptor = {
      ...arbitraryDescriptor,
      generation: intent.target.generation,
      buildId: "dure-control-plane/v5-capabilities",
    };
    expect(
      replacementIntentForVerifiedDescriptor({
        root,
        sourceGeneration: intent.source.generation,
        targetDescriptor: {
          ...mislabeledDescriptor,
          hmuxRuntimeExecutableSha256: "d".repeat(64),
        },
        observedTargetBuildId: mislabeledDescriptor.buildId,
      }),
    ).toBeNull();
    expect(
      replacementConfirmationForDescriptor({
        root,
        sourceGeneration: intent.source.generation,
        targetDescriptor: mislabeledDescriptor,
        targetBuildId: mislabeledDescriptor.buildId,
        targetControlPlaneIdentity: {
          ...targetControlPlaneIdentity,
          executableSha256: "e".repeat(64),
        },
        targetHmuxIdentity,
      }),
    ).toBeNull();
    expect(
      replacementConfirmationForDescriptor({
        root,
        sourceGeneration: intent.source.generation,
        targetDescriptor: mislabeledDescriptor,
        targetBuildId: mislabeledDescriptor.buildId,
        targetControlPlaneIdentity,
        targetHmuxIdentity,
      }),
    ).toEqual({
      intent,
      observedTargetBuildId: mislabeledDescriptor.buildId,
    });
  });

  it("finishes the persisted successor before interpreting a newer channel payload", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "backend"), { mode: 0o700 });
    const sourceGeneration = "local-v1-11111111111111111111111111111111";
    const targetHmuxIdentity = hmuxToolchainIdentity(root);
    const persistedControlPlaneIdentity = {
      executablePath: join(root, "versions/old/dure-control-plane"),
      executableDevice: "8",
      executableInode: "9",
      executableSize: "10",
      executableModified: "11:12",
      executableSha256: "c".repeat(64),
    };
    const intent = ensureLocalBackendReplacementIntent({
      root,
      sourceDescriptor: {
        generation: sourceGeneration,
        buildId: "dure-control-plane/v52-bounded-runtime-root",
      },
      sourceGeneration,
      targetBuildId: "dure-control-plane/v52-bounded-runtime-root",
      targetControlPlaneIdentity: persistedControlPlaneIdentity,
      targetHmuxIdentity,
    });
    const activatedDescriptor = {
      generation: intent.target.generation,
      buildId: intent.target.buildId,
      controlPlaneIdentity: persistedControlPlaneIdentity,
      activationSourceGeneration: sourceGeneration,
      hmuxExecutablePath: targetHmuxIdentity.executablePath,
      hmuxExecutableDevice: targetHmuxIdentity.executableDevice,
      hmuxExecutableInode: targetHmuxIdentity.executableInode,
      hmuxExecutableSize: targetHmuxIdentity.executableSize,
      hmuxExecutableModified: targetHmuxIdentity.executableModified,
      hmuxExecutableSha256: targetHmuxIdentity.executableSha256,
      hmuxRuntimeExecutablePath: targetHmuxIdentity.runtimeExecutablePath,
      hmuxRuntimeExecutableDevice:
        targetHmuxIdentity.runtimeExecutableDevice,
      hmuxRuntimeExecutableInode: targetHmuxIdentity.runtimeExecutableInode,
      hmuxRuntimeExecutableSize: targetHmuxIdentity.runtimeExecutableSize,
      hmuxRuntimeExecutableModified:
        targetHmuxIdentity.runtimeExecutableModified,
      hmuxRuntimeExecutableSha256:
        targetHmuxIdentity.runtimeExecutableSha256,
      hmuxDiscoveryRoot: targetHmuxIdentity.discoveryRoot,
      hmuxDiscoveryDevice: targetHmuxIdentity.discoveryDevice,
      hmuxDiscoveryInode: targetHmuxIdentity.discoveryInode,
    };
    const promotedControlPlaneIdentity = {
      ...persistedControlPlaneIdentity,
      executablePath: join(root, "versions/new/dure-control-plane"),
      executableInode: "19",
      executableModified: "21:22",
    };

    expect(
      replacementConfirmationForDescriptor({
        root,
        sourceGeneration,
        targetDescriptor: activatedDescriptor,
        targetBuildId: intent.target.buildId,
        targetControlPlaneIdentity: promotedControlPlaneIdentity,
        targetHmuxIdentity,
      }),
    ).toEqual({
      intent,
      observedTargetBuildId: intent.target.buildId,
    });
  });
});

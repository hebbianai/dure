import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { evaluateHmuxReleaseActivationReadiness } from "./lib/hmux-release-activation-readiness.mjs";

const repositoryRoot = path.resolve(".");
const policyPath = path.join(
  repositoryRoot,
  "scripts/fixtures/hmux-release-trust-policy.json",
);
const fixtureRoot = path.join(
  repositoryRoot,
  "hmux/crates/hmux-release-trust/tests/fixtures",
);
const conformanceXfailPath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-tuf-conformance.xfails",
);
const linuxConformanceDriverPath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-tuf-conformance-lima.sh",
);
const linuxConformanceGuestPath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-tuf-conformance-guest.sh",
);
const conformanceAuditPath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-tuf-conformance-audit.py",
);
const tauriConfigPath = path.join(repositoryRoot, "src-tauri/tauri.conf.json");
const runtimePolicyPath = path.join(
  repositoryRoot,
  "src-tauri/src/hmux/runtime.rs",
);
function loadPolicy() {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function expectRegexContract(pattern, accepted, rejected) {
  const expression = new RegExp(pattern);
  for (const value of accepted) {
    expect(expression.test(value), value).toBe(true);
  }
  for (const value of rejected) {
    expect(expression.test(value), value).toBe(false);
  }
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : [absolute];
    });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function jsonContainsPrivateField(value) {
  if (Array.isArray(value)) {
    return value.some(jsonContainsPrivateField);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        /private|secret|seed|token/i.test(key) ||
        jsonContainsPrivateField(child),
    );
  }
  return false;
}

function runtimePolicyValue(source, field) {
  return source.match(new RegExp(`${field}:\\s*"([^"]+)"`))?.[1];
}

function repositoryActivationInputs(policy) {
  const roots = {};
  for (const channel of policy.channels) {
    const absolute = path.join(repositoryRoot, channel.bootstrapRoot);
    if (!fs.existsSync(absolute)) continue;
    const bytes = fs.readFileSync(absolute);
    roots[channel.name] = {
      bytes,
      document: JSON.parse(bytes.toString("utf8")),
    };
  }
  const tauri = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
  const runtime = fs.readFileSync(runtimePolicyPath, "utf8");
  const signedFetchState = runtimePolicyValue(runtime, "signed_release_fetch");
  const signedInstallState = runtimePolicyValue(
    runtime,
    "signed_package_install",
  );

  return {
    policy,
    bootstrapRoots: roots,
    bundleResources: tauri.bundle.resources,
    // A dependency declaration is not proof that every install path invokes
    // the verifier. Keep this hard-blocked until the application exposes a
    // testable gate at the actual fetch/install boundary.
    applicationVerifierWired: false,
    runtimeSignedFetchEnabled:
      typeof signedFetchState === "string" &&
      signedFetchState !== "not_implemented" &&
      !signedFetchState.startsWith("blocked_"),
    runtimeSignedInstallEnabled:
      typeof signedInstallState === "string" &&
      signedInstallState !== "not_implemented" &&
      !signedInstallState.startsWith("blocked_"),
    // Public source cannot attest to the publisher's private workflow authority.
    // The internal workflow suite independently checks its activation triggers.
    releaseTrustRootChangesTriggerGate: false,
    // A repository file and digest cannot prove control of an external origin.
    // Keep this blocked until an exact ownership receipt is specified and
    // independently verified.
    originOwnershipEvidenceVerified: false,
    clientFixtureRefreshPassed:
      policy.tuf.clientImplementation.status ===
      "focused_and_full_linux_conformance_ci_enabled",
    upstreamConformancePassed:
      policy.tuf.conformanceSuite.fullSuiteStatus ===
      "enabled_pinned_native_linux_faketime",
    // Cron presence is not proof that expiry inspection and paging succeeded.
    // Require a future authority receipt rather than inferring from YAML.
    renewalAlertingEnabled: false,
    // Promotion currently produces a verified candidate and optional
    // attestation; it does not sign or publish a TUF repository.
    tufPublisherReady: false,
  };
}

describe("Hmux signed-release trust policy", () => {
  test("pins the selected TUF implementation, specification, and tooling", () => {
    const { schemaVersion, tuf } = loadPolicy();

    expect(schemaVersion).toBe(1);
    expect(tuf).toEqual({
      specificationVersion: "1.0.35",
      specificationCommit: "743c8a026b6edeaa5e64d247c68a31dc9786b5b2",
      wireFormat: "tuf-json",
      consistentSnapshot: true,
      clientImplementation: {
        status: "focused_and_full_linux_conformance_ci_enabled",
        crate: "tough",
        exactVersion: "0.24.0",
        sourceCommit: "98d8eb8b2ce63515d9b4981c938ef6453c5b5771",
        cargoPackageSha256:
          "35b378d98765c2ae9cdc3e9963ea7e670da8cdd9ee39611b8d722083c7f1ac11",
        license: "MIT OR Apache-2.0",
        minimumRustVersion: "1.85",
      },
      conformanceSuite: {
        repository: "theupdateframework/tuf-conformance",
        commit: "51ee32b3a7cee80d4f998b164357d7c78fe7c541",
        license: "MIT",
        focusedNoXfailTests: 10,
        fullSuiteStatus: "enabled_pinned_native_linux_faketime",
        fullSuiteTests: 112,
        strictExpectedFailures: 29,
        strictXfailFile: "scripts/qa/hmux-tuf-conformance.xfails",
        pythonVersion: "3.12",
        pythonPlatforms: [
          "aarch64-apple-darwin",
          "aarch64-unknown-linux-gnu",
        ],
        hashLockedRequirements:
          "scripts/qa/hmux-tuf-conformance-requirements.txt",
      },
      repositoryTooling: {
        repository: "theupdateframework/tuf-on-ci",
        commit: "bf1d724f73b0a6d03823fa5895e4906b2f2283f5",
        license: "MIT",
        delegateCommand: "tuf-on-ci-delegate",
        signCommand: "tuf-on-ci-sign",
      },
      referenceFixtureGenerator: {
        package: "tuf",
        exactVersion: "7.0.0",
        sourceCommit: "353bdb767db56fd4667c9bcf56b710d50fdc2ac0",
        wheelSha256:
          "572bdbdc9ff4a82278a0d4773e6100863b9b33023f27575e84ca65b486dd0d79",
        license: "Apache-2.0 OR MIT",
        signingLibrary: {
          package: "securesystemslib",
          exactVersion: "1.3.1",
          sourceCommit: "6f774190b90f0aa9d5d7e077680adbaa29c5cd6c",
          wheelSha256:
            "2e5414bbdde33155a91805b295cbedc4ae3f12b48dccc63e1089093537f43c81",
          license: "MIT",
        },
        privateKeysPersisted: false,
      },
    });
  });

  test("keeps unbootstrapped stable and canary feeds disabled and isolated", () => {
    const policy = loadPolicy();
    const channels = new Map(
      policy.channels.map((channel) => [channel.name, channel]),
    );
    const stable = channels.get("stable");
    const canary = channels.get("canary");

    expect([...channels.keys()].sort()).toEqual(["canary", "stable"]);
    expect(stable).toEqual({
      name: "stable",
      metadataBaseUrl: "https://updates.dureai.dev/hmux/stable/metadata/",
      targetsBaseUrl: "https://updates.dureai.dev/hmux/stable/targets/",
      bootstrapRoot: "src-tauri/resources/hmux-tuf/stable/1.root.json",
      bootstrapRootSha256: null,
      feedStatus: "disabled_pending_origin_ownership_and_bootstrap_root",
      applicationPosture: "production",
    });
    expect(canary).toEqual({
      name: "canary",
      metadataBaseUrl: "https://updates.dureai.dev/hmux/canary/metadata/",
      targetsBaseUrl: "https://updates.dureai.dev/hmux/canary/targets/",
      bootstrapRoot: "src-tauri/resources/hmux-tuf/canary/1.root.json",
      bootstrapRootSha256: null,
      feedStatus: "disabled_pending_origin_ownership_and_bootstrap_root",
      applicationPosture: "development_only",
    });
    for (const channel of [stable, canary]) {
      expect(
        fs.existsSync(path.join(repositoryRoot, channel.bootstrapRoot)),
      ).toBe(false);
    }
    expect(policy.trustedState.channelStateIsolated).toBe(true);
  });

  test("fixes exact thresholds, expiries, and scheduled renewal margins", () => {
    const { roles, publication } = loadPolicy();

    expect(roles).toEqual({
      root: {
        keyType: "ed25519",
        keyCount: 3,
        threshold: 2,
        custody: "offline_hardware_or_airgapped",
        expiresAfterSeconds: 31_536_000,
      },
      targets: {
        keyType: "ed25519",
        keyCount: 3,
        threshold: 2,
        custody: "offline_hardware_or_airgapped",
        expiresAfterSeconds: 7_776_000,
        renewBeforeSeconds: 2_592_000,
      },
      snapshot: {
        keyType: "ed25519",
        keyCount: 1,
        threshold: 1,
        custody: "isolated_release_environment",
        expiresAfterSeconds: 604_800,
        refreshBeforeSeconds: 259_200,
      },
      timestamp: {
        keyType: "ed25519",
        keyCount: 1,
        threshold: 1,
        custody: "isolated_release_environment",
        expiresAfterSeconds: 86_400,
        refreshBeforeSeconds: 43_200,
      },
    });
    expect(publication.metadataRenewal).toEqual({
      timestampEverySeconds: 43_200,
      snapshotEverySeconds: 259_200,
      targetsRenewBeforeSeconds: 2_592_000,
      renewalMayChangeTargetSet: false,
      alertBeforeTimestampExpirySeconds: 21_600,
      alertBeforeSnapshotExpirySeconds: 172_800,
      alertBeforeTargetsExpirySeconds: 3_888_000,
    });
  });

  test("separates the trusted macOS client from Linux artifact targets", () => {
    const policy = loadPolicy();

    expect(policy.supportedClientPlatforms).toEqual([
      {
        product: "hebbian-ide",
        targetTriple: "aarch64-apple-darwin",
      },
    ]);
    expect(policy.artifactTargets).toEqual([
      {
        product: "hmux",
        targetTriple: "x86_64-unknown-linux-musl",
        archiveFormat: "tar.gz",
      },
      {
        product: "hmux",
        targetTriple: "aarch64-unknown-linux-musl",
        archiveFormat: "tar.gz",
      },
    ]);
    expect(policy.artifactTargets).not.toContainEqual(
      expect.objectContaining({ targetTriple: "aarch64-apple-darwin" }),
    );
  });

  test("fixes a target-specific signed identity and explicit destination", () => {
    const { targetCustomMetadata: metadata } = loadPolicy();

    expect(metadata.requiredFields).toEqual([
      "schemaVersion",
      "product",
      "channel",
      "buildId",
      "sourceCommit",
      "targetTriple",
      "archiveFormat",
      "packageVersion",
      "protocolMinimum",
      "protocolMaximum",
      "installedTreeSha256",
    ]);
    expect(metadata.digestAlgorithms).toEqual(["sha256"]);
    expect(metadata.destinationTripleIsExplicitInput).toBe(true);
    expect(metadata.buildIdMaximumBytes).toBe(128);
    expect(metadata.buildIdRequiresDestinationSuffix).toBe(true);
    expectRegexContract(
      metadata.logicalTargetPathPattern,
      [
        "0.1.4+sha.abcdef.x86_64-unknown-linux-musl.release.tar.gz",
        "canary-42.aarch64-unknown-linux-musl.release.tar.gz",
      ],
      [
        "../0.1.4.x86_64-unknown-linux-musl.release.tar.gz",
        "nested/0.1.4.x86_64-unknown-linux-musl.release.tar.gz",
        `${"a".repeat(129)}.tar.gz`,
      ],
    );
    expectRegexContract(
      metadata.buildIdPattern,
      [
        "0.1.4+sha.abcdef.x86_64-unknown-linux-musl.release",
        "a".repeat(128),
      ],
      ["a".repeat(129), "../unsafe"],
    );
    expectRegexContract(
      metadata.sourceCommitPattern,
      ["0123456789abcdef0123456789abcdef01234567"],
      ["0123456789abcdef", "G123456789abcdef0123456789abcdef01234567"],
    );
    expectRegexContract(
      metadata.packageVersionPattern,
      ["0.1.4", "0.1.4-canary.2", "1.2.3+build.7"],
      ["v0.1.4", "0.1", "main"],
    );
    expectRegexContract(metadata.protocolVersionPattern, ["1.0"], ["1", "v1"]);
    expectRegexContract(
      metadata.installedTreeSha256Pattern,
      ["a".repeat(64)],
      ["a".repeat(63), "g".repeat(64)],
    );
  });

  test("fixes bounded refresh and immutable publication order", () => {
    const { bounds, publication, rotation } = loadPolicy();

    expect(bounds).toEqual({
      maximumRootRotationsPerRefresh: 32,
      maximumTrustedRootsPerProof: 33,
      maximumProofBytes: 134_217_728,
      maximumRootBytes: 524_288,
      maximumTimestampBytes: 65_536,
      maximumSnapshotBytes: 524_288,
      maximumTargetsBytes: 2_097_152,
      maximumTargetBytes: 268_435_456,
      maximumTargetsPerMetadata: 64,
    });
    expect(rotation).toEqual({
      rootVersionsAreSequential: true,
      newRootRequiresOldThreshold: true,
      newRootRequiresNewThreshold: true,
      retainEveryRootVersion: true,
    });
    expect(publication.order).toEqual([
      "sequential_versioned_roots",
      "hash_prefixed_target",
      "versioned_targets",
      "versioned_snapshot",
      "timestamp",
    ]);
    expect(publication.targetSigningRequiresOfflineThreshold).toBe(true);
    expect(publication.candidateWorkflowMayReadPrivateKeys).toBe(false);
    expect(publication.privateKeyMaterialAllowedInRepository).toBe(false);
    expect(publication.replacePublishedTarget).toBe(false);
  });

  test("persists time and version watermarks without risking the runnable", () => {
    const { activation, activationPrerequisites, trustedState } = loadPolicy();

    expect(trustedState).toEqual({
      persistHighestSeenVersions: [
        "root",
        "timestamp",
        "snapshot",
        "targets",
      ],
      persistLastTrustedTime: true,
      fixRefreshStartTime: true,
      clockRollbackRefusesRefresh: true,
      channelStateIsolated: true,
      localRollbackMayLowerTrustedVersions: false,
      failedRefreshKeepsCurrentRunnable: true,
    });
    expect(activationPrerequisites).toEqual([
      "feed_origin_ownership_verified",
      "threshold_valid_bootstrap_root_embedded",
      "offline_bootstrap_root_cryptographically_validated",
      "production_bootstrap_keys_distinct_from_fixtures",
      "application_verifier_wired_at_fetch_and_install_boundaries",
      "runtime_signed_fetch_enabled",
      "runtime_signed_install_enabled",
      "chosen_client_fixture_refresh_passed",
      "upstream_conformance_passed",
      "activation_sensitive_changes_trigger_release_gate",
      "tuf_publisher_ready",
      "metadata_renewal_alerting_enabled",
    ]);
    expect(activation).toEqual({
      feedActivation: "disabled",
      bootstrapState: "absent",
      originOwnershipEvidence: null,
      renewalAlertingWorkflow: null,
      tufPublisherEvidence: null,
    });
  });

  test("keeps production activation fail-closed across every authority boundary", () => {
    const policy = loadPolicy();
    const blockers = evaluateHmuxReleaseActivationReadiness(
      repositoryActivationInputs(policy),
    );

    expect(policy.activation.feedActivation).toBe("disabled");
    expect(policy.activation.bootstrapState).toBe("absent");
    expect(
      policy.channels.every(
        ({ feedStatus }) =>
          feedStatus ===
          "disabled_pending_origin_ownership_and_bootstrap_root",
      ),
    ).toBe(true);
    expect(blockers).toEqual([
      "application_verifier_wiring_missing",
      "bootstrap_root_gate_trigger_missing",
      "bootstrap_state_not_staged_verified",
      "canary:bootstrap_root_missing",
      "canary:bootstrap_root_not_bundled",
      "canary:feed_not_enabled",
      "feed_activation_disabled",
      "feed_origin_ownership_unverified",
      "metadata_renewal_alerting_missing",
      "offline_bootstrap_root_validation_unavailable",
      "production_bootstrap_keys_not_proven_distinct_from_fixtures",
      "runtime_signed_fetch_disabled",
      "runtime_signed_install_disabled",
      "stable:bootstrap_root_missing",
      "stable:bootstrap_root_not_bundled",
      "stable:feed_not_enabled",
      "tuf_publisher_not_ready",
    ]);
  });

  test("keeps structurally valid disposable roots non-authoritative", () => {
    const policy = structuredClone(loadPolicy());
    policy.activation.feedActivation = "enabled";
    policy.activation.bootstrapState = "staged_verified";
    const roots = Object.fromEntries(
      policy.channels.map((channel) => {
        const bytes = fs.readFileSync(
          path.join(
            fixtureRoot,
            `${channel.name}-v1/metadata/1.root.json`,
          ),
        );
        channel.feedStatus = "enabled";
        channel.bootstrapRootSha256 = crypto
          .createHash("sha256")
          .update(bytes)
          .digest("hex");
        return [
          channel.name,
          { bytes, document: JSON.parse(bytes.toString("utf8")) },
        ];
      }),
    );

    expect(
      evaluateHmuxReleaseActivationReadiness({
        policy,
        bootstrapRoots: roots,
        bundleResources: policy.channels.map(({ bootstrapRoot }) =>
          bootstrapRoot.replace(/^src-tauri\//, ""),
        ),
        applicationVerifierWired: true,
        runtimeSignedFetchEnabled: true,
        runtimeSignedInstallEnabled: true,
        releaseTrustRootChangesTriggerGate: true,
        originOwnershipEvidenceVerified: true,
        clientFixtureRefreshPassed: true,
        upstreamConformancePassed: true,
        renewalAlertingEnabled: true,
        tufPublisherReady: true,
      }),
    ).toEqual([
      "offline_bootstrap_root_validation_unavailable",
      "production_bootstrap_keys_not_proven_distinct_from_fixtures",
    ]);
  });

  test("checksums public fixtures and proves dual-threshold disposable rotation", () => {
    const manifest = fs
      .readFileSync(path.join(fixtureRoot, "MANIFEST.sha256"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.match(/^([0-9a-f]{64})  (.+)$/);
        expect(match, line).not.toBeNull();
        return { digest: match[1], relative: match[2] };
      });
    const manifestedFiles = manifest.map(({ relative }) => relative).sort();
    const actualFiles = listFiles(fixtureRoot)
      .map((file) => path.relative(fixtureRoot, file))
      .filter((relative) => relative !== "MANIFEST.sha256")
      .sort();

    expect(manifestedFiles).toEqual(actualFiles);
    for (const { digest, relative } of manifest) {
      expect(sha256(path.join(fixtureRoot, relative)), relative).toBe(digest);
    }
    expect(
      actualFiles.some((relative) => /\.(?:key|pem|p8|p12)$/i.test(relative)),
    ).toBe(false);
    for (const relative of actualFiles.filter((file) => file.endsWith(".json"))) {
      const document = JSON.parse(
        fs.readFileSync(path.join(fixtureRoot, relative), "utf8"),
      );
      expect(jsonContainsPrivateField(document), relative).toBe(false);
    }

    const stableRoot1 = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "stable-v1/metadata/1.root.json"),
        "utf8",
      ),
    );
    const stableRoot2 = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "stable-v1/metadata/2.root.json"),
        "utf8",
      ),
    );
    const canaryRoot1 = fs.readFileSync(
      path.join(fixtureRoot, "canary-v1/metadata/1.root.json"),
      "utf8",
    );
    const oldRootKeyIds = new Set(stableRoot1.signed.roles.root.keyids);
    const newRootKeyIds = new Set(stableRoot2.signed.roles.root.keyids);
    const root2SignatureIds = new Set(
      stableRoot2.signatures.map(({ keyid }) => keyid),
    );

    expect(stableRoot1.signed["x-hmux-channel"]).toBe("stable");
    expect(stableRoot2.signed["x-hmux-channel"]).toBe("stable");
    expect(stableRoot1.signed.version).toBe(1);
    expect(stableRoot2.signed.version).toBe(2);
    expect(stableRoot2.signed.consistent_snapshot).toBe(true);
    for (const root of [stableRoot1, stableRoot2]) {
      expect(root.signed.roles.root.threshold).toBe(2);
      expect(root.signed.roles.root.keyids).toHaveLength(3);
      expect(root.signed.roles.targets.threshold).toBe(2);
      expect(root.signed.roles.targets.keyids).toHaveLength(3);
    }
    expect(
      [...root2SignatureIds].filter((keyId) => oldRootKeyIds.has(keyId)),
    ).toHaveLength(2);
    expect(
      [...root2SignatureIds].filter((keyId) => newRootKeyIds.has(keyId)),
    ).toHaveLength(2);
    expect(
      fs.readFileSync(
        path.join(fixtureRoot, "stable-v1/metadata/1.root.json"),
        "utf8",
      ),
    ).not.toBe(canaryRoot1);
  });

  test("pins the standalone conformance driver, expected failures, and dependencies", () => {
    const xfails = fs.readFileSync(conformanceXfailPath, "utf8");
    const linuxDriver = fs.readFileSync(
      linuxConformanceDriverPath,
      "utf8",
    );
    const linuxGuest = fs.readFileSync(linuxConformanceGuestPath, "utf8");
    const audit = fs.readFileSync(conformanceAuditPath, "utf8");
    expect(xfails).not.toContain("test_timestamp_content_changes");
    expect(xfails).not.toContain("\ntest_metadata_bytes_match\n");
    expect(xfails).toContain("test_client_downloads_expected_file_in_sub_dir");
    expect(xfails).not.toContain("\ntest_targetfile_search\n");
    expect(xfails).toContain("test_targetfile_search[no delegations]");
    expect(linuxDriver).toContain("limactl version $lima_version");
    expect(linuxDriver).toContain("git -C \"$repository\" archive");
    expect(linuxGuest).toContain("20260725T000000Z");
    expect(linuxGuest).toContain("PIP_ONLY_BINARY=:all:");
    expect(linuxGuest).toContain("-o xfail_strict=true");
    expect(linuxGuest).not.toContain("--runxfail");
    expect(linuxGuest).toContain("timeout --kill-after=30s 45m");
    expect(audit).toContain(
      "actual expected-failure set differs from declaration",
    );
    expect(audit).toContain(
      "xfail declaration must select exactly one test",
    );
    expect(audit).toContain("collectedNodeids");
    expect(audit).toContain("executed test identity set differs from collection");
    expect(audit).toContain("EXPECTED_COLLECTED = 112");
    expect(audit).toContain("EXPECTED_XFAILED = 29");
    const requirements = fs.readFileSync(
      path.join(
        repositoryRoot,
        "scripts/qa/hmux-tuf-conformance-requirements.txt",
      ),
      "utf8",
    );
    const lockedPackages = [...requirements.matchAll(/^([a-z0-9-]+)==/gm)].map(
      ([, packageName]) => packageName,
    );
    expect(requirements).toContain("Generated with uv 0.8.4");
    expect(requirements).toContain(
      "51ee32b3a7cee80d4f998b164357d7c78fe7c541",
    );
    expect(requirements).toContain(
      "uv pip compile .conformance/tuf-conformance/pyproject.toml",
    );
    expect(requirements).toContain("--only-binary=:all:");
    expect(requirements).toContain("--no-header");
    expect(lockedPackages).toEqual([
      "cffi",
      "cryptography",
      "iniconfig",
      "packaging",
      "pluggy",
      "pycparser",
      "pygments",
      "pytest",
      "pytest-json-report",
      "pytest-metadata",
      "securesystemslib",
      "tuf",
      "urllib3",
    ]);
    expect(requirements.match(/--hash=sha256:/g)?.length).toBeGreaterThanOrEqual(
      lockedPackages.length,
    );
  });

  test("rejects a full-suite result that duplicates one pass and omits another", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-tuf-audit-test-"),
    );
    try {
      const nodeids = Array.from(
        { length: 112 },
        (_, index) => `suite.py::test_${index}`,
      );
      const collection = {
        collectors: [
          {
            outcome: "passed",
            result: nodeids.map((nodeid) => ({
              nodeid,
              type: "Function",
            })),
          },
        ],
      };
      const declarations = Array.from(
        { length: 29 },
        (_, index) => `test_${index}`,
      );
      const collectionPath = path.join(temporary, "collection.json");
      const declarationsPath = path.join(temporary, "client.xfails");
      const expectedPath = path.join(temporary, "expected.json");
      const resultPath = path.join(temporary, "result.json");
      const summaryPath = path.join(temporary, "summary.json");
      fs.writeFileSync(collectionPath, JSON.stringify(collection));
      fs.writeFileSync(declarationsPath, `${declarations.join("\n")}\n`);
      const collected = spawnSync(
        "python3",
        [
          conformanceAuditPath,
          "collect",
          collectionPath,
          declarationsPath,
          expectedPath,
        ],
        { encoding: "utf8" },
      );
      expect(collected.status, collected.stderr).toBe(0);

      const tests = nodeids.map((nodeid, index) => ({
        nodeid,
        outcome: index < 29 ? "xfailed" : "passed",
      }));
      tests[111] = { ...tests[110] };
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ exitcode: 0, tests }),
      );
      const audited = spawnSync(
        "python3",
        [
          conformanceAuditPath,
          "result",
          resultPath,
          expectedPath,
          summaryPath,
        ],
        { encoding: "utf8" },
      );
      expect(audited.status).not.toBe(0);
      expect(audited.stderr).toContain(
        "pytest result contains duplicate test identities",
      );
      expect(fs.existsSync(summaryPath)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES,
  LinuxNativeProviderContainmentAuthorityError,
  LinuxNativeProviderContainmentCapabilityError,
  assertLinuxNativeProviderInvocationAuthorityV1,
  assertLinuxNativeProviderQualificationAuthorityV1,
  createLinuxNativeProviderContainmentCapabilityV1,
  normalizeLinuxNativeProviderContainmentCapabilityV1,
  parseLinuxNativeProviderContainmentCapabilityV1,
  serializeLinuxNativeProviderContainmentCapabilityV1,
} from "./plugin-native-linux-containment-capability.mjs";

const TARGET = Object.freeze({ os: "linux", arch: "x86_64" });
const EXPECTED_REASON_CODES = Object.freeze({
  not_implemented: ["runner_not_implemented"],
  unsupported: [
    "platform_unsupported",
    "architecture_unsupported",
    "bubblewrap_absent",
    "bubblewrap_build_unqualified",
    "unprivileged_userns_unavailable",
    "required_namespace_unavailable",
    "userns_lockdown_unavailable",
    "seccomp_unavailable",
    "pidfd_unavailable",
    "subreaper_unavailable",
    "cgroup_v2_unavailable",
    "cgroup_delegation_unavailable",
    "cgroup_kill_unavailable",
    "runtime_closure_unavailable",
  ],
  failed: [
    "bubblewrap_identity_mismatch",
    "bubblewrap_identity_changed",
    "policy_digest_mismatch",
    "staged_identity_changed",
    "namespace_attestation_mismatch",
    "mount_attestation_mismatch",
    "proc_attestation_mismatch",
    "environment_attestation_mismatch",
    "fd_attestation_mismatch",
    "network_attestation_mismatch",
    "writable_root_attestation_mismatch",
    "process_containment_mismatch",
    "probe_protocol_invalid",
    "capability_drift_after_probe",
    "cleanup_incomplete",
  ],
});
const GOLDEN_NOT_IMPLEMENTED_DOCUMENT =
  '{"schema":"dure-linux-native-provider-containment-capability/v1","policy_id":"linux-bwrap-networkless-v1","policy_sha256":"sha256:5b0861b7914f8c017ca239f1bac0f89c9df92c08a8cd123bee0ce3937a91c3d0","target":{"os":"linux","arch":"x86_64"},"authority":"none","state":"not_implemented","reason_code":"runner_not_implemented"}';
const GOLDEN_UNSUPPORTED_DOCUMENT =
  '{"schema":"dure-linux-native-provider-containment-capability/v1","policy_id":"linux-bwrap-networkless-v1","policy_sha256":"sha256:5b0861b7914f8c017ca239f1bac0f89c9df92c08a8cd123bee0ce3937a91c3d0","target":{"os":"linux","arch":"x86_64"},"authority":"none","state":"unsupported","reason_code":"bubblewrap_absent","diagnostic":"not installed"}';

function capability(overrides = {}) {
  return {
    schema: LINUX_NATIVE_PROVIDER_CONTAINMENT_CAPABILITY_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target: TARGET,
    authority: "none",
    state: "not_implemented",
    reason_code: "runner_not_implemented",
    ...overrides,
  };
}

describe("Linux native-provider containment authority-none capability v1", () => {
  it("binds one indivisible guarantee profile to a golden policy digest", () => {
    expect(LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES).toHaveLength(18);
    expect(new Set(LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES).size).toBe(
      LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_GUARANTEES.length,
    );
    expect(LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256).toBe(
      "sha256:5b0861b7914f8c017ca239f1bac0f89c9df92c08a8cd123bee0ce3937a91c3d0",
    );
  });

  it("pins the complete v1 target and state-to-reason taxonomy", () => {
    expect(LINUX_NATIVE_PROVIDER_CONTAINMENT_TARGET_ARCHITECTURES).toEqual([
      "x86_64",
      "aarch64",
    ]);
    expect(LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES).toEqual(
      EXPECTED_REASON_CODES,
    );
  });

  it("round-trips every closed state and reason without granting authority", () => {
    for (const [state, reasonCodes] of Object.entries(
      LINUX_NATIVE_PROVIDER_CONTAINMENT_REASON_CODES,
    )) {
      for (const reasonCode of reasonCodes) {
        const created = createLinuxNativeProviderContainmentCapabilityV1({
          target: TARGET,
          state,
          reasonCode,
        });
        const serialized = serializeLinuxNativeProviderContainmentCapabilityV1(
          created,
        );
        expect(parseLinuxNativeProviderContainmentCapabilityV1(serialized)).toEqual(
          created,
        );
        expect(created.authority).toBe("none");
        expect(created).not.toHaveProperty("supported");
        expect(created).not.toHaveProperty("qualified");
        expect(created).not.toHaveProperty("passed");
        expect(created).not.toHaveProperty("receipt");
        expect(created).not.toHaveProperty("provider");
        expect(created).not.toHaveProperty("bubblewrap_path");
        expect(created).not.toHaveProperty("guarantees");
      }
    }
  });

  it("keeps unsupported and failed reasons in separate non-downgrade domains", () => {
    expect(() =>
      normalizeLinuxNativeProviderContainmentCapabilityV1(
        capability({
          state: "unsupported",
          reason_code: "bubblewrap_identity_mismatch",
        }),
      ),
    ).toThrow(/does not belong/);
    expect(() =>
      normalizeLinuxNativeProviderContainmentCapabilityV1(
        capability({
          state: "failed",
          reason_code: "bubblewrap_absent",
        }),
      ),
    ).toThrow(/does not belong/);
  });

  it("rejects authority, success-state, receipt, and policy injection", () => {
    for (const forged of [
      capability({ authority: "granted" }),
      capability({ state: "passed", reason_code: "runner_not_implemented" }),
      capability({ receipt: { status: "passed" } }),
      capability({ policy_id: "linux-bwrap-networkless-v0" }),
      capability({ policy_sha256: `sha256:${"0".repeat(64)}` }),
    ]) {
      expect(() =>
        normalizeLinuxNativeProviderContainmentCapabilityV1(forged),
      ).toThrow(LinuxNativeProviderContainmentCapabilityError);
    }
  });

  it("rejects missing, unknown, downgraded, and malformed wire fields", () => {
    const { reason_code: _missing, ...missingReason } = capability();
    const changingTarget = {};
    let osRead = false;
    Object.defineProperties(changingTarget, {
      os: {
        enumerable: true,
        get() {
          const value = osRead ? "darwin" : "linux";
          osRead = true;
          return value;
        },
      },
      arch: { enumerable: true, value: "x86_64" },
    });
    const accessorState = capability();
    Object.defineProperty(accessorState, "state", {
      enumerable: true,
      get: () => "not_implemented",
    });
    const symbolExtra = capability();
    symbolExtra[Symbol("extra")] = true;
    const nonEnumerableExtra = capability();
    Object.defineProperty(nonEnumerableExtra, "extra", { value: true });
    const cases = [
      missingReason,
      { ...capability(), unknown: true },
      { ...capability(), schema: "dure-linux-native-provider-containment-capability/v0" },
      { ...capability(), reason_code: "future_reason" },
      { ...capability(), state: new String("not_implemented") },
      { ...capability(), reason_code: new String("runner_not_implemented") },
      { ...capability(), target: { os: "darwin", arch: "arm64" } },
      { ...capability(), target: { os: "linux", arch: "riscv64" } },
      { ...capability(), target: { os: "linux", arch: "x86_64", extra: true } },
      { ...capability(), target: changingTarget },
      accessorState,
      symbolExtra,
      nonEnumerableExtra,
    ];
    for (const input of cases) {
      expect(() =>
        normalizeLinuxNativeProviderContainmentCapabilityV1(input),
      ).toThrow(LinuxNativeProviderContainmentCapabilityError);
    }
  });

  it("snapshots proxy data properties instead of re-reading mutable traps", () => {
    let targetReads = 0;
    const target = new Proxy(
      { os: "linux", arch: "x86_64" },
      {
        get(object, property, receiver) {
          if (property === "arch") {
            targetReads += 1;
            return targetReads === 1 ? "x86_64" : "riscv64";
          }
          return Reflect.get(object, property, receiver);
        },
      },
    );
    const raw = capability({ target });
    let stateReads = 0;
    const stateful = new Proxy(raw, {
      get(object, property, receiver) {
        if (property === "state") {
          stateReads += 1;
          return stateReads === 1 ? "not_implemented" : "passed";
        }
        return Reflect.get(object, property, receiver);
      },
    });
    const normalized = normalizeLinuxNativeProviderContainmentCapabilityV1(
      stateful,
    );
    expect(normalized.state).toBe("not_implemented");
    expect(normalized.target.arch).toBe("x86_64");
    expect(stateReads).toBe(0);
    expect(targetReads).toBe(0);
  });

  it("bounds and canonicalizes the optional redacted diagnostic", () => {
    const withDiagnostic = createLinuxNativeProviderContainmentCapabilityV1({
      target: TARGET,
      state: "unsupported",
      reasonCode: "bubblewrap_absent",
      diagnostic: "bubblewrap was not found in the pinned runner image",
    });
    expect(withDiagnostic.diagnostic).toContain("pinned runner image");

    for (const diagnostic of [
      "contains\ncontrol",
      "x".repeat(2 * 1024 + 1),
      "e\u0301",
      "\ud800",
      "",
    ]) {
      expect(() =>
        createLinuxNativeProviderContainmentCapabilityV1({
          target: TARGET,
          state: "unsupported",
          reasonCode: "bubblewrap_absent",
          diagnostic,
        }),
      ).toThrow(LinuxNativeProviderContainmentCapabilityError);
    }
  });

  it("accepts only canonical bounded JSON documents", () => {
    expect(
      serializeLinuxNativeProviderContainmentCapabilityV1(capability()),
    ).toBe(GOLDEN_NOT_IMPLEMENTED_DOCUMENT);
    expect(
      serializeLinuxNativeProviderContainmentCapabilityV1(
        capability({
          state: "unsupported",
          reason_code: "bubblewrap_absent",
          diagnostic: "not installed",
        }),
      ),
    ).toBe(GOLDEN_UNSUPPORTED_DOCUMENT);
    expect(
      parseLinuxNativeProviderContainmentCapabilityV1(
        GOLDEN_NOT_IMPLEMENTED_DOCUMENT,
      ),
    ).toEqual(
      normalizeLinuxNativeProviderContainmentCapabilityV1(capability()),
    );
    expect(
      parseLinuxNativeProviderContainmentCapabilityV1(
        GOLDEN_UNSUPPORTED_DOCUMENT,
      ).diagnostic,
    ).toBe("not installed");
    expect(() =>
      parseLinuxNativeProviderContainmentCapabilityV1(
        ` ${GOLDEN_NOT_IMPLEMENTED_DOCUMENT}`,
      ),
    ).toThrow(/canonical/);
    expect(() => parseLinuxNativeProviderContainmentCapabilityV1("{"))
      .toThrow(/valid JSON/);
    expect(() =>
      parseLinuxNativeProviderContainmentCapabilityV1(
        "x".repeat(4 * 1024 + 1),
      ),
    ).toThrow(/4096/);
  });

  it("denies invocation and qualification before either can acquire authority", () => {
    const documents = [
      capability(),
      capability({
        state: "unsupported",
        reason_code: "cgroup_kill_unavailable",
      }),
      capability({
        state: "failed",
        reason_code: "cleanup_incomplete",
      }),
    ];
    for (const document of documents) {
      for (const assertAuthority of [
        assertLinuxNativeProviderInvocationAuthorityV1,
        assertLinuxNativeProviderQualificationAuthorityV1,
      ]) {
        expect(() => assertAuthority(document)).toThrow(
          LinuxNativeProviderContainmentAuthorityError,
        );
      }
    }
  });

  it("allows only the exact crypto dependency in the authority-none module", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("./plugin-native-linux-containment-capability.mjs", import.meta.url),
      ),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      "plugin-native-linux-containment-capability.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const dependencies = [];
    const dynamicLoaders = [];
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        dependencies.push(node.moduleSpecifier.text);
      }
      if (
        node.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node) &&
          [
            "Bun",
            "Deno",
            "EventSource",
            "Function",
            "WebSocket",
            "XMLHttpRequest",
            "eval",
            "fetch",
            "globalThis",
            "module",
            "navigator",
            "process",
            "require",
          ].includes(node.text))
      ) {
        dynamicLoaders.push(node.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(parsed.parseDiagnostics).toEqual([]);
    expect(dependencies).toEqual(["node:crypto"]);
    expect(dynamicLoaders).toEqual([]);
  });
});

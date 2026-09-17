import { describe, expect, it } from "vitest";
import {
  BACKEND_FEATURES,
  type BackendCapabilities,
  backendCapabilitiesSupport,
  classifyAppCompatibility,
  type FrontendBuildInfo,
} from "@/lib/platform/backendCompatibility";

const fingerprintA = `git-object-v1:${"a".repeat(40)}`;
const fingerprintB = `git-object-v1:${"b".repeat(40)}`;
const requiredFeatures = [BACKEND_FEATURES.hmuxManagedCreateAdvanceV1];

function frontend(
  buildId = "0.1.4+front",
  backendRuntimeFingerprint: string | null = fingerprintA,
): FrontendBuildInfo {
  return {
    schemaVersion: 1,
    buildId,
    sourceRevision: null,
    worktreeOverlay: "unknown",
    backendRuntimeFingerprint,
  };
}

function backend(
  overrides: Partial<BackendCapabilities> = {},
): BackendCapabilities {
  return {
    name: "dure-backend",
    packageVersion: "0.1.4",
    protocolVersion: 1,
    buildId: "0.1.4+back",
    runtimeFingerprint: fingerprintA,
    features: [
      ...requiredFeatures,
      BACKEND_FEATURES.appRuntimeFingerprint,
    ],
    ...overrides,
  };
}

describe("backend compatibility", () => {
  it("names capabilities after the surviving terminal-surface authorities", () => {
    expect(BACKEND_FEATURES.hmuxStandaloneTerminalSurface).toBe(
      "hmux.standalone-terminal-surface-v1",
    );
    expect(BACKEND_FEATURES.hmuxRemotePaneDeparture).toBe(
      "hmux.remote-pane-departure-v1",
    );
    expect(Object.values(BACKEND_FEATURES)).not.toContain(
      "hmux.standalone-controller-canary-v1",
    );
    expect(Object.values(BACKEND_FEATURES)).not.toContain(
      "hmux.remote-controller-v1",
    );
  });

  it("accepts unrelated revision drift when runtime fingerprints match", () => {
    const result = classifyAppCompatibility(
      frontend("0.1.4+new-head"),
      backend({ buildId: "0.1.4+old-head" }),
    );

    expect(result.mode).toBe("current");
    expect(result.comparisonBasis).toBe("runtime-fingerprint");
    expect(result.frontendBuildId).toBe("0.1.4+new-head");
    expect(result.frontendSourceRevision).toBeNull();
    expect(result.frontendWorktreeOverlay).toBe("unknown");
    expect(result.backend?.buildId).toBe("0.1.4+old-head");
  });

  it("requires a restart when backend runtime bytes differ", () => {
    const result = classifyAppCompatibility(
      frontend("0.1.4+same-head", fingerprintA),
      backend({
        buildId: "0.1.4+same-head",
        runtimeFingerprint: fingerprintB,
      }),
    );

    expect(result.mode).toBe("version-skew");
    expect(result.comparisonBasis).toBe("runtime-fingerprint");
  });

  it("fails closed when a fingerprint-capable build cannot generate one", () => {
    expect(
      classifyAppCompatibility(frontend("0.1.4+same", null), backend({
        buildId: "0.1.4+same",
      })),
    ).toMatchObject({
      mode: "version-skew",
      comparisonBasis: "fingerprint-unavailable",
    });
    expect(
      classifyAppCompatibility(frontend("0.1.4+same"), backend({
        buildId: "0.1.4+same",
        runtimeFingerprint: null,
      })),
    ).toMatchObject({
      mode: "version-skew",
      comparisonBasis: "fingerprint-unavailable",
    });
  });

  it("falls back to exact build IDs for old backends", () => {
    const oldFeatures = [...requiredFeatures];

    expect(
      classifyAppCompatibility(
        frontend("0.1.4+same"),
        backend({
          buildId: "0.1.4+same",
          runtimeFingerprint: undefined,
          features: oldFeatures,
        }),
      ),
    ).toMatchObject({
      mode: "current",
      comparisonBasis: "build-id-fallback",
    });
    expect(
      classifyAppCompatibility(
        frontend("0.1.4+front"),
        backend({
          buildId: "0.1.4+back",
          runtimeFingerprint: undefined,
          features: oldFeatures,
        }),
      ),
    ).toMatchObject({
      mode: "version-skew",
      comparisonBasis: "build-id-fallback",
    });
  });

  it("preserves degraded and legacy protocol behavior", () => {
    expect(
      classifyAppCompatibility(
        frontend(),
        backend({ protocolVersion: 0, features: [] }),
      ),
    ).toMatchObject({
      mode: "degraded",
      comparisonBasis: "none",
    });
    expect(classifyAppCompatibility(frontend(), null)).toMatchObject({
      mode: "legacy",
      comparisonBasis: "none",
    });
  });

  it("keeps feature support protocol-gated", () => {
    expect(
      backendCapabilitiesSupport(
        backend(),
        BACKEND_FEATURES.hmuxManagedCreateAdvanceV1,
      ),
    ).toBe(true);
    expect(
      backendCapabilitiesSupport(
        backend({ protocolVersion: 0 }),
        BACKEND_FEATURES.hmuxManagedCreateAdvanceV1,
      ),
    ).toBe(false);
    expect(backendCapabilitiesSupport(null, "missing")).toBe(false);
  });
});

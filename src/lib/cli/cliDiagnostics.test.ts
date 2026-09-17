import { describe, expect, it, vi } from "vitest";
import type { AppCompatibility } from "@/lib/ipc";
import {
  buildCliDiagnosticsReceipt,
  handleCliDiagnostics,
} from "@/lib/cli/cliDiagnostics";

const compatibility: AppCompatibility = {
  mode: "current",
  comparisonBasis: "runtime-fingerprint",
  frontendBuildId: "0.1.4+frontend",
  frontendSourceRevision: null,
  frontendWorktreeOverlay: "unknown",
  frontendRuntimeFingerprint: "git-object-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  backend: {
    name: "Dure",
    packageVersion: "0.1.4",
    protocolVersion: 1,
    buildId: "0.1.4+backend",
    runtimeFingerprint: "git-object-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    features: ["app.runtime-fingerprint-v1"],
  },
  missingFeatures: [],
};

describe("CLI diagnostics receipt", () => {
  it("projects the existing app compatibility decision into a versioned receipt", () => {
    expect(buildCliDiagnosticsReceipt(compatibility, 123)).toEqual({
      ok: true,
      schemaVersion: 1,
      generatedAtMs: 123,
      compatibility,
    });
  });

  it("claims once before inspecting and returns a typed failure", async () => {
    const claim = vi.fn().mockResolvedValue(true);
    const inspect = vi.fn().mockRejectedValue(new Error("backend unavailable"));

    await expect(
      handleCliDiagnostics("request-1", claim, inspect, () => 456),
    ).resolves.toEqual({
      ok: false,
      schemaVersion: 1,
      error: {
        code: "app_diagnostics_failed",
        message: "backend unavailable",
      },
    });
    expect(claim).toHaveBeenCalledWith("request-1");
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("does no work when another window owns the request", async () => {
    const inspect = vi.fn();

    await expect(
      handleCliDiagnostics(
        "request-2",
        vi.fn().mockResolvedValue(false),
        inspect,
      ),
    ).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  createFrontendRuntimeObservation,
  type FrontendRuntimeObservation,
  frontendRuntimeObservationMatchesTarget,
  normalizeFrontendRuntimeObservation,
} from "./frontendRuntimeObservation.mjs";

const target = "0123456789abcdef0123456789abcdef01234567";

function observation(
  overrides: Partial<FrontendRuntimeObservation> = {},
): FrontendRuntimeObservation {
  return {
    schemaVersion: 1,
    buildId: "0.1.4+ffffffffffff-dirty",
    sourceRevision: target.slice(0, 12),
    worktreeOverlay: "present",
    backendRuntimeFingerprint:
      "git-object-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

describe("frontend runtime observation", () => {
  it("uses the explicit source revision instead of interpreting the build label", () => {
    expect(frontendRuntimeObservationMatchesTarget(observation(), target)).toBe(
      true,
    );
    expect(
      frontendRuntimeObservationMatchesTarget(
        observation({ sourceRevision: "ffffffffffff" }),
        target,
      ),
    ).toBe(false);
  });

  it("normalizes clean, preserved-overlay, and unavailable source observations", () => {
    expect(normalizeFrontendRuntimeObservation(observation())).toEqual(
      observation(),
    );
    expect(
      createFrontendRuntimeObservation({
        buildId: "0.1.4+0123456789ab",
        sourceRevision: target.slice(0, 12),
        worktreeOverlay: "clean",
        backendRuntimeFingerprint: null,
      }),
    ).toMatchObject({ schemaVersion: 1, worktreeOverlay: "clean" });
    expect(
      createFrontendRuntimeObservation({
        buildId: "0.1.4+unknown",
        sourceRevision: null,
        worktreeOverlay: "unknown",
        backendRuntimeFingerprint: null,
      }),
    ).toMatchObject({ sourceRevision: null, worktreeOverlay: "unknown" });
    expect(
      normalizeFrontendRuntimeObservation({ ...observation(), future: true }),
    ).toEqual(observation());
  });

  it("rejects malformed or contradictory observations at the boundary", () => {
    expect(
      normalizeFrontendRuntimeObservation({
        ...observation(),
        schemaVersion: 2,
      }),
    ).toBeNull();
    expect(
      normalizeFrontendRuntimeObservation(
        observation({ sourceRevision: null, worktreeOverlay: "present" }),
      ),
    ).toBeNull();
    expect(
      normalizeFrontendRuntimeObservation(
        observation({ backendRuntimeFingerprint: "sha1:unsafe" }),
      ),
    ).toBeNull();
  });
});

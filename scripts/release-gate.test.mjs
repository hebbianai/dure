import { describe, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  assertPinnedCheckout,
  describeExactCiRuns,
  findExactSuccessfulCiRun,
  isV02ReleaseVersion,
  normalizeFullCommitSha,
  normalizeReleaseBump,
  normalizeReleaseVersion,
  selectReleaseEvent,
} from "./lib/release-gate.mjs";

const BASE = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("release exact-base gate", () => {
  test("bounds standing 0.2.x emergency policy to explicit beta versions", () => {
    for (const version of ["0.2.0", "0.2.17", "0.2.200"]) {
      expect(isV02ReleaseVersion(version)).toBe(true);
      expect(selectReleaseEvent({ version, beta: true })).toBe("macos-basic-v0.2-beta");
      expect(() => selectReleaseEvent({ version, beta: false })).toThrow("release_beta_required");
    }
    for (const version of ["0.1.9", "0.3.0", "1.2.0", "0.20.1", "v0.2.17", "0.2.17-beta"]) {
      expect(isV02ReleaseVersion(version)).toBe(false);
      expect(selectReleaseEvent({ version, beta: true })).toBe("release");
      expect(selectReleaseEvent({ version, beta: false })).toBe("release");
    }
  });

  test("drops hook-local Git pointers but preserves authentication variables", () => {
    expect(
      withoutLocalGitOverrides({
        GIT_ASKPASS: "/tmp/askpass",
        GIT_CONFIG_PARAMETERS: "'core.hooksPath'='.githooks'",
        GIT_DIR: "/repo/.git",
        GIT_WORK_TREE: "/repo",
        PATH: "/bin",
      }),
    ).toEqual({
      GIT_ASKPASS: "/tmp/askpass",
      PATH: "/bin",
    });
  });

  test("accepts only full immutable commit identities", () => {
    expect(normalizeFullCommitSha(BASE.toUpperCase())).toBe(BASE);
    expect(() => normalizeFullCommitSha("main")).toThrow(/full 40-character/);
    expect(() => normalizeFullCommitSha(BASE.slice(0, 12))).toThrow(/full 40-character/);
    expect(() => normalizeFullCommitSha(` ${BASE}`)).toThrow(/full 40-character/);
    expect(normalizeReleaseBump("patch")).toBe("patch");
    expect(normalizeReleaseBump("minor")).toBe("minor");
    expect(() => normalizeReleaseBump("major")).toThrow(/patch or minor/);
    expect(normalizeReleaseVersion("1.2.3")).toBe("1.2.3");
    expect(() => normalizeReleaseVersion("v1.2.3")).toThrow(/X\.Y\.Z/);
  });

  test("rejects a checkout that moved after workflow dispatch", () => {
    expect(assertPinnedCheckout(BASE, BASE)).toBe(BASE);
    expect(() => assertPinnedCheckout(BASE, OTHER)).toThrow(
      /release_checkout_mismatch/,
    );
  });

  test("accepts only a successful completed run for the exact SHA", () => {
    const green = {
      databaseId: 7,
      headSha: BASE,
      status: "completed",
      conclusion: "success",
      url: "https://example.test/run/7",
    };
    expect(
      findExactSuccessfulCiRun(BASE, [
        { ...green, headSha: OTHER },
        { ...green, status: "in_progress", conclusion: "" },
        green,
      ]),
    ).toBe(green);
  });

  test("does not substitute a green descendant for a missing or non-green exact run", () => {
    const runs = [
      { headSha: OTHER, status: "completed", conclusion: "success" },
      { headSha: BASE, status: "completed", conclusion: "cancelled" },
    ];
    expect(findExactSuccessfulCiRun(BASE, runs)).toBeNull();
    expect(describeExactCiRuns(BASE, runs)).toBe("completed/cancelled");
    expect(describeExactCiRuns(BASE, [])).toBe("missing");
  });
});

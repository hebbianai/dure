import { describe, expect, test } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  assertPinnedCheckout,
  ciEvidenceGaps,
  describeExactCiRuns,
  exactSuccessfulCiRuns,
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

  test("keeps every successful exact run as a candidate for job evidence", () => {
    const run = (databaseId, overrides = {}) => ({
      databaseId,
      headSha: BASE,
      status: "completed",
      conclusion: "success",
      ...overrides,
    });
    const runs = [run(1), run(2, { headSha: OTHER }), run(3, { conclusion: "failure" }), run(4)];
    expect(exactSuccessfulCiRuns(BASE, runs).map(({ databaseId }) => databaseId)).toEqual([1, 4]);
    expect(findExactSuccessfulCiRun(BASE, runs)).toBe(runs[0]);
  });
});

describe("release CI job evidence", () => {
  const listing = (conclusions = {}) => {
    const jobs = [
      "Select public checks",
      "Documentation checks",
      "Frontend checks",
      "Script checks",
      "Mobile web checks",
      "Public repository checks",
    ].map((name) => ({
      name,
      status: "completed",
      conclusion: Object.hasOwn(conclusions, name) ? conclusions[name] : "success",
    }));
    return { total_count: jobs.length, jobs };
  };

  test("accepts a run whose required result and code suites succeeded", () => {
    expect(ciEvidenceGaps(listing())).toEqual([]);
    // Mobile web is not release evidence on its own and may be absent.
    expect(ciEvidenceGaps(listing({ "Mobile web checks": "skipped" }))).toEqual([]);
  });

  test("refuses a successful run whose plan skipped the code suites", () => {
    expect(
      ciEvidenceGaps(listing({ "Frontend checks": "skipped", "Script checks": "skipped" })),
    ).toEqual(["Frontend checks skipped", "Script checks skipped"]);
    expect(ciEvidenceGaps(listing({ "Public repository checks": "skipped" }))).toEqual([
      "Public repository checks skipped",
    ]);
    expect(ciEvidenceGaps(listing({ "Script checks": null }))).toEqual([
      "Script checks unfinished",
    ]);
  });

  test("refuses missing, duplicated or incompletely listed jobs", () => {
    const complete = listing();
    const without = complete.jobs.filter(({ name }) => name !== "Frontend checks");
    expect(ciEvidenceGaps({ total_count: without.length, jobs: without })).toEqual([
      "Frontend checks missing",
    ]);
    const duplicated = [...complete.jobs, { name: "Script checks", conclusion: "success" }];
    expect(ciEvidenceGaps({ total_count: duplicated.length, jobs: duplicated })).toEqual([
      "Script checks ambiguous",
    ]);
    for (const incomplete of [
      { ...complete, total_count: complete.jobs.length + 1 },
      { total_count: 0 },
      null,
    ]) {
      expect(ciEvidenceGaps(incomplete)).toEqual(["job listing incomplete"]);
    }
  });
});

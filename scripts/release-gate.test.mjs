import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
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
  RELEASE_CI_EVIDENCE_JOB_PREFIXES,
  RELEASE_CI_REQUIRED_JOB,
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
  // A full public run: the frontend and script suites are matrix jobs.
  const names = [
    "Select public checks",
    "Documentation checks",
    "Frontend checks (shard 1)",
    "Frontend checks (shard 2)",
    "Frontend checks (shard 3)",
    "Script checks (vitest)",
    "Script checks (node scripts/qa/mobile-live.test.mjs)",
    "Script checks (deadline scripts/dure-cli-wait.test.mjs)",
    "Script checks (process scripts/run-dev-app.test.mjs)",
    "Mobile web checks",
    "Shared protocol (ubuntu-24.04)",
    "Hmux checks",
    "App core checks",
    "Public repository checks",
  ];
  const codeJobs = names.filter((name) => /^(?:Frontend|Script) checks/.test(name));
  const listing = (conclusions = {}, jobNames = names) => {
    const jobs = jobNames.map((name) => ({
      name,
      status: "completed",
      conclusion: Object.hasOwn(conclusions, name) ? conclusions[name] : "success",
    }));
    return { total_count: jobs.length, jobs };
  };

  test("accepts a run whose required result and every code suite job succeeded", () => {
    expect(ciEvidenceGaps(listing())).toEqual([]);
    // Mobile web and the Rust workspace jobs are not release evidence on their own.
    expect(
      ciEvidenceGaps(
        listing({ "Mobile web checks": "skipped", "Hmux checks": "skipped", "App core checks": "skipped" }),
      ),
    ).toEqual([]);
  });

  test("refuses a successful run whose plan skipped the code suites", () => {
    const skipped = Object.fromEntries(codeJobs.map((name) => [name, "skipped"]));
    expect(ciEvidenceGaps(listing(skipped))).toEqual(codeJobs.map((name) => `${name} skipped`));
    expect(ciEvidenceGaps(listing({ "Public repository checks": "skipped" }))).toEqual([
      "Public repository checks skipped",
    ]);
  });

  test("requires every shard and script job to succeed", () => {
    expect(ciEvidenceGaps(listing({ "Frontend checks (shard 2)": "skipped" }))).toEqual([
      "Frontend checks (shard 2) skipped",
    ]);
    expect(
      ciEvidenceGaps(listing({ "Script checks (deadline scripts/dure-cli-wait.test.mjs)": "failure" })),
    ).toEqual(["Script checks (deadline scripts/dure-cli-wait.test.mjs) failure"]);
    expect(ciEvidenceGaps(listing({ "Script checks (vitest)": null }))).toEqual([
      "Script checks (vitest) unfinished",
    ]);
  });

  test("refuses missing suites, a missing or duplicated result and incomplete listings", () => {
    const without = (prefix) => names.filter((name) => !name.startsWith(prefix));
    expect(ciEvidenceGaps(listing({}, without("Frontend checks")))).toEqual([
      "Frontend checks missing",
    ]);
    expect(ciEvidenceGaps(listing({}, without("Script checks")))).toEqual(["Script checks missing"]);
    expect(ciEvidenceGaps(listing({}, without("Public repository checks")))).toEqual([
      "Public repository checks missing",
    ]);
    expect(ciEvidenceGaps(listing({}, [...names, "Public repository checks"]))).toEqual([
      "Public repository checks ambiguous",
    ]);
    const complete = listing();
    for (const incomplete of [
      { ...complete, total_count: complete.jobs.length + 1 },
      { total_count: 0 },
      null,
    ]) {
      expect(ciEvidenceGaps(incomplete)).toEqual(["job listing incomplete"]);
    }
  });

  test("names exactly the public workflow's required result, frontend and script jobs", () => {
    const { jobs } = parse(readFileSync(".github/workflows/public-repository.yml", "utf8"));
    const ids = (matches) =>
      Object.entries(jobs)
        .filter(([, job]) => matches(job.name))
        .map(([id]) => id)
        .sort();
    expect(ids((name) => name === RELEASE_CI_REQUIRED_JOB)).toEqual(["public-repository"]);
    expect(RELEASE_CI_EVIDENCE_JOB_PREFIXES.map((prefix) => ids((name) => name.startsWith(prefix)))).toEqual([
      ["frontend"],
      ["scripts-deadline", "scripts-node", "scripts-process", "scripts-vitest"],
    ]);
  });
});

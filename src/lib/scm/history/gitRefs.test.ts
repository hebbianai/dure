import { describe, expect, it } from "vitest";
import {
  groupGitRefBadges,
  isInternalGitRef,
  parseProductGitBranches,
  productGitCommitGraph,
  productGitDecoration,
  productGitLogReadLimit,
  productGitLogRevisionArgs,
} from "./gitRefs";

describe("groupGitRefBadges", () => {
  it("keeps up to three refs visible in their original order", () => {
    expect(groupGitRefBadges(["main", "origin/main", "tag:v1"])).toEqual({
      visible: ["main", "origin/main", "tag:v1"],
      hidden: [],
    });
  });

  it("groups refs after the first three for a +N badge", () => {
    expect(
      groupGitRefBadges(["main", "origin/main", "origin/HEAD", "release", "tag:v1"]),
    ).toEqual({
      visible: ["main", "origin/main", "origin/HEAD"],
      hidden: ["release", "tag:v1"],
    });
  });

  it("supports a narrower explicit limit without mutating the input", () => {
    const refs = ["main", "origin/main", "release"];

    expect(groupGitRefBadges(refs, 1)).toEqual({
      visible: ["main"],
      hidden: ["origin/main", "release"],
    });
    expect(refs).toEqual(["main", "origin/main", "release"]);
  });
});

describe("Dure internal Git refs", () => {
  it.each([
    "refs/heads/dure-landing-control/v1",
    "refs/heads/dure-landing-stacks/v1/owner",
    "refs/heads/dure-candidates/v1/owner/candidate",
    "refs/remotes/origin/dure-landing-control/v1",
    "refs/remotes/upstream/dure-candidates/v1/owner/candidate",
    "refs/remotes/origin/__dolt_remote_info__",
    "refs/dolt/data",
    "refs/hebbian-wip/agent/checkpoint",
  ])("hides %s", (ref) => {
    expect(isInternalGitRef(ref)).toBe(true);
  });

  it.each([
    "refs/heads/main",
    "refs/heads/agent/dure-devops",
    "refs/heads/feature/dure-candidates-ui",
    "refs/remotes/origin/main",
    "refs/remotes/upstream/feature/dure-landing-control-view",
  ])("keeps %s", (ref) => {
    expect(isInternalGitRef(ref)).toBe(false);
  });

  it("filters full internal decorations without hiding similarly named user branches", () => {
    expect(productGitDecoration("refs/heads/dure-landing-control/v1")).toBeNull();
    expect(
      productGitDecoration("refs/remotes/upstream/dure-candidates/v1/owner/candidate"),
    ).toBeNull();
    expect(productGitDecoration("refs/remotes/upstream/__dolt_remote_info__")).toBeNull();
    expect(productGitDecoration("refs/remotes/origin/main")).toBe("origin/main");
    expect(productGitDecoration("refs/heads/team/dure-candidates/v1")).toBe(
      "team/dure-candidates/v1",
    );
  });

  it("places every exclusion before --all", () => {
    const args = productGitLogRevisionArgs();
    expect(args[args.length - 1]).toBe("--all");
    expect(args.slice(0, -1)).toEqual(
      expect.arrayContaining([
        "--exclude=refs/heads/dure-landing-control/**",
        "--exclude=refs/remotes/*/dure-candidates/**",
        "--exclude=refs/remotes/*/__dolt_remote_info__",
        "--exclude=refs/dolt/**",
      ]),
    );
    expect(args.slice(0, -1).every((arg) => arg.startsWith("--exclude="))).toBe(true);
  });

  it("bounds raw history overscan", () => {
    expect(productGitLogReadLimit(200)).toBe(1_000);
    expect(productGitLogReadLimit(1_000)).toBe(2_000);
    expect(productGitLogReadLimit(-1)).toBe(0);
  });
});

describe("productGitCommitGraph", () => {
  const commit = (
    hash: string,
    subject: string,
    parents: string[],
    refs: string[] = [],
  ) => ({ hash, subject, parents, refs });

  it("cuts the historical control transition merge parent and its private subgraph", () => {
    const commits = [
      commit("tip", "product tip", ["bad-merge"], ["origin/main"]),
      commit("bad-merge", "revert control merge", ["base", "control-155"]),
      commit("control-155", "Dure landing control transition 155", ["control-154", "land"]),
      commit("land", "land: Dure candidate abc123", ["candidate"]),
      commit("candidate", "feat: pending candidate", ["base"]),
      commit("control-154", "Dure landing control transition 154", ["base"]),
      commit("base", "product base", []),
    ];

    expect(productGitCommitGraph(commits, 200)).toEqual([
      commits[0],
      { ...commits[1], parents: ["base"] },
      commits[6],
    ]);
  });

  it("does not hide a single-parent user commit from its subject alone", () => {
    const commits = [
      commit("tip", "feature tip", ["user-transition"], ["feature/control-view"]),
      commit("user-transition", "Dure landing control transition 155", ["base"]),
      commit("base", "product base", []),
    ];

    expect(productGitCommitGraph(commits, 200)).toEqual(commits);
  });

  it("keeps a product commit that has its own visible branch ref", () => {
    const commits = [
      commit("main", "main", ["base", "control"], ["origin/main"]),
      commit("control", "Dure landing control transition 155", ["candidate"]),
      commit("candidate", "feat: active work", ["base"], ["agent/active-work"]),
      commit("base", "base", []),
    ];

    expect(productGitCommitGraph(commits, 200)).toEqual([
      { ...commits[0], parents: ["base"] },
      commits[2],
      commits[3],
    ]);
  });
});

describe("parseProductGitBranches", () => {
  it("keeps product branches while hiding coordinator and Beads refs", () => {
    const stdout = [
      "*refs/heads/agent/dure-devops",
      " refs/heads/dure-landing-control/v1",
      " refs/heads/feature/dure-candidates-ui",
      " refs/remotes/origin/HEAD",
      " refs/remotes/origin/main",
      " refs/remotes/origin/dure-landing-stacks/v1/owner",
      " refs/remotes/upstream/dure-candidates/v1/owner/candidate",
      " refs/remotes/upstream/release",
      " refs/remotes/origin/__dolt_remote_info__",
      "",
    ].join("\n");

    expect(parseProductGitBranches(stdout)).toEqual({
      current: "agent/dure-devops",
      local: ["agent/dure-devops", "feature/dure-candidates-ui"],
      remote: ["origin/main", "upstream/release"],
    });
  });
});

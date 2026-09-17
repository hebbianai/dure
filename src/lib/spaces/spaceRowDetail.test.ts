import { describe, expect, it } from "vitest";
import { spaceRowDetail } from "@/lib/spaces/spaceRowDetail";

describe("spaceRowDetail", () => {
  it("shows only the worktree within a repository group", () => {
    expect(
      spaceRowDetail({
        kind: "agent",
        cwd: "/repo/.worktrees/komojini-1",
        nestedSsh: false,
        relativePath: "worktree/komojini-1",
      }),
    ).toEqual({ source: "location", text: "worktree/komojini-1" });
  });

  it("replaces the path with live activity", () => {
    expect(
      spaceRowDetail({
        kind: "agent",
        cwd: "/repo/.worktrees/komojini-1",
        nestedSsh: false,
        relativePath: "worktree/komojini-1",
        activityText: "fix the retry loop",
      }),
    ).toEqual({ source: "activity", text: "fix the retry loop" });
  });

  it("prefers the provider conversation title over activity text", () => {
    expect(
      spaceRowDetail({
        kind: "agent",
        cwd: "/repo",
        nestedSsh: false,
        activityText: "마지막 프롬프트",
        conversationTitle: "Ship steering support",
      }),
    ).toEqual({ source: "conversation", text: "Ship steering support" });
  });

  it("shows a terminal cwd when no repository-relative path is known", () => {
    expect(
      spaceRowDetail({
        kind: "term",
        cwd: "/repo",
        nestedSsh: false,
      }),
    ).toEqual({ source: "location", text: "/repo" });
  });

  it("shows where the folder is for an agent at the repository root with nothing else to say", () => {
    expect(
      spaceRowDetail({
        kind: "agent",
        cwd: "/repo",
        nestedSsh: false,
        relativePath: "",
      }),
    ).toEqual({ source: "location", text: "/repo" });
  });

  it("shows a terminal's place inside the repository, and the folder itself at the root", () => {
    expect(
      spaceRowDetail({
        kind: "term",
        cwd: "/repo",
        nestedSsh: false,
        relativePath: "",
      }),
    ).toEqual({ source: "location", text: "/repo" });
    expect(
      spaceRowDetail({
        kind: "term",
        cwd: "/repo/src/lib",
        nestedSsh: false,
        relativePath: "src/lib",
      }),
    ).toEqual({ source: "location", text: "src/lib" });
  });

  it("does not invent a cwd for a nested SSH terminal", () => {
    expect(
      spaceRowDetail({
        kind: "term",
        cwd: "",
        nestedSsh: true,
      }),
    ).toEqual({ source: "none", text: "" });
  });
});

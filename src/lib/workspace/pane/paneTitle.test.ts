import { describe, expect, it } from "vitest";
import {
  agentPaneTitle,
  cwdName,
  observedTitle,
  paneTitleFromObservedTitle,
  paneTitleTooltip,
  resolveAgentPaneTitle,
  terminalPaneTitle,
} from "@/lib/workspace/pane/paneTitle";

describe("pane title policy", () => {
  it("names an agent pane from its live directory without a provider prefix", () => {
    expect(agentPaneTitle("komojini-1", "/work/HebbianIDE/hmux")).toBe("hmux");
  });

  it("prefers live cwd, then worktree, then the agent name", () => {
    expect(agentPaneTitle("komojini-1", "/work/live", "/work/tree")).toBe("live");
    expect(agentPaneTitle("komojini-1", undefined, "/work/tree")).toBe("tree");
    expect(agentPaneTitle("komojini-1")).toBe("komojini-1");
  });

  it("keeps shell titles host-oriented", () => {
    expect(terminalPaneTitle("rts", "/home/rts/project")).toBe("rts · project");
    expect(cwdName("C:\\work\\project\\")).toBe("project");
  });

  it("treats blank titles and a bare conversation id as no title at all", () => {
    expect(observedTitle(undefined)).toBeUndefined();
    expect(observedTitle("   ")).toBeUndefined();
    expect(observedTitle("01a06261-93d4-7fe3", "01a06261-93d4-7fe3")).toBeUndefined();
    expect(observedTitle(" Ship auth flow ", "01a06261-93d4-7fe3")).toBe("Ship auth flow");
  });

  it("uses a human terminal title but rejects an opaque conversation identity", () => {
    expect(paneTitleFromObservedTitle(" Review auth flow ", "project")).toBe(
      "Review auth flow",
    );
    expect(paneTitleFromObservedTitle("", "project")).toBe("project");
    expect(
      paneTitleFromObservedTitle(
        "conversation-1",
        "project",
        "conversation-1",
      ),
    ).toBe("project");
  });

  it("resolves one Agent title with an explicit rename ahead of runtime evidence", () => {
    expect(
      resolveAgentPaneTitle({
        name: "agent-1",
        displayName: "fix-uiux",
        runtimeTitle: "Review authentication flow",
        directoryCandidates: ["/repo/.worktrees/fix-live"],
      }),
    ).toBe("fix-uiux");
    expect(
      resolveAgentPaneTitle({
        name: "agent-1",
        runtimeTitle: "Review authentication flow",
        directoryCandidates: ["/repo/.worktrees/fix-live"],
      }),
    ).toBe("Review authentication flow");
  });

  it("includes a differing effective title in pane diagnostics without duplication", () => {
    expect(paneTitleTooltip("Review auth", "fix-live · local · /repo")).toBe(
      "Review auth — fix-live · local · /repo",
    );
    expect(paneTitleTooltip("fix-live", "fix-live · local · /repo")).toBe(
      "fix-live · local · /repo",
    );
  });
});

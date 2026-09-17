import { describe, expect, it } from "vitest";
import { fileDraftKey, fileTargetFromPane, fileTargetFromParams } from "./fileTarget";

describe("file target boundary", () => {
  it("does not infer missing content from otherwise valid file coordinates", () => {
    expect(fileTargetFromPane({ params: { path: "/a", source: "local" } })).toBeUndefined();
  });

  it.each([
    { path: "/repo/a path:with colon", source: "local" },
    { path: "/repo/remote", source: "ssh", hostId: "host" },
    { path: "/repo/remote", source: "ssh", sessionId: "session-only" },
    { path: "/repo/remote", source: "ssh", hostId: "host", sessionId: "session" },
  ])("preserves explicit file coordinates $source $path", (target) => {
    expect(fileTargetFromParams({ ...target, unrelated: true })).toEqual(target);
    expect(fileTargetFromPane({ component: "fileviewer", params: target })).toEqual(target);
    expect(fileTargetFromPane({ component: "terminal", params: target })).toBeUndefined();
  });

  it.each([
    null, undefined, [], {},
    { path: "/a" },
    { path: "", source: "local" },
    { path: 7, source: "local" },
    { path: "/a", source: "unknown" },
    { path: "/a", source: "ssh", hostId: "" },
    { path: "/a", source: "ssh", hostId: null },
    { path: "/a", source: "ssh", hostId: 7 },
    { path: "/a", source: "ssh", sessionId: "" },
    { path: "/a", source: "ssh", sessionId: 7 },
  ])("does not invent a target from malformed coordinates %j", (params) => {
    expect(fileTargetFromParams(params)).toBeUndefined();
    expect(fileTargetFromPane({ component: "fileviewer", params })).toBeUndefined();
  });

  it("retains the persisted draft key across session reconnection", () => {
    const target = { path: "/repo/draft", source: "ssh" as const, hostId: "host", sessionId: "before" };
    expect(fileDraftKey(target)).toBe("ssh:host:/repo/draft");
    expect(fileDraftKey({ ...target, sessionId: "after" })).toBe(fileDraftKey(target));
  });
});

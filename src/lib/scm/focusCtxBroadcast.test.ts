import { describe, expect, it } from "vitest";
import { parseFocusCtxSnapshot } from "@/lib/scm/focusCtxBroadcast";

describe("parseFocusCtxSnapshot", () => {
  it("정상 페이로드를 파싱한다", () => {
    const raw = JSON.stringify({
      key: "term:s1",
      cwd: "/repo",
      source: "local",
      label: "repo",
    });
    expect(parseFocusCtxSnapshot(raw)).toEqual({
      key: "term:s1",
      cwd: "/repo",
      source: "local",
      hostId: undefined,
      label: "repo",
    });
  });

  it("null 방송(포커스 없음)·부재·손상은 null", () => {
    expect(parseFocusCtxSnapshot("null")).toBeNull();
    expect(parseFocusCtxSnapshot(null)).toBeNull();
    expect(parseFocusCtxSnapshot("{broken")).toBeNull();
    expect(parseFocusCtxSnapshot(JSON.stringify({ cwd: 1, label: "x", source: "local" }))).toBeNull();
    expect(parseFocusCtxSnapshot(JSON.stringify({ cwd: "/a", label: "a", source: "ftp" }))).toBeNull();
  });

  it("ssh 컨텍스트의 hostId를 보존한다", () => {
    const raw = JSON.stringify({ cwd: "/srv", source: "ssh", hostId: "h1", label: "srv" });
    expect(parseFocusCtxSnapshot(raw)?.hostId).toBe("h1");
  });
});

import { describe, expect, it } from "vitest";
import { planGitStatusUpdate, sameGitStatus } from "@/lib/scm/status/gitStatusEquality";
import type { GitStatus } from "@/types";

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  isRepo: true,
  branch: "main",
  ahead: 1,
  behind: 0,
  staged: 2,
  unstaged: 3,
  untracked: 4,
  ...over,
});

describe("sameGitStatus", () => {
  it("모든 필드가 같으면 true — 폴링 재렌더 단락의 근거", () => {
    expect(sameGitStatus(status(), status())).toBe(true);
  });

  it("어느 필드든 다르면 false", () => {
    for (const over of [
      { isRepo: false },
      { branch: "dev" },
      { ahead: 9 },
      { behind: 9 },
      { staged: 9 },
      { unstaged: 9 },
      { untracked: 9 },
    ] as Partial<GitStatus>[]) {
      expect(sameGitStatus(status(), status(over))).toBe(false);
    }
  });

  it("이전 값이 없으면 false (첫 보고는 항상 저장)", () => {
    expect(sameGitStatus(undefined, status())).toBe(false);
  });
});

describe("planGitStatusUpdate", () => {
  it("변화도 에러도 없으면 null — 리스너 통지 생략의 근거", () => {
    const current = { gitStatuses: { a1: status() }, gitStatusErrors: {} };
    expect(planGitStatusUpdate(current, "a1", status())).toBeNull();
  });

  it("상태가 바뀌면 gitStatuses만 갱신한다", () => {
    const current = { gitStatuses: { a1: status() }, gitStatusErrors: {} };
    const update = planGitStatusUpdate(current, "a1", status({ ahead: 5 }));
    expect(update?.gitStatuses?.a1.ahead).toBe(5);
    expect(update?.gitStatusErrors).toBeUndefined();
  });

  it("상태 동일 + 에러 존재면 에러만 걷어내고 gitStatuses 참조를 보존한다", () => {
    const current = {
      gitStatuses: { a1: status() },
      gitStatusErrors: { a1: "boom", a2: "keep" },
    };
    const update = planGitStatusUpdate(current, "a1", status());
    expect(update?.gitStatuses).toBeUndefined();
    expect(update?.gitStatusErrors).toEqual({ a2: "keep" });
  });

  it("첫 보고는 항상 저장한다", () => {
    const update = planGitStatusUpdate(
      { gitStatuses: {}, gitStatusErrors: {} },
      "a1",
      status(),
    );
    expect(update?.gitStatuses?.a1).toBeTruthy();
  });
});

import { describe, expect, it } from "vitest";
import {
  parseFeedCommits,
  parseForEachRef,
  pickActiveBranch,
} from "@/lib/scm/history/activeBranchFeed";

describe("parseForEachRef", () => {
  it("ref와 committerdate를 파싱하고 origin/HEAD는 제외한다", () => {
    const out = "origin/HEAD\t100\norigin/main\t200\norigin/feat\t150\n";
    expect(parseForEachRef(out)).toEqual([
      { ref: "origin/main", lastCommitUnix: 200 },
      { ref: "origin/feat", lastCommitUnix: 150 },
    ]);
  });
});

describe("pickActiveBranch", () => {
  const main = { ref: "origin/main", lastCommitUnix: 200, recentCount: 3 };
  it("기본 브랜치를 우선한다 (동률 포함)", () => {
    const tied = { ref: "origin/feat", lastCommitUnix: 500, recentCount: 3 };
    expect(pickActiveBranch("origin/main", [main, tied])).toEqual({
      ref: "origin/main",
      reason: "default",
    });
  });
  it("최근 활동이 확실히 높은 브랜치로 전환하고 이유를 남긴다", () => {
    const hot = { ref: "origin/feat", lastCommitUnix: 500, recentCount: 9 };
    expect(pickActiveBranch("origin/main", [main, hot])).toEqual({
      ref: "origin/feat",
      reason: "recent-activity",
    });
  });
  it("기본 브랜치 정보가 없으면 최고 활동 브랜치", () => {
    const hot = { ref: "origin/feat", lastCommitUnix: 500, recentCount: 1 };
    expect(pickActiveBranch(null, [hot])).toEqual({
      ref: "origin/feat",
      reason: "recent-activity",
    });
  });
  it("후보가 없으면 기본 브랜치 또는 null", () => {
    expect(pickActiveBranch("origin/main", [])).toEqual({
      ref: "origin/main",
      reason: "default",
    });
    expect(pickActiveBranch(null, [])).toBeNull();
  });
});

describe("parseFeedCommits", () => {
  it("구분자 필드를 파싱한다 (subject 안 구분자는 보존)", () => {
    const line = ["abc123", "abc1234", "Jay", "2 minutes ago", "fix: a\x1fb"].join("\x1f");
    expect(parseFeedCommits(`${line}\n`)).toEqual([
      {
        hash: "abc123",
        shortHash: "abc1234",
        author: "Jay",
        relDate: "2 minutes ago",
        subject: "fix: a\x1fb",
      },
    ]);
  });
});

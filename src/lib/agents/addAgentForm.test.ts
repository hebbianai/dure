import { describe, expect, it } from "vitest";
import type { Project, SshHostConfig } from "@/types";
import { setLang } from "@/lib/i18n";
import { planWorktree } from "@/lib/scm/worktrees/worktreePlan";
import {
  canSubmit,
  deriveAgentName,
  DEFAULT_WORKTREE_ROOT,
  hostOptions,
  modeChoiceForTab,
  permissionToOverride,
  permissionToSkipPermissions,
  projectsForHost,
  recentProjectChips,
  searchPlaceholderForTab,
  WORKTREE_ROOTS,
  worktreeTabLabel,
  type WorktreeTab,
} from "./addAgentForm";

const project = (over: Partial<Project> & Pick<Project, "id">): Project => ({
  name: over.id,
  path: `/p/${over.id}`,
  kind: "local",
  isRepo: true,
  ...over,
});

const host = (id: string, name: string): SshHostConfig =>
  ({ id, name, host: "h", port: 22, user: "u", auth: "auto" }) as SshHostConfig;

describe("hostOptions", () => {
  it("로컬을 항상 맨 앞에 두고 호스트별 프로젝트 수를 센다", () => {
    const projects = [
      project({ id: "a" }),
      project({ id: "b" }),
      project({ id: "c", kind: "ssh", sshHostId: "h1" }),
      project({ id: "d", kind: "ssh", sshHostId: "h1" }),
      project({ id: "e", kind: "ssh", sshHostId: "h2" }),
    ];
    expect(hostOptions(projects, [host("h1", "v3_dh"), host("h2", "clink")])).toEqual([
      { id: null, name: "Local", projectCount: 2 },
      { id: "h1", name: "v3_dh", projectCount: 2 },
      { id: "h2", name: "clink", projectCount: 1 },
    ]);
  });

  it("프로젝트가 없는 호스트도 0으로 남는다 — 목록에서 사라지면 고를 수 없다", () => {
    expect(hostOptions([], [host("h1", "v3_dh")])).toEqual([
      { id: null, name: "Local", projectCount: 0 },
      { id: "h1", name: "v3_dh", projectCount: 0 },
    ]);
  });

  it("로컬 프로젝트가 하나도 없어도 로컬 줄은 남는다", () => {
    const options = hostOptions([project({ id: "c", kind: "ssh", sshHostId: "h1" })], [
      host("h1", "v3_dh"),
    ]);
    expect(options[0]).toEqual({ id: null, name: "Local", projectCount: 0 });
  });
});

describe("projectsForHost", () => {
  it("ssh 프로젝트는 그 호스트에만 속한다", () => {
    const projects = [
      project({ id: "a" }),
      project({ id: "c", kind: "ssh", sshHostId: "h1" }),
      project({ id: "e", kind: "ssh", sshHostId: "h2" }),
    ];
    expect(projectsForHost(projects, null).map((p) => p.id)).toEqual(["a"]);
    expect(projectsForHost(projects, "h1").map((p) => p.id)).toEqual(["c"]);
  });
});

describe("modeChoiceForTab", () => {
  it("탭이 기존 계획 모드로 대응된다", () => {
    expect(modeChoiceForTab("smart")).toBe("auto");
    expect(modeChoiceForTab("branch")).toBe("existing-branch");
    expect(modeChoiceForTab("name")).toBe("new-branch");
    // Github은 이슈에서 브랜치 이름을 만들어 내므로 만들어진 뒤엔 새 브랜치다.
    expect(modeChoiceForTab("github")).toBe("new-branch");
  });

  it("탭마다 검색 placeholder가 다르다", () => {
    expect(searchPlaceholderForTab("smart")).toContain("GitHub URL");
    expect(searchPlaceholderForTab("github")).toBe("#1234 · GitHub URL");
    expect(searchPlaceholderForTab("branch")).toBe("브랜치 이름");
  });
});

describe("permission", () => {
  it("상속은 backend projection을 따르고 명시 선택만 one-run override가 된다", () => {
    expect(permissionToSkipPermissions("write")).toBe(true);
    expect(permissionToSkipPermissions("ask")).toBe(false);
    expect(permissionToSkipPermissions("inherit", true)).toBe(true);
    expect(permissionToSkipPermissions("inherit", false)).toBe(false);
    expect(permissionToOverride("inherit")).toBeUndefined();
    expect(permissionToOverride("ask")).toBe("require_approvals");
    expect(permissionToOverride("write")).toBe("bypass_approvals");
  });
});

describe("recentProjectChips", () => {
  it("최근 쓴 순으로 자르고 다른 호스트는 섞지 않는다", () => {
    const projects = [
      project({ id: "a" }),
      project({ id: "b" }),
      project({ id: "c" }),
      project({ id: "remote", kind: "ssh", sshHostId: "h1" }),
    ];
    const chips = recentProjectChips(projects, null, { a: 10, b: 30, c: 20 }, 2);
    expect(chips.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("사용 기록이 없는 프로젝트는 뒤로 밀린다", () => {
    const projects = [project({ id: "old" }), project({ id: "used" })];
    expect(recentProjectChips(projects, null, { used: 5 }).map((p) => p.id)).toEqual([
      "used",
      "old",
    ]);
  });
});

describe("canSubmit", () => {
  const base = {
    project: project({ id: "a" }),
    name: "claude-1",
    worktreePlanReady: true,
    busy: false,
  };

  it("모두 갖춰지면 제출할 수 있다", () => {
    expect(canSubmit(base)).toBe(true);
  });

  it("위치가 없으면 만들 수 없다 — 시안엔 비활성 상태가 없지만 잠가야 한다", () => {
    expect(canSubmit({ ...base, project: null })).toBe(false);
  });

  it("이름이 공백뿐이면 막는다", () => {
    expect(canSubmit({ ...base, name: "   " })).toBe(false);
  });

  it("계획이 불가하면 막는다", () => {
    expect(canSubmit({ ...base, worktreePlanReady: false })).toBe(false);
  });

  it("생성 중에는 중복 제출을 막는다", () => {
    expect(canSubmit({ ...base, busy: true })).toBe(false);
  });
});

describe("동적 t() 키의 번역", () => {
  /** 탭 라벨과 placeholder는 t(변수)로 렌더돼 i18nCoverage의 정적 스캔에
   *  걸리지 않는다. 기본 표시 언어가 영어라 번역이 빠지면 한국어가 그대로
   *  새므로 영어 표시 언어에서 직접 해석해 검증한다. */
  const leaks = (label: string) => /[가-힣]/.test(label);

  it("영어 표시 언어에서 탭 라벨과 placeholder가 영어로 해석된다", () => {
    const tabs: WorktreeTab[] = ["smart", "github", "branch", "name"];
    setLang("en");
    try {
      const leaked = [
        ...tabs.map(worktreeTabLabel),
        ...tabs.map(searchPlaceholderForTab),
      ].filter(leaks);
      expect(leaked, `en에서 한국어가 새어 나옴: ${leaked.join(", ")}`).toEqual([]);
    } finally {
      setLang("ko");
    }
  });
});

describe("WORKTREE_ROOTS", () => {
  it("기본값이 선택지 안에 있다 — 셀렉트가 빈 값으로 열리면 안 된다", () => {
    expect(WORKTREE_ROOTS).toContain(DEFAULT_WORKTREE_ROOT);
  });

  /** worktreePlan.joinPath가 같은 문자열을 기본값으로 박아 두고 있다. 둘이
   *  갈리면 UI가 "기본"이라고 표시한 위치와 실제로 만들어지는 위치가 달라진다. */
  it("계획 모듈의 기본 루트와 같은 경로를 만든다", () => {
    const withExplicitDefault = planWorktree({
      repoPath: "/repo",
      agentName: "claude-1",
      branch: "feature",
      mode: "new-branch",
      baseRef: "main",
      branches: [],
      worktrees: [],
      worktreeRoot: DEFAULT_WORKTREE_ROOT,
    });
    const withImplicitDefault = planWorktree({
      repoPath: "/repo",
      agentName: "claude-1",
      branch: "feature",
      mode: "new-branch",
      baseRef: "main",
      branches: [],
      worktrees: [],
    });
    expect(withExplicitDefault.worktreePath).toBe(withImplicitDefault.worktreePath);
  });
});

describe("deriveAgentName", () => {
  it("uses the typed branch name as the agent identity", () => {
    expect(
      deriveAgentName({
        autoName: "claude-26",
        branch: "darwin",
        branchWasTyped: true,
        takenNames: ["claude-25"],
      }),
    ).toBe("darwin");
  });

  it("keeps the auto name when nothing was typed", () => {
    expect(
      deriveAgentName({
        autoName: "claude-26",
        branch: "claude-26",
        branchWasTyped: false,
        takenNames: [],
      }),
    ).toBe("claude-26");
  });

  it("flattens slashes and dedupes collisions", () => {
    expect(
      deriveAgentName({
        autoName: "claude-3",
        branch: "feature/login",
        branchWasTyped: true,
        takenNames: ["feature-login", "feature-login-2"],
      }),
    ).toBe("feature-login-3");
  });

  it("normalizes typed display text into one canonical identity", () => {
    expect(
      deriveAgentName({
        autoName: "claude-3",
        branch: `Feature/${"A".repeat(80)}`,
        branchWasTyped: true,
        takenNames: [],
      }),
    ).toBe(`feature-${"a".repeat(56)}`);
  });
});

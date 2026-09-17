import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  scanWorktrees: vi.fn(),
  listBranchesCommand: vi.fn(),
  scanWorktreesCommand: vi.fn(),
  sshExecOnce: vi.fn(),
  parseBranches: vi.fn(),
  parseWorktreeScan: vi.fn(),
  hostToOpts: vi.fn(),
}));

vi.mock("@/lib/ipc", () => mocks);

import { loadRepoBranchState } from "./repoBranchLoad";

const local: Project = {
  id: "p-local",
  name: "repo",
  path: "/repo",
  kind: "local",
  isRepo: true,
};

const remote: Project = {
  id: "p-remote",
  name: "repo",
  path: "/srv/repo",
  kind: "ssh",
  sshHostId: "h1",
  isRepo: true,
};

const host = { id: "h1", name: "v3_dh" } as SshHostConfig;

const branch = { name: "main" };
const worktree = { path: "/repo", branch: "main", isMain: true, extra: "dropped" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listBranches.mockResolvedValue([branch]);
  mocks.scanWorktrees.mockResolvedValue([worktree]);
  mocks.listBranchesCommand.mockResolvedValue("git branch");
  mocks.scanWorktreesCommand.mockResolvedValue("git worktree list");
  mocks.sshExecOnce.mockResolvedValue({ code: 0, stdout: "raw", stderr: "" });
  mocks.parseBranches.mockResolvedValue([branch]);
  mocks.parseWorktreeScan.mockResolvedValue([worktree]);
  mocks.hostToOpts.mockReturnValue({ host: "h" });
});

describe("loadRepoBranchState", () => {
  it("저장소가 아니면 조회하지 않는다", async () => {
    await expect(loadRepoBranchState({ ...local, isRepo: false }, [])).resolves.toEqual({
      branches: [],
      worktrees: [],
    });
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("로컬은 직접 IPC로 읽고 요약 필드만 남긴다", async () => {
    const state = await loadRepoBranchState(local, []);
    expect(mocks.listBranches).toHaveBeenCalledWith("/repo");
    expect(state.branches).toEqual([branch]);
    // WorktreeSummary가 아닌 필드가 계획으로 새면 안 된다.
    expect(state.worktrees).toEqual([{ path: "/repo", branch: "main", isMain: true }]);
  });

  /** 이 경로가 빠지면 SSH 프로젝트에서 브랜치 탭이 늘 비고 기준이 HEAD로 접힌다. */
  it("원격은 같은 명령을 호스트에서 돌려 그 출력을 파싱한다", async () => {
    const state = await loadRepoBranchState(remote, [host]);
    expect(mocks.sshExecOnce).toHaveBeenCalledTimes(2);
    expect(mocks.parseBranches).toHaveBeenCalledWith("raw");
    expect(state.branches).toEqual([branch]);
    expect(state.worktrees).toEqual([{ path: "/repo", branch: "main", isMain: true }]);
  });

  it("등록되지 않은 호스트면 빈 목록", async () => {
    await expect(loadRepoBranchState(remote, [])).resolves.toEqual({
      branches: [],
      worktrees: [],
    });
    expect(mocks.sshExecOnce).not.toHaveBeenCalled();
  });

  /** 목록 로드 실패로 다이얼로그 자체가 못 열리면 안 된다. */
  it("조회가 실패해도 빈 목록으로 떨어진다", async () => {
    mocks.listBranches.mockRejectedValue(new Error("no git"));
    await expect(loadRepoBranchState(local, [])).resolves.toEqual({
      branches: [],
      worktrees: [],
    });
  });
});

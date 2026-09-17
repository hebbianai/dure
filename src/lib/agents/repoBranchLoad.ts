// 에이전트 추가 다이얼로그가 워크트리를 계획하려면 그 저장소의 브랜치·워크트리
// 목록이 필요하다. 로컬은 직접 IPC, 원격(SSH)은 같은 명령을 호스트에서 돌린 뒤
// 그 출력을 파싱한다 — 원격 경로가 빠지면 SSH 프로젝트에서 브랜치 탭이 늘 비고
// 기준(baseRef)이 HEAD 하나로 접힌다.

import {
  hostToOpts,
  listBranches,
  listBranchesCommand,
  parseBranches,
  parseWorktreeScan,
  scanWorktrees,
  scanWorktreesCommand,
  sshExecOnce,
} from "@/lib/ipc";
import type { BranchInfo, WorktreeSummary } from "@/lib/scm/worktrees/worktreePlan";
import type { Project, SshHostConfig } from "@/types";

export interface RepoBranchState {
  branches: BranchInfo[];
  worktrees: WorktreeSummary[];
}

const EMPTY: RepoBranchState = { branches: [], worktrees: [] };

const toSummary = (d: {
  path: string;
  branch: string;
  isMain: boolean;
}): WorktreeSummary => ({ path: d.path, branch: d.branch, isMain: d.isMain });

/**
 * 저장소의 브랜치·워크트리 목록.
 *
 * 실패는 빈 목록으로 떨어뜨린다 — 계획은 빈 목록으로도 동작하고(새 브랜치),
 * 여기서 예외를 올리면 다이얼로그가 통째로 못 열린다.
 */
export async function loadRepoBranchState(
  project: Project,
  sshHosts: readonly SshHostConfig[],
): Promise<RepoBranchState> {
  if (!project.isRepo) return EMPTY;
  try {
    if (project.kind === "local") {
      const [branches, worktrees] = await Promise.all([
        listBranches(project.path),
        scanWorktrees(project.path),
      ]);
      return { branches, worktrees: worktrees.map(toSummary) };
    }
    const host = sshHosts.find((candidate) => candidate.id === project.sshHostId);
    if (!host) return EMPTY;
    const opts = hostToOpts(host);
    const [branchOut, worktreeOut] = await Promise.all([
      sshExecOnce(opts, await listBranchesCommand(project.path)),
      sshExecOnce(opts, await scanWorktreesCommand(project.path)),
    ]);
    const [branches, worktrees] = await Promise.all([
      parseBranches(branchOut.stdout),
      parseWorktreeScan(worktreeOut.stdout),
    ]);
    return { branches, worktrees: worktrees.map(toSummary) };
  } catch {
    return EMPTY;
  }
}

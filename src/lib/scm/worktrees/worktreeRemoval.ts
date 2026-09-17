// 에이전트의 전용 워크트리 제거 계획 (순수 로직).
// 에이전트를 제거할 때 그 에이전트가 자기 전용 워크트리를 갖고 있으면
// 디스크에서도 지울지 선택할 수 있게 한다 — 계획 산출은 여기서, 실행은
// resourceLifecycle에서.

import { sameWorktreeLocation } from "@/lib/scm/worktrees/worktreeLocation";

export interface WorktreeAgent {
  readonly id: string;
  readonly worktreePath: string;
  /** 워크트리 생성 시 만들어진 브랜치 — 없으면 전용 워크트리가 아니다 */
  readonly branch: string;
  readonly projectId: string;
  readonly sessionKind: "pty" | "ssh";
}

export interface WorktreeProject {
  readonly id: string;
  readonly path: string;
  readonly kind: "local" | "ssh";
  readonly sshHostId?: string;
}

interface WorktreeRemovalTarget {
  /** git worktree remove를 실행할 repo 루트 */
  readonly repo: string;
  /** 제거할 워크트리 경로 */
  readonly wtPath: string;
}

export type WorktreeRemovalPlan =
	| (WorktreeRemovalTarget & {
			readonly kind: "local";
			readonly hostId?: never;
	  })
	| (WorktreeRemovalTarget & {
			readonly kind: "ssh";
			readonly hostId: string;
	  });

export interface WorktreeRemovalScope<
	TAgent extends WorktreeAgent = WorktreeAgent,
> {
  readonly affectedAgents: readonly TAgent[];
  readonly unresolvedAgents: readonly TAgent[];
  readonly absentAgents?: readonly TAgent[];
}

/**
 * 에이전트가 전용 워크트리를 갖고 있으면 제거 계획을, 아니면 null.
 * 판정: 워크트리 생성 시에만 branch가 채워지고 경로가 repo 루트와 다르다.
 * (useWorktree:false 에이전트는 branch="" & worktreePath == project.path)
 */
export function planAgentWorktreeRemoval(
  agent: WorktreeAgent,
  project: WorktreeProject | undefined,
): WorktreeRemovalPlan | null {
  if (!project) return null;
	const repo = project.path;
	const wtPath = agent.worktreePath;
	if (
		!agent.branch ||
		!wtPath ||
		sameWorktreeLocation(
			wtPath,
			repo,
			project.kind === "ssh" ? "posix" : "native",
		)
	) {
		return null;
    }
	if (project.kind === "ssh") {
		const hostId = project.sshHostId;
		return hostId ? { kind: "ssh", hostId, repo, wtPath } : null;
  }
	return { kind: "local", repo, wtPath };
}

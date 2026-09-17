// addAgent의 워크트리 확보 분기 — store에서 추출(god-file). 로컬/SSH ×
// 브랜치 피커 계획/레거시 네 갈래를 한 곳에서 처리하고 {path, branch}만
// 돌려준다. IPC 함수들은 주입 가능해 픽스처로 테스트한다.
// 네임스페이스 임포트 + 호출 시점 접근 — 좁게 mock한 테스트(@/lib/ipc를
// 몇 개 export로만 대체)가 이 모듈의 정적 named import에 깨지지 않게 한다.
import * as ipc from "@/lib/ipc";
import type { WorktreeProvisionPlan } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import type { WorktreePlan } from "@/lib/scm/worktrees/worktreePlan";
import type { Project, SshHostConfig } from "@/types";

export type AgentWorktreeProvisionDeps = Pick<
	typeof ipc,
	| "createWorktree"
	| "provisionWorktree"
	| "provisionWorktreeCommand"
	| "sshExecOnce"
	| "worktreeCommand"
>;

export interface ProvisionedAgentWorktree {
	readonly path: string;
	readonly branch: string;
}

export async function provisionAgentWorktree(
	input: {
		project: Project;
		name: string;
		useWorktree: boolean;
		worktreePlan?: WorktreePlan;
		/** A durable outer saga already provisioned this exact worktree. */
		provisionedWorktree?: ProvisionedAgentWorktree;
		sshHosts: readonly SshHostConfig[];
	},
	deps: AgentWorktreeProvisionDeps = ipc,
): Promise<ProvisionedAgentWorktree> {
	const {
		project,
		name,
		useWorktree,
		worktreePlan,
		provisionedWorktree,
		sshHosts,
	} = input;
	if (provisionedWorktree) return provisionedWorktree;
	if (!(useWorktree && project.isRepo)) {
		return { path: project.path, branch: "" };
	}
	const requireHost = (): SshHostConfig => {
		const host = sshHosts.find((h) => h.id === project.sshHostId);
		if (!host) throw new Error(t("common.sshHostNotFound"));
		return host;
	};
	if (worktreePlan) {
		// 브랜치 피커 경로: 백엔드가 계획을 실행하고 실제 브랜치를 돌려준다.
		const req: WorktreeProvisionPlan = {
			repo: project.path,
			branch: worktreePlan.branch,
			worktreePath: worktreePlan.worktreePath,
			action: worktreePlan.action,
			baseRef: worktreePlan.baseRef,
			// 전체 경로가 아니라 루트만 보낸다 — 조립은 백엔드가 한다(경로 바꿔치기
			// 방지). 이걸 빼면 백엔드가 .worktrees/를 기본으로 되돌려 고급의
			// '워크트리 위치' 선택이 조용히 무시된다.
			worktreeRoot: worktreePlan.worktreeRoot,
		};
		if (project.kind === "local") {
			const wt = await deps.provisionWorktree(req);
			return { path: wt.path, branch: wt.branch };
		}
		const [cmd, path] = await deps.provisionWorktreeCommand(req);
		const r = await deps.sshExecOnce(ipc.hostToOpts(requireHost()), cmd);
		if (r.code !== 0) {
			// adopt 검증(grep -qxF)은 조용히 실패한다 — 빈 출력이면 설명 메시지로.
			const detail = (r.stdout + r.stderr).trim();
			throw new Error(
				detail ||
					t("agents.worktree.remoteProvisionFailed"),
			);
		}
		// 실제 브랜치는 stdout 트레일러(git add 진행은 stderr) — 없으면 계획값 폴백.
		return {
			path,
			branch:
				r.stdout.match(/^worktree-branch (.+)$/m)?.[1]?.trim() ??
				worktreePlan.branch,
		};
	}
	if (project.kind === "local") {
		// 레거시 경로(Sidebar/Spaces): agent/<name> 새 워크트리(이제 실제 브랜치 반환).
		const wt = await deps.createWorktree(project.path, name);
		return { path: wt.path, branch: wt.branch };
	}
	const [cmd, path, branch] = await deps.worktreeCommand(project.path, name);
	const r = await deps.sshExecOnce(ipc.hostToOpts(requireHost()), cmd);
	if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim());
	return { path, branch };
}

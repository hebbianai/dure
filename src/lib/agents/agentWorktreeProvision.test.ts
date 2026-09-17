import { describe, expect, it, vi } from "vitest";
import type { WorktreePlan } from "@/lib/scm/worktrees/worktreePlan";
import type { Project, SshHostConfig } from "@/types";
import {
	provisionAgentWorktree,
	type AgentWorktreeProvisionDeps,
} from "./agentWorktreeProvision";

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

const host = { id: "h1", name: "v3_dh", host: "h", port: 22, user: "u" } as SshHostConfig;

const plan = (over: Partial<WorktreePlan> = {}): WorktreePlan => ({
	branch: "feature",
	mode: "new-branch",
	action: "create-new-branch",
	worktreePath: "/repo/.claude/worktrees/feature",
	worktreeRoot: ".claude/worktrees/",
	baseRef: "main",
	branchExists: false,
	...over,
});

const deps = (over: Partial<AgentWorktreeProvisionDeps> = {}): AgentWorktreeProvisionDeps =>
	({
		createWorktree: vi.fn().mockResolvedValue({ path: "/repo/.worktrees/x", branch: "x" }),
		provisionWorktree: vi
			.fn()
			.mockResolvedValue({ path: "/repo/.claude/worktrees/feature", branch: "feature" }),
		provisionWorktreeCommand: vi
			.fn()
			.mockResolvedValue(["cmd", "/srv/repo/.claude/worktrees/feature"]),
		sshExecOnce: vi
			.fn()
			.mockResolvedValue({ code: 0, stdout: "worktree-branch feature\n", stderr: "" }),
		worktreeCommand: vi.fn().mockResolvedValue(["cmd", "/srv/repo/.worktrees/x", "x"]),
		...over,
	}) as unknown as AgentWorktreeProvisionDeps;

describe("provisionAgentWorktree", () => {
	it.each([
		{ label: "local", project: local, sshHosts: [] },
		{ label: "SSH", project: remote, sshHosts: [host] },
	])(
		"외부 saga가 준비한 $label 워크트리는 backend를 다시 호출하지 않고 소비한다",
		async ({ project, sshHosts }) => {
			const d = deps();
			const provisionedWorktree = {
				path: `${project.path}/.worktrees/codex-1`,
				branch: "agent/codex-1",
			};

			await expect(
				provisionAgentWorktree(
					{
						project,
						name: "codex-1",
						useWorktree: true,
						provisionedWorktree,
						sshHosts,
					},
					d,
				),
			).resolves.toEqual(provisionedWorktree);
			expect(d.createWorktree).not.toHaveBeenCalled();
			expect(d.provisionWorktree).not.toHaveBeenCalled();
			expect(d.provisionWorktreeCommand).not.toHaveBeenCalled();
			expect(d.sshExecOnce).not.toHaveBeenCalled();
			expect(d.worktreeCommand).not.toHaveBeenCalled();
		},
	);

	it("워크트리를 안 쓰면 프로젝트 루트를 그대로 돌려준다", async () => {
		await expect(
			provisionAgentWorktree(
				{ project: local, name: "claude-1", useWorktree: false, sshHosts: [] },
				deps(),
			),
		).resolves.toEqual({ path: "/repo", branch: "" });
	});

	/** 이 필드가 빠지면 백엔드가 `.worktrees/`로 되돌려 고급의 '워크트리 위치'
	 *  선택이 조용히 무시된다 — 프런트 테스트만으로는 안 잡히던 자리다. */
	it("고른 워크트리 루트를 프로비저닝 요청에 실어 보낸다", async () => {
		const d = deps();
		await provisionAgentWorktree(
			{
				project: local,
				name: "claude-1",
				useWorktree: true,
				worktreePlan: plan(),
				sshHosts: [],
			},
			d,
		);
		expect(d.provisionWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ worktreeRoot: ".claude/worktrees/" }),
		);
	});

	it("원격도 같은 루트를 실어 보낸다", async () => {
		const d = deps();
		await provisionAgentWorktree(
			{
				project: remote,
				name: "claude-1",
				useWorktree: true,
				worktreePlan: plan({ worktreePath: "/srv/repo/.claude/worktrees/feature" }),
				sshHosts: [host],
			},
			d,
		);
		expect(d.provisionWorktreeCommand).toHaveBeenCalledWith(
			expect.objectContaining({ worktreeRoot: ".claude/worktrees/" }),
		);
	});

	it("경로는 백엔드가 돌려준 값을 쓴다 — 계획값을 믿지 않는다", async () => {
		const d = deps({
			provisionWorktree: vi
				.fn()
				.mockResolvedValue({ path: "/repo/.worktrees/feature", branch: "feature" }),
		} as Partial<AgentWorktreeProvisionDeps>);
		await expect(
			provisionAgentWorktree(
				{
					project: local,
					name: "claude-1",
					useWorktree: true,
					worktreePlan: plan(),
					sshHosts: [],
				},
				d,
			),
		).resolves.toEqual({ path: "/repo/.worktrees/feature", branch: "feature" });
	});

	it("원격 실패는 출력과 함께 올린다", async () => {
		const d = deps({
			sshExecOnce: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" }),
		} as Partial<AgentWorktreeProvisionDeps>);
		await expect(
			provisionAgentWorktree(
				{
					project: remote,
					name: "claude-1",
					useWorktree: true,
					worktreePlan: plan(),
					sshHosts: [host],
				},
				d,
			),
		).rejects.toThrow("boom");
	});
});

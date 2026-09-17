import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	captureGitCheckoutInstance: vi.fn(),
	locateGitCheckoutPaths: vi.fn(),
	prepareRemoteGitCheckoutHelper: vi.fn(),
	removeGitCheckoutInstance: vi.fn(),
	prepareTrustedSshTarget: vi.fn(),
	sshExecOnce: vi.fn(),
}));

vi.mock("@/lib/ipc/git", () => mocks);
vi.mock("@/lib/ipc/sessions", () => mocks);

import {
	type PreparedAgentWorktreeRemoval,
	prepareAgentWorktreeRemoval,
	removePreparedAgentWorktree,
} from "@/lib/agents/agentWorktreeRemoval";
import type { WorktreeRemovalPlan } from "@/lib/scm/worktrees/worktreeRemoval";
import type { SshHostConfig } from "@/types";

const instance = {
	schemaVersion: 1 as const,
	canonicalPath: "/repo/.worktrees/research",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/research",
	instanceToken: "dwt1_0123456789abcdef0123456789abcdef",
};

describe("prepared Agent worktree removal", () => {
	beforeEach(() => vi.resetAllMocks());

	it.each(["local", "ssh"] as const)(
		"uses exact %s absence after capture fails, without issuing a delete",
		async (transport) => {
			const plan: WorktreeRemovalPlan = {
				...(transport === "ssh" ? { kind: "ssh", hostId: "host-1" } : { kind: "local" }),
				repo: "/repo",
				wtPath: instance.canonicalPath,
			};
			const absent = { schemaVersion: 1, absentPath: plan.wtPath };
			mocks.captureGitCheckoutInstance.mockRejectedValue(new Error("capture failed"));
			mocks.locateGitCheckoutPaths.mockResolvedValue([absent]);
			mocks.prepareTrustedSshTarget.mockResolvedValue({ hostId: "host-1" });
			mocks.prepareRemoteGitCheckoutHelper.mockResolvedValue(
				`/home/dev/.local/share/dure/remote-tools/dure-git-checkout-helper/${"a".repeat(64)}`,
			);
			mocks.sshExecOnce
				.mockRejectedValueOnce(new Error("capture failed"))
				.mockResolvedValueOnce({
					code: 0,
					stderr: "",
					stdout: `${JSON.stringify({ schemaVersion: 1, value: [absent] })}\n`,
				});
			const hosts = [{ id: "host-1" }] as SshHostConfig[];

			expect(await prepareAgentWorktreeRemoval(plan, hosts)).toEqual(absent);
			expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
			if (transport === "ssh") {
				expect(mocks.prepareTrustedSshTarget).toHaveBeenCalledWith(hosts, "host-1");
				expect(mocks.sshExecOnce).toHaveBeenCalledTimes(2);
				expect(mocks.sshExecOnce.mock.calls[1][1].command).toMatch(/ locations-v1$/);
				expect(JSON.parse(mocks.sshExecOnce.mock.calls[1][1].stdin).paths).toEqual([plan.wtPath]);
			} else {
				expect(mocks.locateGitCheckoutPaths).toHaveBeenCalledWith([plan.wtPath]);
				expect(mocks.sshExecOnce).not.toHaveBeenCalled();
			}
		},
	);

	it.each([undefined, instance])(
		"preserves capture refusal when absence is not proven (%j)",
		async (location) => {
			const failure = new Error("checkout identity changed");
			mocks.captureGitCheckoutInstance.mockRejectedValue(failure);
			mocks.locateGitCheckoutPaths.mockResolvedValue([location]);
			await expect(prepareAgentWorktreeRemoval({
				kind: "local", repo: "/repo", wtPath: instance.canonicalPath,
			}, [])).rejects.toBe(failure);
			expect(mocks.removeGitCheckoutInstance).not.toHaveBeenCalled();
		},
	);

	it("preserves confirmed destructive intent across a frontend HMR handoff", async () => {
		mocks.removeGitCheckoutInstance.mockResolvedValue({
			schemaVersion: 1,
			outcome: "removed",
			instance,
		});
		const legacyPreparedRemoval = {
			transport: "local",
			plan: {
				kind: "local",
				repo: "/repo",
				wtPath: instance.canonicalPath,
			},
			instance,
		} as unknown as PreparedAgentWorktreeRemoval;

		await removePreparedAgentWorktree(legacyPreparedRemoval);

		expect(mocks.removeGitCheckoutInstance).toHaveBeenCalledWith(
			"/repo",
			instance,
			"discard_changes",
		);
	});
});

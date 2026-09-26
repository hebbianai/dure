import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureGitCheckoutInstance,
	locateGitCheckoutPaths,
	localRepositoryStatus,
	prepareRemoteGitCheckoutHelper,
	removeGitCheckoutInstance,
} from "@/lib/ipc/git";
import { GitCheckoutCommandError } from "@/lib/scm/worktrees/gitCheckoutInstance";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const instance = {
	schemaVersion: 1 as const,
	canonicalPath: "/repo/worktree",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/worktree",
	instanceToken: "dwt1_0123456789abcdef0123456789abcdef",
};

beforeEach(() => {
	invokeMock.mockReset();
});

it("preserves explicit repository uncertainty and rejects malformed probe responses", async () => {
	invokeMock.mockResolvedValueOnce({ status: "unknown", detail: "Git unavailable" });
	await expect(localRepositoryStatus("/repo")).resolves.toEqual({ status: "unknown", detail: "Git unavailable" });
	expect(invokeMock).toHaveBeenLastCalledWith("local_repository_status", { path: "/repo" });
	invokeMock.mockResolvedValueOnce({ status: "unknown" });
	await expect(localRepositoryStatus("/repo")).rejects.toThrow("Invalid repository status response");
});

describe("local Git checkout instance IPC", () => {
	it("passes the captured instance through the exact removal boundary", async () => {
		invokeMock.mockResolvedValueOnce(instance).mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "removed",
			instance,
		});

		await expect(
			captureGitCheckoutInstance("/repo", instance.canonicalPath),
		).resolves.toEqual(instance);
		await expect(
			removeGitCheckoutInstance("/repo", instance, "require_clean"),
		).resolves.toEqual({
				schemaVersion: 1,
				outcome: "removed",
				instance,
			});
		expect(invokeMock).toHaveBeenNthCalledWith(
			1,
			"capture_git_checkout_instance",
			{
				repo: "/repo",
				worktreePath: instance.canonicalPath,
			},
		);
		expect(invokeMock).toHaveBeenNthCalledWith(
			2,
			"remove_git_checkout_instance",
			{
				repo: "/repo",
				instance,
				policy: "require_clean",
			},
		);
	});

	it("normalizes structured backend failures into searchable typed errors", async () => {
		invokeMock.mockRejectedValue({
			code: "worktree_identity_changed",
			message: "replacement checkout observed",
		});

		const error = await removeGitCheckoutInstance(
			"/repo",
			instance,
			"require_clean",
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(GitCheckoutCommandError);
		expect(error).toMatchObject({
			code: "worktree_identity_changed",
			message: "worktree_identity_changed: replacement checkout observed",
		});
	});

	it("parses one backend-canonical location batch", async () => {
		const locations = [
			{
				schemaVersion: 1,
				canonicalPath: "/repo/worktree",
				gitCommonDir: "/repo/.git",
			},
			null,
		];
		invokeMock.mockResolvedValue(locations);

		await expect(
			locateGitCheckoutPaths(["/repo/worktree", "/missing"]),
		).resolves.toEqual([locations[0], undefined]);
		expect(invokeMock).toHaveBeenCalledWith("locate_git_checkout_paths", {
			paths: ["/repo/worktree", "/missing"],
		});
	});

	it.each([
		{ value: [] },
		{ value: [undefined] },
		{
			value: [
				{
					schemaVersion: 1,
					canonicalPath: "relative",
					gitCommonDir: "/repo/.git",
				},
			],
		},
		{
			value: [
				{
					schemaVersion: 1,
					canonicalPath: "/repo/worktree",
					gitCommonDir: "/repo/.git",
					extra: true,
				},
			],
		},
	])("rejects a malformed local location batch", async ({ value }) => {
		invokeMock.mockResolvedValue(value);

		await expect(
			locateGitCheckoutPaths(["/repo/worktree"]),
		).rejects.toMatchObject({
			code: "worktree_receipt_invalid",
		});
	});

	it.each([
		{ schemaVersion: 99, outcome: "removed", instance },
		{ schemaVersion: 1, outcome: "bogus", instance },
		{
			schemaVersion: 1,
			outcome: "removed",
			instance: { ...instance, instanceToken: "bad" },
		},
		{ schemaVersion: 1, outcome: "removed", instance, extra: true },
	])(
		"rejects a malformed local removal receipt at the IPC boundary",
		async (value) => {
			invokeMock.mockResolvedValue(value);

			await expect(
				removeGitCheckoutInstance("/repo", instance, "require_clean"),
			).rejects.toMatchObject({
				code: "worktree_receipt_invalid",
			});
		},
	);

	it("accepts backend-canonical Windows paths without POSIX reinterpretation", async () => {
		const windowsInstance = {
			...instance,
			canonicalPath: "C:\\repo\\worktree",
			gitCommonDir: "C:\\repo\\.git",
			gitDir: "C:\\repo\\.git\\worktrees\\worktree",
		};
		invokeMock.mockResolvedValueOnce(windowsInstance).mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "removed",
			instance: windowsInstance,
		});

		await expect(
			captureGitCheckoutInstance("C:\\repo", windowsInstance.canonicalPath),
		).resolves.toEqual(windowsInstance);
		await expect(
			removeGitCheckoutInstance(
				"C:\\repo",
				windowsInstance,
				"require_clean",
			),
		).resolves.toMatchObject({ outcome: "removed" });
	});

	it("accepts ordinary backend-canonical Windows location batches", async () => {
		const location = {
			schemaVersion: 1,
			canonicalPath: "C:\\repo\\worktree",
			gitCommonDir: "C:\\repo\\.git",
		};
		invokeMock.mockResolvedValue([location]);

		await expect(
			locateGitCheckoutPaths(["\\\\?\\C:\\repo\\worktree"]),
		).resolves.toEqual([location]);
	});

	it("prepares one exact remote helper through the native capability boundary", async () => {
		const target = {
			schemaVersion: 1 as const,
			hostId: "host-1",
			host: "devbox.example",
			port: 22,
			user: "developer",
			auth: "key" as const,
			hostKeyFingerprints: ["SHA256:trusted"],
		};
		const helper = `/home/developer/.local/share/dure/remote-tools/dure-git-checkout-helper/${"a".repeat(64)}`;
		invokeMock.mockResolvedValue(helper);

		await expect(prepareRemoteGitCheckoutHelper(target)).resolves.toBe(helper);
		expect(invokeMock).toHaveBeenCalledWith(
			"prepare_remote_git_checkout_helper",
			{
				opts: {
					host: target.host,
					port: target.port,
					user: target.user,
					auth: target.auth,
					hostKeyFingerprints: target.hostKeyFingerprints,
				},
			},
		);
	});

	it("normalizes failed and malformed remote helper capabilities without fallback", async () => {
		const target = {
			schemaVersion: 1 as const,
			hostId: "host-1",
			host: "devbox.example",
			port: 22,
			user: "developer",
			auth: "auto" as const,
			hostKeyFingerprints: [],
		};
		invokeMock.mockRejectedValueOnce("capability probe failed");
		await expect(prepareRemoteGitCheckoutHelper(target)).rejects.toMatchObject({
			code: "remote_git_checkout_capability_unavailable",
		});
		expect(invokeMock).toHaveBeenCalledOnce();

		invokeMock.mockReset().mockResolvedValueOnce("/unversioned/helper");
		await expect(prepareRemoteGitCheckoutHelper(target)).rejects.toMatchObject({
			code: "remote_git_checkout_capability_unavailable",
		});
		expect(invokeMock).toHaveBeenCalledOnce();
	});
});

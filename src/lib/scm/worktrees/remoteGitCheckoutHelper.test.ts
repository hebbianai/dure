import { describe, expect, it } from "vitest";
import {
	GitCheckoutCommandError,
	type GitCheckoutCommandResult,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import {
	parseRemoteGitCheckoutCapture,
	parseRemoteGitCheckoutHelperPath,
	parseRemoteGitCheckoutLocations,
	parseRemoteGitCheckoutRemoval,
	remoteGitCheckoutCaptureExecution,
	remoteGitCheckoutLocationsExecution,
	remoteGitCheckoutRemovalExecution,
} from "@/lib/scm/worktrees/remoteGitCheckoutHelper";

const helper = parseRemoteGitCheckoutHelperPath(
	`/home/dev/.local/share/dure/remote-tools/dure-git-checkout-helper/${"a".repeat(64)}`,
);
const instance = {
	schemaVersion: 1 as const,
	canonicalPath: "/repo/.worktrees/agent",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/agent",
	instanceToken: "dwt1_0123456789abcdef0123456789abcdef",
};

function result(value: unknown, code = 0): GitCheckoutCommandResult {
	return {
		code,
		stderr: "",
		stdout: `${JSON.stringify(value)}\n`,
	};
}

function errorCode(thunk: () => unknown): string | undefined {
	try {
		thunk();
	} catch (error) {
		return error instanceof GitCheckoutCommandError ? error.code : undefined;
	}
}

describe("remote Git checkout helper boundary", () => {
	it("sends bounded JSON to one exact content-addressed helper", () => {
		const capture = remoteGitCheckoutCaptureExecution(helper, {
			schemaVersion: 1,
			operation: "capture",
			repo: "/repo",
			worktreePath: instance.canonicalPath,
		});
		expect(capture.command).toBe(`'${helper}' capture-v1`);
		expect(JSON.parse(capture.stdin)).toEqual({
			repositoryPath: "/repo",
			checkoutPath: instance.canonicalPath,
		});

		const locations = remoteGitCheckoutLocationsExecution(helper, [
			instance.canonicalPath,
		]);
		expect(locations.command).toBe(`'${helper}' locations-v1`);
		expect(JSON.parse(locations.stdin)).toEqual({
			schemaVersion: 1,
			paths: [instance.canonicalPath],
		});

		const removal = remoteGitCheckoutRemovalExecution(helper, {
			schemaVersion: 1,
			operation: "remove",
			repo: "/repo",
			instance,
			policy: "discard_changes",
		});
		expect(removal.command).toBe(`'${helper}' remove-v1`);
		expect(JSON.parse(removal.stdin)).toEqual({
			repositoryPath: "/repo",
			instance,
			policy: "discard_changes",
		});
	});

	it("rejects an unversioned helper path at the IPC boundary", () => {
		expect(
			errorCode(() =>
				parseRemoteGitCheckoutHelperPath(
					"/home/dev/.local/bin/dure-git-checkout-helper",
				),
			),
		).toBe("remote_git_checkout_capability_unavailable");
	});

	it("parses typed capture, location, and correlated removal receipts", () => {
		expect(
			parseRemoteGitCheckoutCapture(
				result({ schemaVersion: 1, value: instance }),
			),
		).toEqual(instance);
		expect(
			parseRemoteGitCheckoutLocations(
				[instance.canonicalPath, "/missing"],
				result({
					schemaVersion: 1,
					value: [
						{
							schemaVersion: 1,
							canonicalPath: instance.canonicalPath,
							gitCommonDir: instance.gitCommonDir,
						},
						null,
					],
				}),
			),
		).toEqual([
			expect.objectContaining({ canonicalPath: instance.canonicalPath }),
			undefined,
		]);
		expect(
			parseRemoteGitCheckoutRemoval(
				{
					schemaVersion: 1,
					operation: "remove",
					repo: "/repo",
					instance,
					policy: "require_clean",
				},
				result({
					schemaVersion: 1,
					value: { schemaVersion: 1, outcome: "removed", instance },
				}),
			),
		).toMatchObject({ outcome: "removed", instance });
	});

	it("preserves authority errors but normalizes a missing helper capability", () => {
		expect(
			errorCode(() =>
				parseRemoteGitCheckoutRemoval(
					{
						schemaVersion: 1,
						operation: "remove",
						repo: "/repo",
						instance,
						policy: "require_clean",
					},
					result(
						{
							schemaVersion: 1,
							error: {
								code: "checkout_use_in_use",
								message: "checkout is still claimed",
							},
						},
						50,
					),
				),
			),
		).toBe("checkout_use_in_use");

		expect(
			errorCode(() =>
				parseRemoteGitCheckoutCapture({
					code: 127,
					stdout: "",
					stderr: "not found",
				}),
			),
		).toBe("remote_git_checkout_capability_unavailable");
	});

	it("rejects malformed success output instead of inventing a fallback", () => {
		expect(
			errorCode(() =>
				parseRemoteGitCheckoutCapture({
					code: 0,
					stdout: "not-json\n",
					stderr: "",
				}),
			),
		).toBe("worktree_receipt_invalid");
	});
});

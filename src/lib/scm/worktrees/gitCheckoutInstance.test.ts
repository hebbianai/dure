import { describe, expect, it } from "vitest";
import {
	GitCheckoutCommandError,
	isGitCheckoutInstanceV1,
	parseGitCheckoutRemovalReceipt,
	parseLocalGitCheckoutInstance,
	parseLocalGitCheckoutLocations,
	parseRemoteGitCheckoutInstance,
	parseRemoteGitCheckoutLocations,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import { validWorktree } from "../../../../cli/lib/contracts/agent-spawn-worktree.mjs";

const instance = {
	schemaVersion: 1 as const,
	canonicalPath: "/repo/.worktrees/agent",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/agent",
	instanceToken: "dwt1_0123456789abcdef0123456789abcdef",
};

function code(thunk: () => unknown): string | undefined {
	try {
		thunk();
	} catch (error) {
		return error instanceof GitCheckoutCommandError ? error.code : undefined;
	}
}

describe("Git checkout adapter boundary", () => {
	it("keeps CLI selection and desktop decoding on the same checkout identity contract", () => {
		for (const candidate of [
			instance,
			{ ...instance, gitDir: "/other/.git/worktrees/agent" },
			{ ...instance, gitDir: instance.gitCommonDir },
			{ ...instance, canonicalPath: "/repo/../other" },
			{
				...instance,
				canonicalPath: "C:\\repo\\.worktrees\\agent",
				gitCommonDir: "C:\\repo\\.git",
				gitDir: "C:\\repo\\.git\\worktrees\\agent",
			},
		]) {
			expect(
				validWorktree({
					kind: "existing_checkout",
					instance: candidate,
					branch: "user/work",
					base_commit_sha: "a".repeat(40),
				}),
			).toBe(isGitCheckoutInstanceV1(candidate));
		}
	});

	it("accepts one exact linked-checkout identity", () => {
		expect(parseLocalGitCheckoutInstance(instance)).toEqual(instance);
		expect(parseRemoteGitCheckoutInstance(instance)).toEqual(instance);
		expect(isGitCheckoutInstanceV1(instance)).toBe(true);
	});

	it("rejects malformed identities and private directories outside the common Git dir", () => {
		for (const candidate of [
			null,
			{ ...instance, schemaVersion: 2 },
			{ ...instance, instanceToken: "dwt1_short" },
			{ ...instance, gitDir: instance.gitCommonDir },
			{ ...instance, gitDir: "/other/.git/worktrees/agent" },
			{ ...instance, extra: true },
		]) {
			expect(code(() => parseLocalGitCheckoutInstance(candidate))).toBe(
				"worktree_receipt_invalid",
			);
		}
	});

	it("keeps native local paths but requires POSIX paths from an SSH helper", () => {
		const windows = {
			...instance,
			canonicalPath: "C:\\repo\\.worktrees\\agent",
			gitCommonDir: "C:\\repo\\.git",
			gitDir: "C:\\repo\\.git\\worktrees\\agent",
		};
		expect(parseLocalGitCheckoutInstance(windows)).toEqual(windows);
		expect(code(() => parseRemoteGitCheckoutInstance(windows))).toBe(
			"worktree_receipt_invalid",
		);
	});

	it("parses bounded location batches once at each transport boundary", () => {
		const paths = [instance.canonicalPath, "/missing"];
		const value = [
			{
				schemaVersion: 1,
				canonicalPath: instance.canonicalPath,
				gitCommonDir: instance.gitCommonDir,
			},
			null,
		];
		expect(parseLocalGitCheckoutLocations(value, paths)).toEqual([
			value[0],
			undefined,
		]);
		expect(parseRemoteGitCheckoutLocations(value, paths)).toEqual([
			value[0],
			undefined,
		]);
	});

	it("rejects location count, shape, and path-bound violations", () => {
		for (const [value, paths] of [
			[[], []],
			[[null], ["relative"]],
			[[null, null], ["/one"]],
			[[{ schemaVersion: 1, canonicalPath: "/one" }], ["/one"]],
			[
				Array.from({ length: 257 }, () => null),
				Array.from({ length: 257 }, (_, index) => `/repo/${index}`),
			],
		] as const) {
			expect(code(() => parseRemoteGitCheckoutLocations(value, paths))).toBe(
				"worktree_receipt_invalid",
			);
		}
	});

	it.each([parseLocalGitCheckoutLocations, parseRemoteGitCheckoutLocations])(
		"keeps backend-proven absence distinct from an unknown lookup",
		(parse) => {
			const absent = { schemaVersion: 1, absentPath: "/removed" };
			expect(parse([absent, null], ["/removed", "/unknown"])).toEqual([
				absent, undefined,
			]);
			for (const receipt of [
				{ ...absent, absentPath: "/another" },
				{ ...absent, schemaVersion: 2 },
				{ ...absent, extra: true },
			]) {
				expect(code(() => parse([receipt], ["/removed"]))).toBe("worktree_receipt_invalid");
			}
		},
	);

	it("correlates a removal receipt to the frozen checkout generation", () => {
		const receipt = {
			schemaVersion: 1,
			outcome: "removed",
			instance,
		};
		expect(parseGitCheckoutRemovalReceipt(receipt, instance)).toEqual(receipt);
		expect(
			code(() =>
				parseGitCheckoutRemovalReceipt(
					{
						...receipt,
						instance: {
							...instance,
							instanceToken: "dwt1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
					instance,
				),
			),
		).toBe("worktree_receipt_invalid");
	});
});

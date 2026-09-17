import { describe, expect, it } from "vitest";
import { parseRunPresentationWorktree } from "./runPresentationWorktree";

describe("shared Run presentation workspace receipt", () => {
	it("does not apply new-branch naming limits to an already selected checkout", () => {
		const value = {
			kind: "existing_checkout",
			branch: `${"a".repeat(128)}/${"b".repeat(128)}`,
			rootPath: "/repo/existing-checkout",
		};
		expect(parseRunPresentationWorktree(value)).toEqual(value);
	});

	it("preserves explicit and legacy default destinations without recomputing either", () => {
		const dedicated = {
			kind: "dedicated",
			branch: "agent/feature-x",
			directoryName: "feature-x",
		};
		for (const value of [
			dedicated,
			{ ...dedicated, rootPath: "/custom/work/feature-x" },
		]) {
			expect(parseRunPresentationWorktree(value)).toEqual(value);
		}
	});

	it("preserves project-root and existing-source workspace identities", () => {
		for (const value of [
			{ kind: "project_root" },
			{
				kind: "existing_checkout",
				branch: "user/work",
				rootPath: "/repo/preexisting-checkout",
			},
			{
				kind: "existing_workspace",
				sourceAgentId: "agent-source",
				rootPath: "/repo/source",
			},
		])
			expect(parseRunPresentationWorktree(value)).toEqual(value);
	});

	it("does not project a relative destination or a mismatched derived directory", () => {
		const dedicated = {
			kind: "dedicated",
			branch: "agent/feature-x",
			directoryName: "feature-x",
		};
		expect(
			parseRunPresentationWorktree({ ...dedicated, rootPath: "relative/work" }),
		).toBeNull();
		expect(
			parseRunPresentationWorktree({ ...dedicated, directoryName: "another" }),
		).toBeNull();
	});
});

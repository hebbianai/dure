import { describe, expect, it } from "vitest";
import {
	parseSagaRequest,
	SagaStepError,
} from "@/lib/sessions/launch/spawnSagaRequest";

const base = { receiptId: "sp_1", project: "HebbianIDE", provider: "claude" };

describe("parseSagaRequest", () => {
	it("parses a minimal request with defaults", () => {
		const request = parseSagaRequest(base);
		expect(request).toMatchObject({
			receiptId: "sp_1",
			project: "HebbianIDE",
			provider: "claude",
			useWorktree: true,
			runtime: "legacy",
		});
		expect(request.worktreePlan).toBeUndefined();
	});

	it("accepts a dialog-computed worktree plan verbatim", () => {
		const request = parseSagaRequest({
			...base,
			worktreePlan: {
				branch: "darwin",
				worktreePath: "/repo/.worktrees/darwin",
				action: "create-new-branch",
				baseRef: "origin/main",
				worktreeRoot: ".worktrees",
			},
		});
		expect(request.worktreePlan).toEqual({
			branch: "darwin",
			worktreePath: "/repo/.worktrees/darwin",
			action: "create-new-branch",
			baseRef: "origin/main",
			worktreeRoot: ".worktrees",
		});
	});

	it("accepts one exact existing-worktree identity instead of a create plan", () => {
		const existingWorktreeRef = {
			canonicalPath: "/repo/.worktrees/existing",
			gitCommonDir: "/repo/.git",
			gitDir: "/repo/.git/worktrees/existing",
			branch: "agent/existing",
			head: "0123456789abcdef0123456789abcdef01234567",
		};
		expect(
			parseSagaRequest({ ...base, existingWorktreeRef }),
		).toMatchObject({
			useWorktree: true,
			existingWorktreeRef,
		});
	});

	it("rejects ambiguous or disabled worktree inputs", () => {
		const existingWorktreeRef = {
			canonicalPath: "/repo/.worktrees/existing",
			gitCommonDir: "/repo/.git",
			gitDir: "/repo/.git/worktrees/existing",
			branch: "agent/existing",
			head: "0123456789abcdef0123456789abcdef01234567",
		};
		const worktreePlan = {
			branch: "new",
			worktreePath: "/repo/.worktrees/new",
			action: "create-new-branch",
		};
		for (const request of [
			{ ...base, existingWorktreeRef, worktreePlan },
			{ ...base, useWorktree: false, existingWorktreeRef },
			{ ...base, existingWorktreeRef: { ...existingWorktreeRef, head: "HEAD" } },
			{
				...base,
				worktreePlan: { ...worktreePlan, action: "adopt-worktree" },
			},
		]) {
			expect(() => parseSagaRequest(request)).toThrowError(
				expect.objectContaining({ code: "invalid_request" }),
			);
		}
	});

	it("preserves the credential selection across journal resume", () => {
		expect(
			parseSagaRequest({ ...base, accountId: "account-claude-work" }).accountId,
		).toBe("account-claude-work");
		expect(parseSagaRequest({ ...base, accountId: null }).accountId).toBeNull();
		expect(() => parseSagaRequest({ ...base, accountId: "" })).toThrowError(
			expect.objectContaining({ code: "invalid_request" }),
		);
	});

	it("rejects a malformed worktree plan fail-closed", () => {
		for (const worktreePlan of [
			{ branch: "", worktreePath: "/x", action: "create-new-branch" },
			{ branch: "b", worktreePath: "", action: "create-new-branch" },
			{ branch: "b", worktreePath: "/x", action: "delete-everything" },
			"not-an-object",
		]) {
			expect(() => parseSagaRequest({ ...base, worktreePlan })).toThrowError(
				expect.objectContaining({ code: "invalid_request" }),
			);
		}
	});

	it("keeps existing validations: provider, runtime, placement", () => {
		expect(() => parseSagaRequest({ ...base, provider: "skynet" })).toThrowError(
			SagaStepError,
		);
		expect(() => parseSagaRequest({ ...base, runtime: "warp" })).toThrowError(
			expect.objectContaining({ code: "invalid_request" }),
		);
		expect(() =>
			parseSagaRequest({ ...base, placement: { direction: "diagonal" } }),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";
import { supportsCanonicalAddAgentRun } from "@/lib/agents/addAgentCanonicalRun";
import type { QuickDispatchIntentV1 } from "@/lib/agents/quickDispatch/quickDispatchIntent";
import { MAX_QUICK_DISPATCH_PROMPT_BYTES } from "@/lib/agents/quickDispatch/quickDispatchPrompt";
import type { QuickDispatchRunDependencies } from "@/lib/agents/quickDispatch/quickDispatchRun";
import {
	resetQuickDispatchResumeForTest,
	resumeInterruptedQuickDispatchIntents,
	runQuickDispatch,
} from "@/lib/agents/quickDispatch/quickDispatchRun";

const project = {
	id: "p1",
	name: "P",
	path: "/repo/p",
	kind: "local" as const,
	isRepo: true,
};
const baseSha = "a".repeat(40);
const codexWork = {
	id: "acc-codex-work",
	provider: "codex" as const,
	name: "Codex work",
	dir: "/accounts/codex-work",
};
const intent = {
	schemaVersion: 1 as const,
	intentId: "qd_1",
	createdAtMs: 0,
	promptText: "Fix the sidebar flicker",
	attachmentPaths: ["/att/1.png"],
	projectId: "p1",
	providerId: "claude" as const,
	model: "opus",
	effort: "xhigh",
	typedName: null,
	state: "pending" as const,
};

function makeDeps() {
	return {
		// Typed so a test can reassign it with real accounts or uiPrefs.
		readState: (): ReturnType<QuickDispatchRunDependencies["readState"]> => ({
			projects: [project],
			agents: [],
			accounts: [],
		}),
		suggestName: vi.fn().mockResolvedValue("fix-sidebar-flicker"),
		deterministicName: vi.fn().mockReturnValue("fix-sidebar-flicker"),
		readRepoBranchState: vi
			.fn<QuickDispatchRunDependencies["readRepoBranchState"]>()
			.mockResolvedValue({ branches: [], worktrees: [] }),
		renameDisplayName: vi.fn(),
		resolveBaseRef: vi.fn().mockResolvedValue("origin/main"),
		resolveBaseRefSha: vi
			.fn<QuickDispatchRunDependencies["resolveBaseRefSha"]>()
			.mockResolvedValue(baseSha),
		pin: vi.fn((_intentId, resolution) => resolution),
		probeSetup: vi.fn().mockResolvedValue("pnpm install"),
		resolvePaneTarget: vi.fn(() => ({
			spaceId: "space-1",
			windowLabel: "main",
		})),
		runCanonical: vi.fn().mockResolvedValue({}),
		runRemote: vi.fn().mockResolvedValue({ id: "remote-agent" }),
		progress: vi.fn(),
		complete: vi.fn(),
		fail: vi.fn(),
		nowMs: () => 42,
		delay: vi.fn().mockResolvedValue(undefined),
	};
}

function reportedStages(deps: { progress: ReturnType<typeof vi.fn> }) {
	return deps.progress.mock.calls.map((call) => call[1]);
}

describe("runQuickDispatch", () => {
	it.each([false, true])("launches in the selected checkout without Git or setup probes (repository=%s)", async (isRepo) => {
		const deps = makeDeps();
		deps.readState = () => ({ projects: [{ ...project, isRepo }], agents: [], accounts: [] });
		deps.readRepoBranchState.mockRejectedValue(new Error("must not inspect branches"));
		deps.resolveBaseRef.mockRejectedValue(new Error("must not resolve a base"));
		deps.probeSetup.mockRejectedValue(new Error("must not run setup"));
		await runQuickDispatch({ ...intent, useWorktree: false }, deps as never);
		expect(deps.fail).not.toHaveBeenCalled();
		expect(deps.runCanonical).toHaveBeenCalledWith(expect.objectContaining({
			project: expect.objectContaining({ path: project.path }),
			useWorktree: false, setupCommand: null,
		}), expect.anything());
		expect(deps.runCanonical.mock.calls[0][0]).not.toHaveProperty("worktreePlan");
		expect(deps.readRepoBranchState).not.toHaveBeenCalled();
		expect(deps.resolveBaseRef).not.toHaveBeenCalled();
		expect(deps.resolveBaseRefSha).not.toHaveBeenCalled();
		expect(deps.probeSetup).not.toHaveBeenCalled();
		expect(deps.pin).toHaveBeenCalledWith(intent.intentId, {
			resolvedName: "fix-sidebar-flicker", resolvedBaseSha: null, resolvedSetupCommand: null,
		});
	});

	it.each([undefined, true])("preserves worktree launch for legacy and opted-in intents (%s)", async (useWorktree) => {
		const deps = makeDeps();
		await runQuickDispatch({ ...intent, useWorktree }, deps as never);
		expect(deps.runCanonical).toHaveBeenCalledWith(expect.objectContaining({
			useWorktree: true, worktreePlan: expect.objectContaining({ baseRef: baseSha, action: "create-new-branch" }),
		}), expect.anything());
	});

	it.each(["require_approvals", "auto_edit", "bypass_approvals"] as const)("replays exact %s permission and disabled setup through the canonical run", async (permissionOverride) => {
		const deps = makeDeps();
		await runQuickDispatch({
			...intent, permissionOverride, runSetup: false,
		} as QuickDispatchIntentV1, deps as never);
		expect(deps.runCanonical).toHaveBeenCalledWith(expect.objectContaining({
			permissionOverride, setupCommand: null,
		}), expect.anything());
		expect(deps.probeSetup).not.toHaveBeenCalled();
		expect(deps.pin).toHaveBeenCalledWith(intent.intentId, expect.objectContaining({ resolvedSetupCommand: null }));
	});

	it("reports naming, spawning, then done for a fresh dispatch", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		expect(reportedStages(deps)).toEqual(["spawning", "done"]);
		expect(deps.progress.mock.calls[0][0]).toMatchObject({
			intentId: "qd_1",
		});
	});

	it("skips the naming stage when the name is already settled", async () => {
		const deps = makeDeps();
		await runQuickDispatch({ ...intent, typedName: "fix-x" }, deps as never);
		expect(reportedStages(deps)).toEqual(["spawning", "done"]);
		expect(deps.readRepoBranchState).not.toHaveBeenCalled();
	});

	it("treats branches and worktrees the repository still holds as taken names", async () => {
		const deps = makeDeps();
		deps.readState = () => ({
			projects: [project],
			agents: [{ id: "a1", projectId: "p1", name: "fix" } as never],
			accounts: [],
		});
		deps.readRepoBranchState.mockResolvedValue({
			branches: [
				{ name: "main" },
				{ name: "agent/fix-2", checkedOutAt: "/repo/p/.worktrees/fix-2" },
				{ name: "agent/fix-3" },
			],
			worktrees: [
				{ path: "/repo/p", branch: "main", isMain: true },
				{ path: "/repo/p/.worktrees/fix-2", branch: "agent/fix-2", isMain: false },
				{ path: "/repo/p/.worktrees/fix-4", branch: "codex/other", isMain: false },
			],
		});
		await runQuickDispatch(intent, deps as never);
		expect(deps.readRepoBranchState).toHaveBeenCalledWith(project);
		const takenNames = ["fix", "fix-2", "fix-3", "fix-4"];
		expect(deps.deterministicName).toHaveBeenCalledWith(
			expect.objectContaining({ takenNames }),
		);
		expect(deps.suggestName).toHaveBeenCalledWith(
			expect.objectContaining({ takenNames }),
		);
	});

	it("reports failed when the canonical run rejects", async () => {
		const deps = makeDeps();
		deps.runCanonical.mockRejectedValue(new Error("boom"));
		await runQuickDispatch(intent, deps as never);
		const stages = reportedStages(deps);
		expect(stages[stages.length - 1]).toBe("failed");
	});

	it("spawns without waiting for the AI name suggestion", async () => {
		// Red on the awaited tree: the LLM naming call (2-6s through a cold
		// provider CLI) ran to completion before the spawn even started.
		const deps = makeDeps();
		deps.suggestName.mockReturnValue(new Promise<string>(() => {}));
		await runQuickDispatch(intent, deps as never);
		expect(deps.deterministicName).toHaveBeenCalledTimes(1);
		expect(deps.runCanonical).toHaveBeenCalledTimes(1);
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
	});

	it("adopts the AI suggestion as the display name after the spawn", async () => {
		const deps = makeDeps();
		deps.suggestName.mockResolvedValue("prettier-name");
		deps.runCanonical.mockResolvedValue({
			run: { agentId: "agent-9" },
			disposition: "pane",
		});
		await runQuickDispatch(intent, deps as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deps.renameDisplayName).toHaveBeenCalledWith(
			"agent-9",
			"prettier-name",
		);
	});

	it("launches a Korean prompt before naming completes and only renames its display title", async () => {
		const deps = makeDeps();
		deps.deterministicName.mockReturnValue("codex-1");
		let suggestName!: (name: string) => void;
		deps.suggestName.mockReturnValue(new Promise<string>((resolve) => {
			suggestName = resolve;
		}));
		deps.runCanonical.mockResolvedValue({
			run: { agentId: "agent-9" },
			disposition: "pane",
		});

		const run = runQuickDispatch(
			{
				...intent,
				providerId: "codex",
				promptText: "코드 구조 정리하고 재사용성 높이기",
			},
			deps as never,
		);
		try {
			await vi.waitFor(() => expect(deps.complete).toHaveBeenCalledWith("qd_1"));
			expect(deps.renameDisplayName).not.toHaveBeenCalled();
		} finally {
			suggestName("provider-thread-title");
			await run;
		}
		await vi.waitFor(() => expect(deps.renameDisplayName).toHaveBeenCalledWith(
			"agent-9", "provider-thread-title",
		));

		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.agentName).toBe("codex-1");
		expect(call.worktreePlan).toMatchObject({
			branch: "agent/codex-1",
			worktreePath: "/repo/p/.worktrees/codex-1",
		});
		expect(deps.pin).toHaveBeenCalledWith(intent.intentId, expect.objectContaining({
			resolvedName: "codex-1",
		}));
		expect(reportedStages(deps)).toEqual(["spawning", "done"]);
	});

	it("keeps the deterministic fallback when non-ASCII naming fails", async () => {
		const deps = makeDeps();
		deps.deterministicName.mockReturnValue("codex-1");
		deps.suggestName.mockRejectedValue(new Error("naming unavailable"));

		await runQuickDispatch(
			{
				...intent,
				providerId: "codex",
				promptText: "코드 정리",
			},
			deps as never,
		);

		expect(deps.runCanonical).toHaveBeenCalledWith(
			expect.objectContaining({ agentName: "codex-1" }),
			expect.anything(),
		);
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
		expect(deps.fail).not.toHaveBeenCalled();
	});

	it("never asks for a suggestion when the user typed the name", async () => {
		const deps = makeDeps();
		await runQuickDispatch({ ...intent, typedName: "fix-x" }, deps as never);
		expect(deps.suggestName).not.toHaveBeenCalled();
		expect(deps.renameDisplayName).not.toHaveBeenCalled();
	});

	it("retries a same-intent failure a bounded number of times, then fails visibly", async () => {
		// Red on the silent-return tree: a permanently failing spawn left the
		// intent pending forever and the overlay row spinning for tens of
		// minutes (2026-08-31 claude host outage).
		const deps = makeDeps();
		deps.runCanonical.mockRejectedValue(
			Object.assign(new Error("structured_launch failed"), {
				code: "agent_run_stage_failed",
				details: {
					retry: "same_intent",
					errorCode: "claude_conversation_host_attach_failed",
				},
			}),
		);

		await runQuickDispatch(intent, deps as never);

		expect(deps.runCanonical).toHaveBeenCalledTimes(3);
		expect(deps.delay).toHaveBeenCalledTimes(2);
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.fail).toHaveBeenCalledWith("qd_1", {
			code: "claude_conversation_host_attach_failed",
			message: "structured_launch failed",
			atMs: 42,
		});
		expect(reportedStages(deps)).toEqual(["spawning", "failed"]);
	});

	it("recovers when a same-intent retry succeeds", async () => {
		const deps = makeDeps();
		deps.runCanonical
			.mockRejectedValueOnce(
				Object.assign(new Error("agent_run_outcome_unknown"), {
					details: { retry: "same_intent" },
				}),
			)
			.mockResolvedValueOnce({});

		await runQuickDispatch(intent, deps as never);

		expect(deps.runCanonical).toHaveBeenCalledTimes(2);
		expect(deps.fail).not.toHaveBeenCalled();
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
		expect(reportedStages(deps)).toEqual(["spawning", "done"]);
	});

	it("a throwing progress reporter never fails the dispatch", async () => {
		const deps = makeDeps();
		deps.progress.mockImplementation(() => {
			throw new Error("listener exploded");
		});
		await runQuickDispatch(intent, deps as never);
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
		expect(deps.fail).not.toHaveBeenCalled();
	});

	it("passes the resolved pane target so the spawned agent's pane opens", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		expect(deps.runCanonical).toHaveBeenCalledWith(expect.anything(), {
			spaceId: "space-1",
			windowLabel: "main",
		});
	});

	it("passes a null pane target through when no space is resolvable", async () => {
		const deps = makeDeps();
		deps.resolvePaneTarget.mockReturnValue(null as never);
		await runQuickDispatch(intent, deps as never);
		expect(deps.runCanonical).toHaveBeenCalledWith(expect.anything(), null);
	});

	it("assembles a canonical background run from the intent", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		expect(deps.runCanonical).toHaveBeenCalledWith(
			expect.objectContaining({
				project,
				agentName: "fix-sidebar-flicker",
				provider: "claude",
				model: "opus",
				effort: "xhigh",
				accountId: null,
				actionId: "qd_1",
				useWorktree: true,
				worktreePlan: expect.objectContaining({
					branch: "agent/fix-sidebar-flicker",
					action: "create-new-branch",
					baseRef: baseSha,
				}),
				prompt: expect.stringContaining("/att/1.png"),
			}),
			expect.anything(),
		);
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
		expect(deps.fail).not.toHaveBeenCalled();
	});

	/** Every dispatch lands in a terminal now (owner decision 2026-09-01), so
	 *  the setup probe that used to be skipped for chat-eligible providers runs
	 *  for them too — a fresh worktree needs its install either way, and the
	 *  terminal is where the user can watch it. */
	it("probes setup for a structured provider as well", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(deps.probeSetup).toHaveBeenCalled();
		expect(call.setupCommand).toContain("pnpm install");
	});

	it("basic mode pins the PTY surface and probes setup like a native provider", async () => {
		const deps = makeDeps();
		deps.readState = () => ({
			projects: [project],
			agents: [],
			accounts: [],
			uiPrefs: { interfaceMode: "basic" },
		});
		await runQuickDispatch(intent, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.interactionPreference).toBe("native_cli");
		expect(deps.probeSetup).toHaveBeenCalled();
		expect(call.setupCommand).toContain("pnpm install");
	});

	/** Pro used to leave the surface to the provider default; every dispatch
	 *  now lands in a terminal (owner decision 2026-09-01). */
	it("pro mode pins the PTY surface too", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.interactionPreference).toBe("native_cli");
	});

	it("keeps the probed setup command for a native-only provider", async () => {
		const deps = makeDeps();
		await runQuickDispatch({ ...intent, providerId: "kimi" }, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.setupCommand).toContain("pnpm install");
		expect(call.setupCommand).toContain(".node-version");
	});

	it("assembles an input that satisfies supportsCanonicalAddAgentRun", async () => {
		const deps = makeDeps();
		await runQuickDispatch(intent, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(supportsCanonicalAddAgentRun(call)).toBe(true);
	});

	it("resolves the journaled credential into the canonical spawn", async () => {
		const deps = makeDeps();
		deps.readState = () => ({
			projects: [project],
			agents: [],
			accounts: [codexWork],
		});
		await runQuickDispatch(
			{
				...intent,
				providerId: "codex",
				accountId: codexWork.id,
			},
			deps as never,
		);
		expect(deps.runCanonical).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "codex",
				accountId: codexWork.id,
				account: codexWork,
			}),
			expect.anything(),
		);
	});

	it("fails closed when the journaled credential is no longer available", async () => {
		const deps = makeDeps();
		deps.readState = () => ({ projects: [project], agents: [], accounts: [] });
		await runQuickDispatch(
			{
				...intent,
				providerId: "codex",
				accountId: codexWork.id,
			},
			deps as never,
		);
		expect(deps.runCanonical).not.toHaveBeenCalled();
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({
				code: "agent_launch_credential_unavailable",
			}),
		);
	});

	it("rejects a profile that the canonical backend cannot launch", async () => {
		const deps = makeDeps();
		const kimiAccount = {
			...codexWork,
			id: "acc-kimi-work",
			provider: "kimi" as const,
			name: "Kimi work",
		};
		deps.readState = () => ({
			projects: [project],
			agents: [],
			accounts: [kimiAccount],
		});
		await runQuickDispatch(
			{
				...intent,
				providerId: "kimi",
				accountId: kimiAccount.id,
			},
			deps as never,
		);
		expect(deps.suggestName).not.toHaveBeenCalled();
		expect(deps.runCanonical).not.toHaveBeenCalled();
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({
				code: "quick_dispatch_capability_unavailable",
			}),
		);
	});

	it("fails the intent when the project is gone", async () => {
		const deps = {
			...makeDeps(),
			readState: () => ({ projects: [], agents: [], accounts: [] }),
		};
		await runQuickDispatch(intent, deps as never);
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({ code: "quick_dispatch_project_unavailable" }),
		);
	});

	it("fails the intent when the assembled prompt exceeds the byte cap", async () => {
		const deps = makeDeps();
		await runQuickDispatch(
			{ ...intent, promptText: "x".repeat(17 * 1024) },
			deps as never,
		);
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({ code: "quick_dispatch_prompt_too_large" }),
		);
		expect(deps.runCanonical).not.toHaveBeenCalled();
	});

	it("fails on the byte cap when promptText alone fits but attachments push the assembled prompt over", async () => {
		const deps = makeDeps();
		// promptText alone is under the cap...
		const promptText = "x".repeat(16_350);
		expect(new TextEncoder().encode(promptText).length).toBeLessThan(
			MAX_QUICK_DISPATCH_PROMPT_BYTES,
		);
		// ...but the assembled prompt (promptText + one attachment reference
		// line) crosses it — this is the Task 9 handoff case: the cap check
		// must measure the ASSEMBLED prompt, not promptText alone.
		await runQuickDispatch({ ...intent, promptText }, deps as never);
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({ code: "quick_dispatch_prompt_too_large" }),
		);
		expect(deps.runCanonical).not.toHaveBeenCalled();
	});

	it("never rejects — canonical failure marks the intent failed", async () => {
		const deps = makeDeps();
		deps.runCanonical.mockRejectedValue(
			new Error("agent_spawn_idempotency_conflict"),
		);
		await expect(
			runQuickDispatch(intent, deps as never),
		).resolves.toBeUndefined();
		expect(deps.fail).toHaveBeenCalled();
	});

	it("never rejects even when journaling the failure itself throws", async () => {
		const deps = makeDeps();
		deps.runCanonical.mockRejectedValue(new Error("boom"));
		deps.fail.mockImplementation(() => {
			throw new Error("quick_dispatch_intent_storage_unavailable");
		});
		await expect(
			runQuickDispatch(intent, deps as never),
		).resolves.toBeUndefined();
	});

	// F2: journal the resolution pin before the destructive boundary so a
	// crash-resumed intent converges on the same immutable request instead of
	// re-deriving (and possibly double-spawning under) a different one.
	it("reuses a pinned name, base sha, and setup decision on resume", async () => {
		const deps = makeDeps();
		const pinnedSha = "a".repeat(40);
		await runQuickDispatch(
			{
				...intent,
				resolvedName: "already-named",
				resolvedBaseSha: pinnedSha,
				resolvedSetupCommand: null,
			},
			deps as never,
		);
		expect(deps.suggestName).not.toHaveBeenCalled();
		expect(deps.resolveBaseRef).not.toHaveBeenCalled();
		expect(deps.resolveBaseRefSha).not.toHaveBeenCalled();
		expect(deps.probeSetup).not.toHaveBeenCalled();
		expect(deps.pin).toHaveBeenCalledWith("qd_1", {
			resolvedName: "already-named",
			resolvedBaseSha: pinnedSha,
			resolvedSetupCommand: null,
		});
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.agentName).toBe("already-named");
		expect(call.worktreePlan.baseRef).toBe(pinnedSha);
		expect(deps.complete).toHaveBeenCalledWith("qd_1");
	});

	it("pins the newly derived name and resolved base sha for a fresh dispatch", async () => {
		const deps = makeDeps();
		const resolvedSha = "b".repeat(40);
		deps.resolveBaseRefSha.mockResolvedValue(resolvedSha);
		await runQuickDispatch(intent, deps as never);
		expect(deps.pin).toHaveBeenCalledWith("qd_1", {
			resolvedName: "fix-sidebar-flicker",
			resolvedBaseSha: resolvedSha,
			// The probe's answer is pinned as the shell-wrapped command the run
			// will execute, not the bare word it detected.
			resolvedSetupCommand: expect.stringContaining("pnpm install"),
		});
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.worktreePlan.baseRef).toBe(resolvedSha);
	});

	it("falls back from a moving base ref to the exact HEAD commit", async () => {
		const deps = makeDeps();
		const headSha = "c".repeat(40);
		deps.resolveBaseRefSha.mockImplementation(
			async (_project: Project, ref: string) =>
				ref === "HEAD" ? headSha : undefined,
		);
		await runQuickDispatch(intent, deps as never);
		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(deps.resolveBaseRefSha.mock.calls.map(([, ref]) => ref)).toEqual([
			"origin/main",
			"HEAD",
		]);
		expect(call.worktreePlan.baseRef).toBe(headSha);
		expect(deps.pin).toHaveBeenCalledWith("qd_1", {
			resolvedName: "fix-sidebar-flicker",
			resolvedBaseSha: headSha,
			// The probe's answer is pinned as the shell-wrapped command the run
			// will execute, not the bare word it detected.
			resolvedSetupCommand: expect.stringContaining("pnpm install"),
		});
		expect(deps.fail).not.toHaveBeenCalled();
	});

	it("uses the first pinned resolution when another resume wins the race", async () => {
		const deps = makeDeps();
		const winningSha = "d".repeat(40);
		deps.pin.mockReturnValue({
			resolvedName: "winning-name",
			resolvedBaseSha: winningSha,
			resolvedSetupCommand: "echo winning-setup",
		});

		await runQuickDispatch(intent, deps as never);

		const call = deps.runCanonical.mock.calls[0]?.[0];
		expect(call.agentName).toBe("winning-name");
		expect(call.worktreePlan).toMatchObject({
			branch: "agent/winning-name",
			baseRef: winningSha,
		});
		expect(call.setupCommand).toBe("echo winning-setup");
	});

	it("does not spawn when neither the selected ref nor HEAD resolves exactly", async () => {
		const deps = makeDeps();
		deps.resolveBaseRefSha.mockResolvedValue(undefined);

		await runQuickDispatch(intent, deps as never);

		expect(deps.runCanonical).not.toHaveBeenCalled();
		expect(deps.fail).toHaveBeenCalledWith(
			"qd_1",
			expect.objectContaining({
				code: "quick_dispatch_base_commit_unavailable",
			}),
		);
	});

	it("does not spawn when the exact request cannot be pinned durably", async () => {
		const deps = makeDeps();
		deps.pin.mockImplementation(() => {
			throw new Error("quick_dispatch_intent_storage_unavailable");
		});
		await runQuickDispatch(intent, deps as never);
		expect(deps.runCanonical).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.fail).toHaveBeenCalled();
	});
});

describe("resumeInterruptedQuickDispatchIntents", () => {
	beforeEach(() => {
		resetQuickDispatchResumeForTest();
	});

	function makeResumeDeps(intents: readonly QuickDispatchIntentV1[]) {
		return {
			readIntents: () => intents,
			run: vi.fn().mockResolvedValue(undefined),
		};
	}

	it("resumes a pending intent regardless of age", async () => {
		const stale: QuickDispatchIntentV1 = {
			...intent,
			intentId: "qd_stale",
			createdAtMs: 1,
		};
		const deps = makeResumeDeps([stale]);
		await resumeInterruptedQuickDispatchIntents(deps as never);
		expect(deps.run).toHaveBeenCalledWith(stale);
	});

	it("resumes a fresh pending intent by running it", async () => {
		const fresh: QuickDispatchIntentV1 = {
			...intent,
			intentId: "qd_fresh",
			createdAtMs: 2,
		};
		const deps = makeResumeDeps([fresh]);
		await resumeInterruptedQuickDispatchIntents(deps as never);
		expect(deps.run).toHaveBeenCalledWith(fresh);
	});

	it("skips intents that are not pending", async () => {
		const failed: QuickDispatchIntentV1 = {
			...intent,
			intentId: "qd_done",
			state: "failed",
			failure: { code: "quick_dispatch_failed", message: "boom", atMs: 0 },
		};
		const deps = makeResumeDeps([failed]);
		await resumeInterruptedQuickDispatchIntents(deps as never);
		expect(deps.run).not.toHaveBeenCalled();
	});

	it("resumes multiple pending intents sequentially, in order", async () => {
		const first: QuickDispatchIntentV1 = { ...intent, intentId: "qd_a" };
		const second: QuickDispatchIntentV1 = { ...intent, intentId: "qd_b" };
		const order: string[] = [];
		const deps = {
			readIntents: () => [first, second],
			run: vi.fn(async (i: QuickDispatchIntentV1) => {
				order.push(i.intentId);
			}),
		};
		await resumeInterruptedQuickDispatchIntents(deps as never);
		expect(order).toEqual(["qd_a", "qd_b"]);
	});

	it("keeps resuming later intents when an earlier one's run rejects", async () => {
		const first: QuickDispatchIntentV1 = { ...intent, intentId: "qd_a" };
		const second: QuickDispatchIntentV1 = { ...intent, intentId: "qd_b" };
		const seen: string[] = [];
		const deps = {
			readIntents: () => [first, second],
			run: vi.fn(async (i: QuickDispatchIntentV1) => {
				seen.push(i.intentId);
				if (i.intentId === "qd_a") {
					throw new Error("agent_spawn_idempotency_conflict");
				}
			}),
		};
		await expect(
			resumeInterruptedQuickDispatchIntents(deps as never),
		).resolves.toBeUndefined();
		expect(seen).toEqual(["qd_a", "qd_b"]);
	});

	// F1 (Critical): React.StrictMode double-invokes the boot effect that
	// calls this function. Without a once-per-boot guard, two concurrent
	// resumes would each derive their own AI name for the same intent,
	// producing two different idempotency keys and a double spawn.
	it("runs at most once per boot even when called twice concurrently", async () => {
		const fresh: QuickDispatchIntentV1 = {
			...intent,
			intentId: "qd_once",
			createdAtMs: 2,
		};
		const deps = makeResumeDeps([fresh]);
		await Promise.all([
			resumeInterruptedQuickDispatchIntents(deps as never),
			resumeInterruptedQuickDispatchIntents(deps as never),
		]);
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(deps.run).toHaveBeenCalledWith(fresh);
	});

	it("runs at most once per boot across sequential calls too", async () => {
		const fresh: QuickDispatchIntentV1 = {
			...intent,
			intentId: "qd_once_sequential",
			createdAtMs: 3,
		};
		const deps = makeResumeDeps([fresh]);
		await resumeInterruptedQuickDispatchIntents(deps as never);
		await resumeInterruptedQuickDispatchIntents(deps as never);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
});


describe("SSH dispatch pipeline", () => {
 const host = { id: "host-a", name: "Build", host: "build.test", user: "dev", port: 22, auth: "auto" as const };
 const remote = { ...project, kind: "ssh" as const, sshHostId: host.id };
 const remoteTarget = { hostId: host.id, path: remote.path, host: host.host, user: host.user, port: host.port, registrationGeneration: null, sshConfigAlias: null };
 it.each([false, true])("dispatches on SSH with all choices (worktree=%s)", async (useWorktree) => {
  const deps = makeDeps();
  deps.readState = () => ({ projects: [remote], agents: [], accounts: [codexWork], sshHosts: [host] });
  await runQuickDispatch({ ...intent, providerId: "codex", accountId: codexWork.id, permissionOverride: "auto_edit", useWorktree, remoteTarget }, deps as never);
  expect(deps.fail).not.toHaveBeenCalled();
  expect(deps.runCanonical).not.toHaveBeenCalled();
  expect(deps.runRemote).toHaveBeenCalledWith(expect.objectContaining({ project: remote, provider: "codex", model: "opus", effort: "xhigh", accountId: codexWork.id, permissionOverride: "auto_edit", useWorktree, prompt: expect.stringContaining("/att/1.png") }), expect.anything(), remoteTarget);
  expect(deps.suggestName).not.toHaveBeenCalled();
  if (useWorktree) {
   expect(deps.resolveBaseRef).toHaveBeenCalledWith(remote);
   expect(deps.probeSetup).toHaveBeenCalledWith(remote);
  }
  expect(deps.complete).toHaveBeenCalledWith(intent.intentId);
 });
 it("refuses a host change or a missing pinned SSH target", async () => {
  for (const target of [undefined, { ...remoteTarget, host: "other.test" }]) {
   const deps = makeDeps();
   deps.readState = () => ({ projects: [remote], agents: [], accounts: [], sshHosts: [host] });
   await runQuickDispatch({ ...intent, useWorktree: false, remoteTarget: target }, deps as never);
   expect(deps.fail).toHaveBeenCalledWith(intent.intentId, expect.objectContaining({ code: "quick_dispatch_target_changed" }));
   expect(deps.runRemote).not.toHaveBeenCalled();
   expect(deps.runCanonical).not.toHaveBeenCalled();
  }
 });
});

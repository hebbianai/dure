import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalAgentLegacyWriterRefusedError } from "@/lib/agents/agentWriterPartition";
import {
	type CliHmuxStopRuntime,
	handleCliHmuxStop,
	resolveCliHmuxStopTarget,
} from "@/lib/cli/cliHmuxStop";
import type { HmuxManagedStopReceipt } from "@/lib/ipc";
import type { ManagedAgentStopTarget } from "@/lib/sessions/managed/managedAgentStop";
import { useStore } from "@/store";

const target = {
	agent: {
		id: "agent-old",
		name: "dure-orch",
		provider: "codex",
		projectId: "project-1",
		worktreePath: "/repo/.worktrees/dure-orch",
		branch: "agent/dure-orch",
		sessionId: "agent-old",
		sessionKind: "pty",
	},
	binding: {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId: "agent-old",
		workspaceId: "workspace-1",
	},
} satisfies ManagedAgentStopTarget;

function stopReceipt(): HmuxManagedStopReceipt {
	return {
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "stop-1",
		sessionId: "agent-old",
		workspaceId: "workspace-1",
		runnerPrincipal: "local-user",
		runnerInstance: "runner-1",
		channelEpoch: 1,
		hostInstanceId: "host-1",
		terminalEpoch: "terminal-1",
		outcome: "stopped",
		exitReason: "stopped by user",
	};
}

function runtime(
	cleanup: Awaited<ReturnType<CliHmuxStopRuntime["cleanupExited"]>>,
): CliHmuxStopRuntime {
	return {
		claim: vi.fn().mockResolvedValue(true),
		prepare: vi.fn(async (selected) => selected),
		resolve: vi.fn().mockReturnValue({
			target,
			selection: { kind: "agent", agentId: target.agent.id },
		}),
		cleanupExited: vi.fn().mockResolvedValue(cleanup),
		reconcile: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue({ target, receipt: stopReceipt() }),
		finalize: vi.fn().mockResolvedValue(undefined),
	};
}

describe("CLI managed Hmux stop", () => {
	it("cleans an exact exited registration without issuing another stop", async () => {
		const deps = runtime({
			agentId: "agent-old",
			agentName: "dure-orch",
			sessionId: "agent-old",
			workspaceId: "workspace-1",
			outcome: "cleaned",
			sourceState: "retired",
		});

		await expect(
			handleCliHmuxStop({ name: "agent-old" }, "request-1", deps),
		).resolves.toMatchObject({
			ok: true,
			cleanup: { outcome: "cleaned", sourceState: "retired" },
			agent: { id: "agent-old", name: "dure-orch" },
		});
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).not.toHaveBeenCalled();
	});

	it("keeps the live provider stop and finalize path unchanged", async () => {
		const deps = runtime(undefined);

		await expect(
			handleCliHmuxStop({ name: "agent-old" }, "request-2", deps),
		).resolves.toMatchObject({
			ok: true,
			stop: { outcome: "stopped" },
		});
		expect(deps.stop).toHaveBeenCalledWith(target);
		expect(deps.finalize).toHaveBeenCalledWith(target, stopReceipt());
	});

	it("fails closed when the exited generation changed", async () => {
		const deps = runtime({
			agentId: "agent-old",
			agentName: "dure-orch",
			sessionId: "agent-old",
			workspaceId: "workspace-1",
			outcome: "skipped",
			reason: "generation_changed",
		});

		await expect(
			handleCliHmuxStop({ name: "agent-old" }, "request-3", deps),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: "managed_agent_cleanup_failed",
				message: "exited managed agent cleanup refused: generation_changed",
			},
		});
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("stops before legacy effects when target resolution refuses an Agent", async () => {
		const deps = runtime(undefined);
		vi.mocked(deps.resolve).mockImplementation(() => {
			throw new CanonicalAgentLegacyWriterRefusedError("agent-old");
		});

		await expect(
			handleCliHmuxStop({ name: "agent-old" }, "request-4", deps),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "canonical_agent_legacy_writer_refused" },
		});
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).not.toHaveBeenCalled();
	});

	it("returns the cleanup owner's refusal without another provider stop", async () => {
		const cleanup = {
			agentId: "agent-old",
			agentName: "dure-orch",
			sessionId: "agent-old",
			workspaceId: "workspace-1",
			outcome: "skipped",
			reason: "retire_refused",
			hmuxReason: "recovery_pending",
			message: "source is referenced by a pending recovery",
		} as const;
		const deps = runtime(cleanup);
		await expect(
			handleCliHmuxStop({ name: "agent-old" }, "refusal-details", deps),
		).resolves.toMatchObject({
			ok: false,
			cleanup,
			error: { code: "managed_agent_cleanup_failed", message: cleanup.message },
		});
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).not.toHaveBeenCalled();
	});
});

describe("CLI stop target compatibility", () => {
	beforeEach(() => {
		useStore.setState({
			agents: [{ ...target.agent, runtimeBinding: target.binding }],
			projects: [],
			layouts: {},
		});
	});

	function registeredRuntime() {
		return { ...runtime(undefined), resolve: resolveCliHmuxStopTarget };
	}

	const agentReceipt = {
		id: "agent-old",
		name: "dure-orch",
		sessionId: "agent-old",
		workspaceId: "workspace-1",
		panelId: "agent:agent-old",
	};

	it.each([undefined, "", "agent:agent-old", " agent:agent-old "])(
		"preserves the public receipt for the legacy pane hint %s without a mounted pane",
		async (targetPanelId) => {
			const deps = registeredRuntime();
			const result = await handleCliHmuxStop(
				{ name: "dure-orch", targetPanelId },
				"compatibility-request",
				deps,
			);
			expect(result).toMatchObject({ ok: true, stop: stopReceipt() });
			expect(result?.agent).toEqual(agentReceipt);
			expect(deps.stop).toHaveBeenCalledOnce();
			expect(deps.finalize).toHaveBeenCalledOnce();
			expect(vi.mocked(deps.stop).mock.calls[0][0]).not.toHaveProperty(
				"panelId",
			);
			expect(vi.mocked(deps.finalize).mock.calls[0][0]).not.toHaveProperty(
				"panelId",
			);
		},
	);

	it.each(["agent:other"])(
		"preserves the explicit pane constraint %s before any lifecycle effect",
		async (targetPanelId) => {
			const deps = registeredRuntime();
			const result = await handleCliHmuxStop(
				{ name: "dure-orch", targetPanelId },
				"wrong-pane-request",
				deps,
			);
			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "pane_changed",
					message: "selected pane references a different Agent",
				},
			});
			expect(result).not.toHaveProperty("agent");
			expect(deps.claim).toHaveBeenCalledOnce();
			expect(deps.cleanupExited).not.toHaveBeenCalled();
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.finalize).not.toHaveBeenCalled();
		},
	);

	it.each([
		["agent:other", "pane_changed"],
		["agent:agent-old", "canonical_agent_legacy_writer_refused"],
	])(
		"preserves pane/writer refusal precedence for %s",
		async (targetPanelId, code) => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					canonicalSpawn: {
						schemaVersion: 1,
						backendProfileId: "local",
						operationId: "canonical-spawn",
					},
				})),
			}));
			const deps = registeredRuntime();
			await expect(
				handleCliHmuxStop(
					{ name: "dure-orch", targetPanelId },
					"writer-refusal",
					deps,
				),
			).resolves.toMatchObject({ ok: false, error: { code } });
			expect(deps.cleanupExited).not.toHaveBeenCalled();
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.finalize).not.toHaveBeenCalled();
		},
	);

	it("still requires a runtime binding after an accepted pane hint", async () => {
		useStore.setState({ agents: [target.agent] });
		const deps = registeredRuntime();
		await expect(
			handleCliHmuxStop(
				{ name: "dure-orch", targetPanelId: "agent:agent-old" },
				"unbound-request",
				deps,
			),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("does not execute a request claimed by another caller", async () => {
		const deps = registeredRuntime();
		vi.mocked(deps.claim).mockResolvedValue(false);
		await expect(
			handleCliHmuxStop({ name: "dure-orch" }, "already-claimed", deps),
		).resolves.toBeNull();
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).not.toHaveBeenCalled();
	});

	it.each(["prepare", "cleanupExited", "stop", "finalize"] as const)(
		"preserves target metadata when %s fails after selection",
		async (phase) => {
			const deps = registeredRuntime();
			vi.mocked(deps[phase]).mockRejectedValue(new Error("fixture failure"));
			const result = await handleCliHmuxStop(
				{ name: "dure-orch" },
				`failure-${phase}`,
				deps,
			);
			expect(result).toMatchObject({
				ok: false,
				error: {
					code:
						phase === "finalize"
							? "managed_agent_cleanup_failed"
							: "hmux_managed_stop_failed",
				},
			});
			expect(result?.agent).toEqual(agentReceipt);
			if (phase === "finalize") {
				expect(result).toMatchObject({ stop: stopReceipt() });
			} else {
				expect(result).not.toHaveProperty("stop");
				expect(deps.finalize).not.toHaveBeenCalled();
			}
		},
	);

	it("keeps the selected receipt when the Agent projection changes during stop", async () => {
		const deps = registeredRuntime();
		vi.mocked(deps.stop).mockImplementation(async (selected) => {
			if (!("binding" in selected)) {
				throw new Error("CLI must pass a resolved runtime stop target");
			}
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					name: "replacement-name",
					sessionId: "replacement-session",
					runtimeBinding: {
						...target.binding,
						sessionId: "replacement-session",
					},
				})),
			}));
			return { target: selected, receipt: stopReceipt() };
		});
		const result = await handleCliHmuxStop(
			{ name: "dure-orch" },
			"delayed-stop",
			deps,
		);
		expect(result?.agent).toEqual(agentReceipt);
		expect(vi.mocked(deps.finalize).mock.calls[0][0]).toMatchObject({
			agent: { name: "dure-orch", sessionId: "agent-old" },
			binding: { sessionId: "agent-old" },
		});
	});
});

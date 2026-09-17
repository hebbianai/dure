import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import type { Agent, DeferredCredentialSwitchIntentV1 } from "@/types";

const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	execute: vi.fn(),
	freshSwitch: vi.fn(),
	inspect: vi.fn(),
	inspectInterrupted: vi.fn(),
	message: vi.fn(),
	payload: vi.fn(),
	reconcile: vi.fn(),
	remoteSwitch: vi.fn(),
	synchronize: vi.fn(),
	switchRuntime: vi.fn(),
	changeSettings: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@/lib/sessions/managed/managedAgentRehost", () => ({
	executeManagedAgentCredentialSwitch: mocks.execute,
	inspectInterruptedManagedAgentCredentialSwitch: mocks.inspectInterrupted,
	inspectManagedAgentCredentialSwitch: mocks.inspect,
	managedAgentCredentialSwitchSyncPayload: mocks.payload,
	reconcileManagedAgentRehost: mocks.reconcile,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostSynchronization", () => ({
	MANAGED_AGENT_REHOSTED_EVENT: "agent:managed-rehosted:v2",
	commitReconciledManagedAgentRehostReceipt: mocks.synchronize,
	commitManagedAgentRehostReceipt: mocks.synchronize,
}));
vi.mock("@/lib/sessions/managed/managedAgentFreshStart", () => ({
	switchFreshManagedAgentCredential: mocks.freshSwitch,
}));
vi.mock("@/lib/sessions/credentials/remoteManagedCredentialSwitch", () => ({
	requestRemoteManagedCredentialSwitch: mocks.remoteSwitch,
}));

vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	switchAgentRuntimeCredential: mocks.switchRuntime,
	transitionAgentRuntime: mocks.changeSettings,
}));

import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { normalizeDeferredCredentialSwitchIntent } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import {
	applyDeferredCredentialSwitchNow,
	cancelDeferredCredentialSwitch,
	installDeferredCredentialSwitchWatch,
	requestManagedCredentialSwitch,
	scheduleBusyAgentCredentialSwitch,
} from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { getManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

function agent(): Agent {
	return agentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-old",
		conversationId: "conversation-1",
		credentialId: "account-default",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-old",
			credentialId: "account-default",
		}),
		started: true,
	});
}

function runtime(
	patch: Partial<HmuxAgentRuntimeState> = {},
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-old",
		revision: "12",
		observedThroughOutputSeq: "20",
		lifecycle: "running",
		activity: "working",
		attention: "none",
		source: "provider_event",
		turnCompletedCount: "7",
		...patch,
	};
}

/** Quiescent pane whose idle evidence came from orchestration authority. */
function orchestrationIdle(patch: Partial<HmuxAgentRuntimeState> = {}) {
	return runtime({
		revision: "13",
		activity: "waiting",
		attention: "none",
		source: "orchestration_event",
		...patch,
	});
}

/** Idle pane whose completed-turn counter advanced from 7 to 8. */
function turnCompletedIdle(revision: string) {
	return runtime({ revision, activity: "waiting", turnCompletedCount: "8" });
}

const account = {
	id: "account-crispy",
	provider: "codex" as const,
	name: "crispy",
	dir: "/profiles/codex-crispy",
};

const inspection = {
	agentId: "agent-managed",
	agentName: "codex-1",
	projectId: "project-1",
	providerId: "codex" as const,
	sourceBinding: managedBindingFixture({
		sessionId: "session-old",
		credentialId: "account-default",
	}),
	sourceCredentialId: "account-default",
	sourceConversationId: "conversation-1",
	targetCredentialId: "account-crispy",
	targetAccount: account,
	conversationId: "conversation-1",
	cwd: "/repo/worktree",
	desktopId: "desktop-1",
	panelId: "agent:agent-managed",
	permissionMode: "default" as const,
	terminalEnvironment: {},
};

function reconcileToSuccessor(
	credentialId: string,
	onReconcile?: () => void,
	onSynchronize?: () => void,
) {
	const successorBinding = {
		...inspection.sourceBinding,
		sessionId: "session-new",
		createIdempotencyKey: "create-new",
		credentialId,
	};
	mocks.reconcile.mockImplementationOnce(async () => {
		onReconcile?.();
		return {
			recovery: { conversationId: "conversation-1", credentialId },
			payload: {
				agentId: "agent-managed",
				sourceBinding: inspection.sourceBinding,
				binding: successorBinding,
			},
			replacement: {
				sessionId: "session-new",
				workspaceId: successorBinding.workspaceId,
			},
			conversationId: "conversation-1",
		};
	});
	mocks.synchronize.mockImplementationOnce(async (value) => {
		onSynchronize?.();
		useStore.setState((state) => ({
			agents: state.agents.map((candidate) =>
				candidate.id === "agent-managed"
					? {
							...candidate,
							sessionId: "session-new",
							credentialId,
							runtimeBinding: successorBinding,
						}
					: candidate,
			),
		}));
		return {
			pane: { panelId: "agent:agent-managed" },
			payload:
				value && typeof value === "object" && "payload" in value
					? value.payload
					: value,
		};
	});
	return successorBinding;
}

const uninstallers: Array<() => void> = [];

function installWatch(): () => void {
	const uninstall = installDeferredCredentialSwitchWatch();
	uninstallers.push(uninstall);
	return uninstall;
}

function requestSwitch() {
	return requestManagedCredentialSwitch(
		"agent-managed",
		"account-crispy",
		"agent:agent-managed",
	);
}

async function expectSwitchCompleted(conversationId: string | null) {
	await expect(requestSwitch()).resolves.toEqual({
		kind: "completed",
		conversationId,
	});
}

async function expectSwitchScheduled() {
	await expect(requestSwitch()).resolves.toMatchObject({ kind: "scheduled" });
}

function pendingSwitch() {
	return useStore.getState().agents[0].pendingCredentialSwitch;
}

function patchPendingSwitch(patch: Partial<DeferredCredentialSwitchIntentV1>) {
	useStore.setState((state) => ({
		agents: state.agents.map((candidate) => ({
			...candidate,
			pendingCredentialSwitch: candidate.pendingCredentialSwitch
				? { ...candidate.pendingCredentialSwitch, ...patch }
				: undefined,
		})),
	}));
}

/** Replace the whole runtime projection map, as a boot/seed step would. */
function seedSessionRuntime(
	state: HmuxAgentRuntimeState,
	sessionId = "session-old",
) {
	useStore.setState({ sessionAgentRuntimeState: { [sessionId]: state } });
}

/** Deliver a runtime update through the store action, as the Host feed does. */
function pushSessionRuntime(state: HmuxAgentRuntimeState) {
	useStore.getState().setSessionAgentRuntimeState("session-old", state);
}

function awaitExecuted(times = 1) {
	return vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(times));
}

function flushTasks() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.restoreAllMocks();
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.inspect.mockResolvedValue(inspection);
	mocks.inspectInterrupted.mockResolvedValue(inspection);
	mocks.execute.mockResolvedValue({ stop: {}, recovery: {} });
	mocks.freshSwitch.mockResolvedValue({
		panelId: "agent:agent-managed",
		sessionId: "session-fresh",
	});
	mocks.payload.mockReturnValue({ schemaVersion: 1, agentId: "agent-managed" });
	mocks.synchronize.mockImplementation(async (payload) => ({
		pane: { panelId: "agent:agent-managed" },
		payload,
	}));
	mocks.emit.mockResolvedValue(undefined);
	mocks.message.mockResolvedValue(undefined);
	mocks.reconcile.mockResolvedValue(null);
	mocks.remoteSwitch.mockResolvedValue({
		conversationId: "conversation-remote",
	});
	useStore.setState({
		agents: [agent()],
		accounts: [account],
		agentActivity: { "agent-managed": "working" },
		sessionAgentRuntimeState: { "session-old": runtime() },
	});
	useAgentAttention.setState({ armedCompletions: {} });
});

afterEach(() => {
	for (const uninstall of uninstallers.splice(0)) uninstall();
});

describe("deferred managed credential switch runtime", () => {
	it("retains settings across reload and applies them once after the exact turn ends", async () => {
		const selection = {
			model: "gpt-6-astra",
			effort: "xhigh",
			permissionMode: "skip_permissions" as const,
		};
		await scheduleBusyAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
			7,
			{ selection, conversationId: "conversation-1" },
		);
		const persisted = normalizeDeferredCredentialSwitchIntent(
			JSON.parse(JSON.stringify(pendingSwitch())),
		);
		expect(persisted?.targetLaunchSelection).toEqual(selection);
		useStore.setState({
			agents: [{ ...agent(), pendingCredentialSwitch: persisted }],
		});
		installWatch();
		pushSessionRuntime(
			runtime({
				revision: "13",
				activity: "waiting",
				attention: "approval_required",
			}),
		);
		await flushTasks();
		expect(mocks.changeSettings).not.toHaveBeenCalled();
		mocks.changeSettings.mockResolvedValue({});
		pushSessionRuntime(turnCompletedIdle("14"));
		await vi.waitFor(() => expect(mocks.changeSettings).toHaveBeenCalledOnce());
		expect(mocks.changeSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-managed",
				targetInteractionProfile: "preserve",
				sourceStopPolicy: "preserve",
				expectedSourceRevision: 7,
				expectedConversationId: "conversation-1",
				targetLaunchSelection: selection,
				credentialAction: { targetCredentialId: "account-crispy" },
			}),
		);
		await vi.waitFor(() => expect(pendingSwitch()).toBeUndefined());
		pushSessionRuntime(turnCompletedIdle("15"));
		await flushTasks();
		expect(mocks.changeSettings).toHaveBeenCalledOnce();
		expect(mocks.switchRuntime).not.toHaveBeenCalled();
	});
	it("requires an exact pending request to interrupt and apply settings", async () => {
		const selection = {
			model: "gpt-6-astra",
			effort: "xhigh",
			permissionMode: "skip_permissions" as const,
		};
		await scheduleBusyAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
			7,
			{ selection, conversationId: "conversation-1" },
		);
		await expect(
			applyDeferredCredentialSwitchNow("agent-managed", "old-request"),
		).rejects.toThrow("deferred_credential_switch_cancelled");
		expect(mocks.changeSettings).not.toHaveBeenCalled();
		mocks.changeSettings.mockImplementation(async (request) => {
			request.beforeTransition();
		});
		await applyDeferredCredentialSwitchNow(
			"agent-managed",
			pendingSwitch()?.requestId,
		);
		expect(mocks.changeSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceStopPolicy: "discard",
				expectedSourceRevision: 7,
				expectedConversationId: "conversation-1",
				targetLaunchSelection: selection,
			}),
		);
		expect(pendingSwitch()).toBeUndefined();
	});

	it("retains settings and shows why apply-now cannot start without the Host projection", async () => {
		const selection = {
			model: "gpt-6-astra",
			effort: "xhigh",
			permissionMode: "skip_permissions" as const,
		};
		await scheduleBusyAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
			7,
			{ selection, conversationId: "conversation-1" },
		);
		useStore.setState({ sessionAgentRuntimeState: {} });
		await expect(
			applyDeferredCredentialSwitchNow(
				"agent-managed",
				pendingSwitch()?.requestId,
			),
		).rejects.toThrow("deferred_credential_switch_runtime_unavailable");
		expect(pendingSwitch()).toMatchObject({
			targetLaunchSelection: selection,
			lastError: "deferred_credential_switch_runtime_unavailable",
		});
		expect(mocks.changeSettings).not.toHaveBeenCalled();
	});

	it("does not resurrect a cancelled request after asynchronous inspection", async () => {
		await pickBusyAccount();
		mocks.inspect.mockImplementationOnce(async () => {
			cancelDeferredCredentialSwitch("agent-managed");
			return inspection;
		});
		const selection = {
			model: "gpt-6-astra",
			effort: "xhigh",
			permissionMode: "skip_permissions" as const,
		};
		expect(
			await scheduleBusyAgentCredentialSwitch(
				"agent-managed",
				"account-crispy",
				"agent:agent-managed",
				7,
				{ selection, conversationId: "conversation-1" },
			),
		).toBeNull();
		expect(pendingSwitch()).toBeUndefined();
	});

	it("reconciles a journaled local replacement before source inspection", async () => {
		const callOrder: string[] = [];
		const successorBinding = reconcileToSuccessor(
			"account-default",
			() => callOrder.push("reconcile"),
			() => callOrder.push("synchronize"),
		);
		mocks.inspect.mockImplementationOnce(async () => {
			callOrder.push("inspect");
			const current = useStore
				.getState()
				.agents.find((candidate) => candidate.id === "agent-managed");
			if (current?.sessionId !== "session-new") {
				throw new Error("local_managed_credential_switch_source_changed");
			}
			return { ...inspection, sourceBinding: successorBinding };
		});
		seedSessionRuntime(runtime({ activity: "waiting" }), "session-new");

		await expectSwitchCompleted("conversation-1");

		expect(callOrder).toEqual(["reconcile", "synchronize", "inspect"]);
		expect(mocks.execute).toHaveBeenCalledOnce();
	});

	it("does not replace a recovered generation already using the requested credential", async () => {
		reconcileToSuccessor("account-crispy");

		await expectSwitchCompleted("conversation-1");

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("routes a remote managed generation through the remote journaled switch", async () => {
		useStore.setState({
			agents: [
				{
					...agent(),
					sessionKind: "ssh",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: "host-1",
						sessionId: "session-old",
						workspaceId: "workspace-1",
						createIdempotencyKey: "create-old",
						commandBridgeNonce: "bridge-old",
					},
				},
			],
		});
		mocks.remoteSwitch.mockImplementation(async () => {
			expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(true);
			return { conversationId: "conversation-remote" };
		});

		await expectSwitchCompleted("conversation-remote");
		expect(mocks.remoteSwitch).toHaveBeenCalledWith(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
		);
		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(false);
	});

	it("relaunches an untouched fresh Agent with the selected credential without requiring a conversation id", async () => {
		useStore.setState({
			agents: [{ ...agent(), conversationId: undefined }],
			agentActivity: { "agent-managed": "waiting" },
		});
		seedSessionRuntime(
			runtime({
				activity: "waiting",
				source: "process_lifecycle",
				turnCompletedCount: "0",
			}),
		);
		mocks.freshSwitch.mockImplementation(async () => {
			expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(true);
			return {
				panelId: "agent:agent-managed",
				sessionId: "session-fresh",
			};
		});

		await expectSwitchCompleted(null);
		expect(mocks.freshSwitch).toHaveBeenCalledWith(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
		);
		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(false);
	});

	it("recovers exact identity instead of fresh-starting when an established Agent lost its conversation projection", async () => {
		useStore.setState({
			agents: [{ ...agent(), conversationId: undefined }],
			agentActivity: { "agent-managed": "waiting" },
		});
		seedSessionRuntime(
			runtime({
				activity: "waiting",
				turnCompletedCount: "7",
			}),
		);

		await expectSwitchCompleted("conversation-1");

		expect(mocks.freshSwitch).not.toHaveBeenCalled();
		expect(mocks.inspect).toHaveBeenCalledWith(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
		);
		expect(mocks.execute).toHaveBeenCalledOnce();
	});

	it("keeps the immediate replacement transition active through pane synchronization", async () => {
		useStore.setState({ agentActivity: { "agent-managed": "waiting" } });
		seedSessionRuntime(runtime({ activity: "waiting" }));
		mocks.execute.mockImplementation(async () => {
			expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(true);
			return { stop: {}, recovery: {} };
		});
		mocks.synchronize.mockImplementation(async (payload) => {
			expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(true);
			return { pane: { panelId: "agent:agent-managed" }, payload };
		});

		await requestSwitch();

		expect(mocks.execute).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(false);
	});

	it("schedules an active turn without stopping it and supports cancellation", async () => {
		await expectSwitchScheduled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(pendingSwitch()).toMatchObject({
			targetCredentialId: "account-crispy",
		});

		expect(cancelDeferredCredentialSwitch("agent-managed")).toBe(true);
		expect(pendingSwitch()).toBeUndefined();
	});

	it("switches immediately when only the stale local activity bit says working", async () => {
		seedSessionRuntime(runtime({ activity: "waiting" }));

		await expectSwitchCompleted("conversation-1");
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(pendingSwitch()).toBeUndefined();
	});

	it("still defers while locally-dispatched input awaits the Host echo", async () => {
		seedSessionRuntime(runtime({ activity: "waiting" }));
		useAgentAttention.getState().armCompletion("session-old");

		await expectSwitchScheduled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("recovers a persisted zero-count switch from the mounted Host projection", async () => {
		seedSessionRuntime(runtime({ turnCompletedCount: "0" }));
		await requestSwitch();
		useStore.setState({ sessionAgentRuntimeState: {} });
		installWatch();
		expect(mocks.execute).not.toHaveBeenCalled();
		pushSessionRuntime(orchestrationIdle({ turnCompletedCount: "0" }));
		await awaitExecuted();
		expect(pendingSwitch()).toBeUndefined();
	});

	it("switches after provider interruption without incrementing completed turns", async () => {
		await expectSwitchScheduled();
		installWatch();
		useAgentAttention.getState().armCompletion("session-old");
		pushSessionRuntime(runtime({ revision: "13", activity: "waiting" }));
		await awaitExecuted();
		expect(pendingSwitch()).toBeUndefined();
	});

	it.each(["working", "waiting"] as const)(
		"does not stop a silent controller %s state, even after restoring an old checkpoint",
		async (activity) => {
			vi.useFakeTimers();
			try {
				await requestSwitch();
				seedSessionRuntime(
					runtime({ revision: "13", source: "controller_input", activity }),
				);
				patchPendingSwitch({
					completionRuntimeRevision: "13",
					completionTurnCompletedCount: "7",
				});
				const uninstall = installWatch();
				await vi.advanceTimersByTimeAsync(120_000);
				expect(mocks.execute).not.toHaveBeenCalled();
				expect(pendingSwitch()).toBeDefined();
				pushSessionRuntime(orchestrationIdle({ revision: "14" }));
				await vi.advanceTimersByTimeAsync(0);
				expect(mocks.execute).toHaveBeenCalledOnce();
				uninstall();
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("never steals pane focus for an unattended switch", async () => {
		await requestSwitch();
		const idle = orchestrationIdle();
		seedSessionRuntime(idle);
		installWatch();

		await vi.waitFor(() => expect(mocks.synchronize).toHaveBeenCalledTimes(1));
		expect(mocks.synchronize).toHaveBeenCalledWith(expect.anything(), {
			activate: false,
		});
	});

	it("keeps activating the pane the user explicitly applied", async () => {
		await requestSwitch();

		await applyDeferredCredentialSwitchNow("agent-managed");

		expect(mocks.synchronize).toHaveBeenCalledTimes(1);
		expect(mocks.synchronize.mock.calls[0][1]).not.toEqual({ activate: false });
	});

	it("applies a scheduled switch immediately after explicit user authorization", async () => {
		mocks.execute.mockImplementation(
			async (_inspection: unknown, options: { beforeStop: () => void }) => {
				expect(pendingSwitch()).toMatchObject({
					completionReason: "user_requested",
				});
				options.beforeStop();
				return { stop: {}, recovery: {} };
			},
		);
		await requestSwitch();

		await applyDeferredCredentialSwitchNow("agent-managed");

		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ beforeStop: expect.any(Function) }),
		);
		expect(pendingSwitch()).toBeUndefined();
	});

	it("resumes a persisted apply-now command after reload", async () => {
		await requestSwitch();
		patchPendingSwitch({
			completionRuntimeRevision: "12",
			completionTurnCompletedCount: "7",
			completionReason: "user_requested",
		});
		installWatch();

		await awaitExecuted();
	});

	it("waits for attention to clear instead of issuing a stop the Host rejects", async () => {
		await requestSwitch();
		useAgentAttention.getState().armCompletion("session-old");
		const providerError = runtime({
			revision: "13",
			activity: "waiting",
			attention: "error",
			source: "provider_event",
		});
		seedSessionRuntime(providerError);
		installWatch();

		await flushTasks();
		expect(mocks.execute).not.toHaveBeenCalled();
		pushSessionRuntime(runtime({ revision: "14", activity: "waiting" }));
		await awaitExecuted();
		expect(pendingSwitch()).toBeUndefined();
	});

	it("executes once when the persisted Host counter advances", async () => {
		await requestSwitch();
		installWatch();
		useStore.getState().setAgentActivity("agent-managed", "waiting");
		pushSessionRuntime(turnCompletedIdle("13"));

		await awaitExecuted();
		await vi.waitFor(() => expect(pendingSwitch()).toBeUndefined());
		pushSessionRuntime(turnCompletedIdle("14"));
		await flushTasks();
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});

	it("consumes a completion after the pending input arm catches up", async () => {
		await requestSwitch();
		useAgentAttention.getState().armCompletion("session-old");
		installWatch();
		pushSessionRuntime(turnCompletedIdle("13"));

		await vi.waitFor(() =>
			expect(pendingSwitch()).toMatchObject({
				completionRuntimeRevision: "13",
				completionTurnCompletedCount: "8",
			}),
		);
		expect(mocks.execute).not.toHaveBeenCalled();

		useAgentAttention.setState({ armedCompletions: {} });

		await awaitExecuted();
		expect(useStore.getState().agentActivity["agent-managed"]).toBe("working");
	});

	it("waits for real idle after a completion that remains working", async () => {
		await requestSwitch();
		installWatch();
		pushSessionRuntime(runtime({ revision: "13", turnCompletedCount: "8" }));

		await flushTasks();
		expect(mocks.execute).not.toHaveBeenCalled();
		pushSessionRuntime(turnCompletedIdle("14"));
		await awaitExecuted();
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ beforeStop: expect.any(Function) }),
		);
	});

	it("resumes a persisted completion checkpoint after a main-window reload", async () => {
		await requestSwitch();
		patchPendingSwitch({
			completionRuntimeRevision: "13",
			completionTurnCompletedCount: "8",
		});
		seedSessionRuntime(turnCompletedIdle("13"));
		installWatch();

		await awaitExecuted();
	});

	it("moves the baseline forward when another turn starts first", async () => {
		await requestSwitch();
		installWatch();
		useStore.getState().setAgentActivity("agent-managed", "waiting");
		pushSessionRuntime(turnCompletedIdle("13"));
		pushSessionRuntime(runtime({ revision: "14", turnCompletedCount: "8" }));
		await vi.waitFor(() =>
			expect(pendingSwitch()).toMatchObject({
				baselineTurnCompletedCount: "8",
			}),
		);
		expect(mocks.execute).not.toHaveBeenCalled();

		pushSessionRuntime(
			runtime({ revision: "15", activity: "waiting", turnCompletedCount: "9" }),
		);
		await awaitExecuted();
	});

	it("restores a persisted intent and refuses stale replacement inputs", async () => {
		await requestSwitch();
		useStore.setState({
			accounts: [{ ...account, dir: "/profiles/replaced" }],
		});
		installWatch();

		await vi.waitFor(() =>
			expect(pendingSwitch()?.lastError).toContain("target_credential_changed"),
		);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.message).not.toHaveBeenCalled();
	});

	it("keeps a failed intent actionable and does not spin on duplicate events", async () => {
		mocks.execute.mockRejectedValue(new Error("fault injection: preflight"));
		await requestSwitch();
		installWatch();
		useStore.getState().setAgentActivity("agent-managed", "waiting");
		pushSessionRuntime(turnCompletedIdle("13"));

		await vi.waitFor(() =>
			expect(pendingSwitch()?.lastError).toBe(
				"deferred_credential_switch_failed",
			),
		);
		useStore.setState((state) => ({ accounts: [...state.accounts] }));
		await flushTasks();
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.message).not.toHaveBeenCalled();
	});

	it("replays one interrupted exact switch after the source has exited", async () => {
		await requestSwitch();
		patchPendingSwitch({
			completionRuntimeRevision: "13",
			completionTurnCompletedCount: "8",
			completionReason: "user_requested",
			lastError: "deferred_credential_switch_failed",
		});
		seedSessionRuntime(
			runtime({
				revision: "13",
				turnCompletedCount: "8",
				lifecycle: "exited",
				activity: "waiting",
			}),
		);
		mocks.inspect.mockRejectedValue(new Error("source exited"));
		installWatch();

		await awaitExecuted();
		expect(mocks.inspectInterrupted).toHaveBeenCalledTimes(1);
		useStore.setState((state) => ({ accounts: [...state.accounts] }));
		await flushTasks();
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});

	it("keeps the exact pending turn when the user retries before completion", async () => {
		await requestSwitch();
		patchPendingSwitch({ lastError: "deferred_credential_switch_failed" });
		seedSessionRuntime(runtime({ activity: "waiting" }));
		useStore.getState().setAgentActivity("agent-managed", "waiting");

		await expectSwitchScheduled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(pendingSwitch()).toMatchObject({ baselineTurnCompletedCount: "7" });
		expect(pendingSwitch()?.lastError).toBeUndefined();
	});
});

function sourceBusy(code = "agent_runtime_source_busy") {
	return new DureAgentRuntimeSourceActiveError(
		new DureBackendRequestError(code, "busy", {
			schemaVersion: 1,
			kind: "invalid",
			code,
			message: "busy",
		} as never),
		7,
	);
}

async function pickBusyAccount() {
	mocks.switchRuntime.mockRejectedValueOnce(sourceBusy());
	return requestAgentCredentialTransition({
		agentId: "agent-managed",
		targetCredentialId: "account-crispy",
		sourcePanelId: "agent:agent-managed",
	});
}

function resolveRevisionedSwitch() {
	mocks.switchRuntime.mockImplementation(async (_agent, _account, options) => {
		options.beforeTransition();
		return { providerConversationRef: "conversation-1" };
	});
}

async function expectRevisionedCompletion() {
	await vi.waitFor(() => expect(pendingSwitch()).toBeUndefined());
	expect(mocks.switchRuntime).toHaveBeenLastCalledWith(
		"agent-managed",
		"account-crispy",
		{
			expectedSourceRevision: 7,
			expectedConversationId: "conversation-1",
			sourceStopPolicy: "preserve",
			beforeTransition: expect.any(Function),
		},
	);
	expect(mocks.execute).not.toHaveBeenCalled();
}

describe("shared account picker with the deferred runtime service", () => {
	it("waits for a new Host revision after a busy refusal without silent retries", async () => {
		await pickBusyAccount();
		mocks.switchRuntime.mockImplementationOnce(async () => {
			expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(true);
			throw sourceBusy();
		});
		installWatch();
		pushSessionRuntime(turnCompletedIdle("13"));
		await vi.waitFor(() =>
			expect(pendingSwitch()?.baselineRuntimeRevision).toBe("13"),
		);
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		expect(getManagedCredentialSwitchTransition("agent-managed")).toBe(false);
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(120_000);
		useStore.setState((state) => ({ accounts: [...state.accounts] }));
		pushSessionRuntime(turnCompletedIdle("13"));
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
		resolveRevisionedSwitch();
		pushSessionRuntime(turnCompletedIdle("14"));
		await expectRevisionedCompletion();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(3);
	});

	it("surfaces a retained-source refusal instead of waiting for another completed turn", async () => {
		await pickBusyAccount();
		const retained = sourceBusy("agent_runtime_source_retained");
		mocks.switchRuntime.mockRejectedValue(retained);
		installWatch();
		pushSessionRuntime(runtime({ revision: "13", activity: "waiting" }));
		await vi.waitFor(() =>
			expect(mocks.switchRuntime).toHaveBeenCalledTimes(2),
		);
		await vi.waitFor(() =>
			expect(pendingSwitch()?.lastError).toBe("agent_runtime_source_retained"),
		);
		pushSessionRuntime(turnCompletedIdle("14"));
		await flushTasks();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		expect(pendingSwitch()?.targetCredentialId).toBe("account-crispy");
		expect(useStore.getState().agents[0].sessionId).toBe("session-old");
	});

	it.each(["working", "approval", "stale-idle"])(
		"retains a %s source until completion, then preserves its revision",
		async (state) => {
			if (state === "approval")
				seedSessionRuntime(
					runtime({ activity: "waiting", attention: "approval_required" }),
				);
			if (state === "stale-idle")
				seedSessionRuntime(runtime({ activity: "waiting" }));
			installWatch();
			await expect(pickBusyAccount()).resolves.toEqual({
				kind: "scheduled",
				conversationId: "conversation-1",
			});
			await flushTasks();
			expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
			expect(mocks.execute).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0]).toMatchObject({
				sessionId: "session-old",
				credentialId: "account-default",
				conversationId: "conversation-1",
			});
			expect(pendingSwitch()).toMatchObject({ sourceSelectionRevision: 7 });
			resolveRevisionedSwitch();
			pushSessionRuntime(turnCompletedIdle("13"));
			await expectRevisionedCompletion();
			pushSessionRuntime(turnCompletedIdle("13"));
			await flushTasks();
			expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		},
	);

	it("cancels a queued account pick without changing the source", async () => {
		installWatch();
		await pickBusyAccount();
		cancelDeferredCredentialSwitch("agent-managed");
		pushSessionRuntime(turnCompletedIdle("13"));
		await flushTasks();
		expect(pendingSwitch()).toBeUndefined();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
	});

	it("restores the source revision after reload and waits for the missing runtime projection", async () => {
		await pickBusyAccount();
		const persisted = normalizeDeferredCredentialSwitchIntent(
			JSON.parse(JSON.stringify(pendingSwitch())),
		);
		useStore.setState({
			agents: [{ ...agent(), pendingCredentialSwitch: persisted }],
			sessionAgentRuntimeState: {},
		});
		installWatch();
		await flushTasks();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
		resolveRevisionedSwitch();
		pushSessionRuntime(turnCompletedIdle("13"));
		await expectRevisionedCompletion();
	});

	it("rechecks cancellation at the revisioned dispatch boundary", async () => {
		await pickBusyAccount();
		let authorize: (() => void) | undefined;
		let finish: (() => void) | undefined;
		mocks.switchRuntime.mockImplementation(
			(_agent, _account, options) =>
				new Promise((resolve, reject) => {
					authorize = options.beforeTransition;
					finish = () => {
						try {
							authorize?.();
							resolve({});
						} catch (error) {
							reject(error);
						}
					};
				}),
		);
		installWatch();
		pushSessionRuntime(turnCompletedIdle("13"));
		await vi.waitFor(() => expect(finish).toBeDefined());
		cancelDeferredCredentialSwitch("agent-managed");
		expect(authorize).toThrow("no longer ready: stale");
		finish?.();
		await flushTasks();
		expect(pendingSwitch()).toBeUndefined();
	});

	it("waits again when the backend sees a new turn before the projection does", async () => {
		await pickBusyAccount();
		mocks.switchRuntime.mockRejectedValueOnce(sourceBusy());
		installWatch();
		pushSessionRuntime(turnCompletedIdle("13"));
		await vi.waitFor(() =>
			expect(pendingSwitch()).toMatchObject({
				baselineTurnCompletedCount: "8",
				lastError: undefined,
			}),
		);
		await flushTasks();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		resolveRevisionedSwitch();
		pushSessionRuntime(runtime({ revision: "14", turnCompletedCount: "8" }));
		await flushTasks();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(2);
		pushSessionRuntime(
			runtime({ revision: "15", turnCompletedCount: "9", activity: "waiting" }),
		);
		await expectRevisionedCompletion();
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(3);
	});

	it("refuses to retarget a new Host generation", async () => {
		await pickBusyAccount();
		installWatch();
		pushSessionRuntime({
			...turnCompletedIdle("13"),
			terminalEpoch: "new-generation",
		});
		await flushTasks();
		expect(pendingSwitch()?.lastError).toBe("source_terminal_epoch_changed");
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
	});

	it("allows discard only for the separately explicit Switch now action", async () => {
		await pickBusyAccount();
		resolveRevisionedSwitch();
		installWatch();
		await applyDeferredCredentialSwitchNow("agent-managed");
		expect(mocks.switchRuntime).toHaveBeenLastCalledWith(
			"agent-managed",
			"account-crispy",
			expect.objectContaining({
				sourceStopPolicy: "discard",
				expectedSourceRevision: 7,
			}),
		);
		expect(pendingSwitch()).toBeUndefined();
	});

	it("leaves the source running when Host completion counters are unavailable", async () => {
		useStore.setState({ sessionAgentRuntimeState: {} });
		await expect(pickBusyAccount()).rejects.toBeInstanceOf(
			DureAgentRuntimeSourceActiveError,
		);
		expect(mocks.switchRuntime).toHaveBeenCalledTimes(1);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(pendingSwitch()).toBeUndefined();
	});
});

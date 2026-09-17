import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import type { Agent } from "@/types";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

const mocks = vi.hoisted(() => ({
	providerInput: vi.fn(),
	preflight: vi.fn(),
	knownHostTrust: vi.fn(),
	rehost: vi.fn(),
	reconcile: vi.fn(),
	paneParams: vi.fn(),
	updateParameters: vi.fn(),
	saveLayout: vi.fn(),
	resolveBackendRoute: vi.fn(),
	commitNativeSuccessor: vi.fn(),
	commitCheckpointBinding: vi.fn(),
	paneHealth: vi.fn(),
}));

vi.mock("@/lib/terminal/hmuxPaneHealthStore", () => ({
	getHmuxPaneHealth: mocks.paneHealth,
}));

vi.mock("@/lib/agents/providerConversationInputAuthority", () => ({
	requireIndependentProviderConversationInputForAgent: mocks.providerInput,
}));

vi.mock("@/lib/agents/remoteAccountOverlay", () => ({
	preflightRemoteAccountLaunch: mocks.preflight,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxBroker", () => ({
	planRemoteHmuxCatalogTarget: vi.fn(() => ({
		schemaVersion: 1,
		hostId: "host-1",
	})),
}));

vi.mock("@/lib/ipc", () => ({
	remoteHmuxKnownHostTrust: mocks.knownHostTrust,
	remoteHmuxManagedRehost: mocks.rehost,
	remoteHmuxManagedRehostReconcile: mocks.reconcile,
}));

vi.mock("@/lib/ipc/dureBackend", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureBackend")>()),
	resolveSelectedDureBackendRouteAuthority: mocks.resolveBackendRoute,
}));

vi.mock("@/lib/sessions/managed/managedAgentRehostCommit", () => ({
	commitManagedAgentNativeRehostSuccessor: mocks.commitNativeSuccessor,
}));

vi.mock("@/lib/sessions/managed/managedAgentCheckpointBinding", () => ({
	commitManagedAgentCheckpointBinding: mocks.commitCheckpointBinding,
}));

import {
	requestRemoteManagedBuildRehost,
	requestRemoteManagedCredentialSwitch,
} from "@/lib/sessions/credentials/remoteManagedCredentialSwitch";
import { useStore } from "@/store";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { agentFixture, stopFenceFixture } from "@/test/agentFixtures";

const sourceFence = stopFenceFixture({
	hostInstanceId: "host-generation-1",
	terminalEpoch: "terminal-generation-1",
});

function mountAgentPane(id = "agent:agent-1", component = "agent") {
	const panel = {
		id,
		get params() {
			return mocks.paneParams();
		},
		api: {
			component,
			getParameters: mocks.paneParams,
			updateParameters: mocks.updateParameters,
		},
	};
	const api = {
		panels: [panel],
		getPanel: (panelId: string) => (panelId === id ? panel : undefined),
	} as unknown as DockviewApi;
	dockviewRegistry.clear();
	dockviewRegistry.set("desktop-1", api);
	return panel;
}

afterEach(() => dockviewRegistry.clear());
const remoteRouteAuthority = {
	schemaVersion: 1 as const,
	profileId: "remote-primary",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-remote", generation: "backend-generation-1" },
	target: {
		source: "ssh" as const,
		hostId: "remote-primary",
		remote: { host: "example.test", port: 22, user: "agent" },
	},
};

function agent(): Agent {
	return agentFixture({
		name: "remote-codex",
		worktreePath: "/srv/repo",
		branch: "main",
		sessionId: "session-source",
		sessionKind: "ssh",
		conversationId: "conversation-exact",
		accountId: "credential-source",
		credentialId: "credential-source",
		started: true,
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			sessionId: "session-source",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-source",
			commandBridgeNonce: "bridge-source",
			stopFence: sourceFence,
			credentialId: "credential-source",
			credentialProfileDirectory: ".dure/accounts/codex-source",
		},
	});
}

function replacementReceipt() {
	return {
		operationId: "operation",
		bridgeNonce: "bridge-source",
		conversationId: "conversation-exact",
		launchReference: "codex-target",
		replayed: false,
		sourceStopReceipt: {},
		replacementIdempotencyKey: "create-replacement",
		replacement: {
			idempotencyKey: "create-replacement",
			sessionId: "session-replacement",
			workspaceId: "workspace-1",
			sessionClass: "managed",
			lifecycle: "ready",
			providerId: "codex",
			runnerPrincipal: "principal-2",
			runnerInstance: "runner-2",
			channelEpoch: "8",
			hostInstanceId: "host-generation-2",
			terminalEpoch: "terminal-generation-2",
		},
	};
}

function nativeRuntimeReceipt() {
	return {
		agentId: "agent-1",
		providerId: "codex" as const,
		interactionProfile: "native_cli" as const,
		executionProfile: {
			kind: "credential_reference" as const,
			reference_id: "credential-target",
			credential_generation: "target-generation-1",
		},
		providerConversationRef: "conversation-exact",
		sessionId: "session-replacement",
		workspaceId: "workspace-1",
		launchIdempotencyKey: "create-replacement",
		stopFence: stopFenceFixture({
			runnerPrincipal: "principal-2",
			runnerInstance: "runner-2",
			channelEpoch: "8",
			hostInstanceId: "host-generation-2",
			terminalEpoch: "terminal-generation-2",
		}),
		backend: remoteRouteAuthority.backend,
		backendProfileId: "remote-primary",
		routeAuthority: remoteRouteAuthority,
		selectionRevision: 2,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default" as const,
		},
	};
}

function cpManagedAgent(): Agent {
	const managed = agent();
	const binding = managed.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "ssh") {
		throw new Error("remote managed fixture required");
	}
	managed.runtimeBinding = {
		...binding,
		backendProfileId: "remote-primary",
	};
	return managed;
}

beforeEach(() => {
	vi.resetAllMocks();
	const source = agent();
	mocks.paneParams.mockReturnValue({ agentRef: { agentId: source.id } });
	mountAgentPane();
	mocks.providerInput.mockResolvedValue(undefined);
	mocks.preflight.mockResolvedValue({ version: "codex 1.0" });
	mocks.knownHostTrust.mockResolvedValue({
		schemaVersion: 1,
		hostId: "host-1",
		hostKeyFingerprints: ["SHA256:testtesttesttest"],
	});
	mocks.resolveBackendRoute.mockResolvedValue(remoteRouteAuthority);
	mocks.commitNativeSuccessor.mockResolvedValue(nativeRuntimeReceipt());
	mocks.reconcile.mockResolvedValue(null);
	mocks.rehost.mockResolvedValue(replacementReceipt());
	mocks.paneHealth.mockReturnValue({
		state: "live",
		terminalEpoch: "terminal-generation-1",
		receivedSequence: "87",
		presentedSequence: "87",
	});
	useStore.setState({
		agents: [source],
		layouts: {},
		accounts: [
			{
				id: "credential-source",
				name: "source",
				provider: "codex",
				dir: "/local/accounts/codex-renamed",
			},
			{
				id: "credential-target",
				name: "target",
				provider: "codex",
				dir: "/local/accounts/codex-target",
			},
		],
		projects: [
			{
				id: "project-1",
				name: "repo",
				path: "/srv/repo",
				kind: "ssh",
				isRepo: true,
				sshHostId: "host-1",
			},
		],
		sshHosts: [
			{
				id: "host-1",
				name: "remote",
				host: "example.test",
				port: 22,
				user: "agent",
				auth: "key",
				keyPath: "/tmp/test-key",
			},
		],
		agentActivity: { "agent-1": "waiting" },
		sessionAgentRuntimeState: {
			"session-source": {
				terminalEpoch: "terminal-generation-1",
				revision: "10",
				activity: "waiting",
				attention: "none",
				source: "provider_event",
				lifecycle: "running",
				turnCompletedCount: "1",
				observedThroughOutputSeq: "10",
			},
		},
		skipPermissions: {},
		saveLayout: mocks.saveLayout,
	});
});

describe("remote managed credential switch", () => {
	it("replays the next stable operation only after a definitive refusal", async () => {
		mocks.reconcile
			.mockRejectedValueOnce(
				"hmux_remote_managed_rehost_precondition_refused: refused before stop",
			)
			.mockResolvedValueOnce(replacementReceipt());
		await requestRemoteManagedCredentialSwitch("agent-1", "credential-target");
		const [first, next] = mocks.reconcile.mock.calls.map(
			([request]) => request,
		);
		expect(next.operationId).toBe(`${first.operationId}_retry_1`);
		expect(mocks.rehost).not.toHaveBeenCalled();
		expect(mocks.preflight).not.toHaveBeenCalled();
	});

	it("keeps an unknown operation pending instead of selecting another attempt", async () => {
		mocks.reconcile.mockRejectedValue(
			"hmux_remote_managed_rehost_outcome_unknown: no receipt",
		);
		await expect(
			requestRemoteManagedCredentialSwitch("agent-1", "credential-target"),
		).rejects.toContain("outcome_unknown");
		expect(mocks.reconcile).toHaveBeenCalledTimes(1);
		expect(mocks.rehost).not.toHaveBeenCalled();
	});
	it.each(
		["credential", "build"].flatMap((kind) =>
			["slot", "launcher:previous", "term:previous", "agent:previous"].map(
				(panelId) => ({ kind, panelId }),
			),
		),
	)(
		"uses the explicit current pane $panelId for $kind rehost",
		async ({ kind, panelId }) => {
			const pane = mountAgentPane(panelId);
			if (kind === "build")
				mocks.rehost.mockResolvedValueOnce({
					...replacementReceipt(),
					launchReference: "codex-source",
				});
			await expect(
				kind === "build"
					? requestRemoteManagedBuildRehost("agent-1", panelId)
					: requestRemoteManagedCredentialSwitch(
							"agent-1",
							"credential-target",
							panelId,
						),
			).resolves.toEqual({ conversationId: "conversation-exact" });
			expect(mocks.rehost).toHaveBeenCalledOnce();
			expect(mocks.rehost.mock.calls[0]?.[0]).toMatchObject({
				sourceFence,
				sourceSessionId: "session-source",
			});
			if (kind === "build")
				expect(mocks.rehost.mock.calls[0]?.[0].sourceOwnerId).toBe(
					`window:main:desktop:desktop-1:pane:${panelId}`,
				);
			expect(dockviewRegistry.get("desktop-1")?.getPanel(panelId)).toBe(pane);
			expect(mocks.updateParameters).not.toHaveBeenCalled();
		},
	);

	it.each(["invalid-ref", "retargeted", "terminal"])(
		"refuses a new pane-scoped request for $0 content at a historical Agent ID",
		async (change) => {
			mountAgentPane(
				"agent:agent-1",
				change === "terminal" ? "terminal" : "agent",
			);
			mocks.paneParams.mockReturnValue({
				agentRef: change === "invalid-ref" ? null : { agentId: "other" },
			});
			await expect(
				requestRemoteManagedCredentialSwitch(
					"agent-1",
					"credential-target",
					"agent:agent-1",
				),
			).rejects.toMatchObject({ code: "pane_changed" });
			expect(mocks.rehost).not.toHaveBeenCalled();
			expect(mocks.preflight).not.toHaveBeenCalled();
		},
	);

	it.each(["closed", "retargeted"])(
		"preserves a pane that is $0 during credential preflight",
		async (change) => {
			mocks.preflight.mockImplementationOnce(async () => {
				if (change === "closed") dockviewRegistry.clear();
				else
					mocks.paneParams.mockReturnValue({ agentRef: { agentId: "other" } });
			});
			await expect(
				requestRemoteManagedCredentialSwitch(
					"agent-1",
					"credential-target",
					"agent:agent-1",
				),
			).rejects.toMatchObject({ code: "pane_changed" });
			expect(mocks.rehost).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0].sessionId).toBe("session-source");
		},
	);

	it.each(["closed", "retargeted"])(
		"replays an accepted rehost after the optional pane is $0",
		async (change) => {
			mountAgentPane("retained-slot");
			if (change === "closed") dockviewRegistry.clear();
			else mocks.paneParams.mockReturnValue({ agentRef: { agentId: "other" } });
			mocks.reconcile.mockResolvedValueOnce(replacementReceipt());
			await expect(
				requestRemoteManagedCredentialSwitch(
					"agent-1",
					"credential-target",
					"retained-slot",
				),
			).resolves.toEqual({ conversationId: "conversation-exact" });
			expect(mocks.rehost).not.toHaveBeenCalled();
			expect(mocks.preflight).not.toHaveBeenCalled();
			expect(mocks.updateParameters).not.toHaveBeenCalled();
		},
	);

	it("retains headless build rehost without inventing a mounted pane owner", async () => {
		dockviewRegistry.clear();
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "codex-source",
		});
		await requestRemoteManagedBuildRehost("agent-1");
		expect(mocks.rehost).toHaveBeenCalledOnce();
		expect(mocks.rehost.mock.calls[0]?.[0]).not.toHaveProperty("sourceOwnerId");
	});

	it("commits an accepted native result without overwriting a pane changed during dispatch", async () => {
		const pane = mountAgentPane("retained-slot");
		const changed = { agentRef: { agentId: "other" } };
		mocks.rehost.mockImplementationOnce(async () => {
			mocks.paneParams.mockReturnValue(changed);
			return replacementReceipt();
		});
		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"retained-slot",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });
		expect(useStore.getState().agents[0].sessionId).toBe("session-replacement");
		expect(dockviewRegistry.get("desktop-1")?.getPanel("retained-slot")).toBe(
			pane,
		);
		expect(pane.params).toBe(changed);
		expect(mocks.rehost).toHaveBeenCalledOnce();
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it.each(["agent:agent-1", "slot", "launcher:previous"])(
		"switches a zero-turn native SSH session using the current output guard from %s",
		async (panelId) => {
			mountAgentPane(panelId);
			const source = agent();
			source.conversationId = undefined;
			source.conversationIdentity = undefined;
			useStore.setState({
				agents: [source],
				sessionAgentRuntimeState: {
					"session-source": {
						...useStore.getState().sessionAgentRuntimeState["session-source"],
						turnCompletedCount: "0",
					},
				},
			});
			mocks.resolveBackendRoute.mockResolvedValue(undefined);
			mocks.rehost.mockResolvedValue({
				...replacementReceipt(),
				conversationId: null,
			});
			await expect(
				requestRemoteManagedCredentialSwitch(
					"agent-1",
					"credential-target",
					panelId,
				),
			).resolves.toEqual({ conversationId: null });
			expect(mocks.paneHealth).toHaveBeenCalledWith(`desktop-1:${panelId}`);
			expect(mocks.rehost).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: null,
					freshSourceGuard: { runtimeRevision: "10", outputSequence: "87" },
				}),
			);
			expect(mocks.providerInput).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0]).toMatchObject({
				sessionId: "session-replacement",
				credentialId: "credential-target",
			});
		},
	);

	it.each([
		"completed_turn",
		"working",
		"approval",
		"exited",
		"epoch_changed",
		"pending_switch",
		"missing_output",
		"unpresented_output",
		"output_epoch_changed",
	])("refuses a fresh switch when %s", async (change) => {
		const source = agent();
		source.conversationId = undefined;
		if (change === "pending_switch")
			source.pendingCredentialSwitch = {} as NonNullable<
				Agent["pendingCredentialSwitch"]
			>;
		const runtime = {
			...useStore.getState().sessionAgentRuntimeState["session-source"],
			turnCompletedCount: "0",
		};
		if (change === "completed_turn") runtime.turnCompletedCount = "1";
		if (change === "working") runtime.activity = "working";
		if (change === "approval") runtime.attention = "approval_required";
		if (change === "exited") runtime.lifecycle = "exited";
		if (change === "epoch_changed") runtime.terminalEpoch = "other-terminal";
		if (change === "missing_output")
			mocks.paneHealth.mockReturnValue(undefined);
		if (change === "unpresented_output")
			mocks.paneHealth.mockReturnValue({
				...mocks.paneHealth(),
				presentedSequence: "86",
			});
		if (change === "output_epoch_changed")
			mocks.paneHealth.mockReturnValue({
				...mocks.paneHealth(),
				terminalEpoch: "other-terminal",
			});
		useStore.setState({
			agents: [source],
			sessionAgentRuntimeState: { "session-source": runtime },
		});
		mocks.resolveBackendRoute.mockResolvedValue(undefined);
		await expect(
			requestRemoteManagedCredentialSwitch("agent-1", "credential-target"),
		).rejects.toThrow();
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
	});

	it("refuses a fresh source that starts a turn during credential preparation", async () => {
		const source = agent();
		source.conversationId = undefined;
		useStore.setState({
			agents: [source],
			sessionAgentRuntimeState: {
				"session-source": {
					...useStore.getState().sessionAgentRuntimeState["session-source"],
					turnCompletedCount: "0",
				},
			},
		});
		mocks.resolveBackendRoute.mockResolvedValue(undefined);
		mocks.preflight.mockImplementation(async () => {
			useStore.setState({
				sessionAgentRuntimeState: {
					"session-source": {
						...useStore.getState().sessionAgentRuntimeState["session-source"],
						turnCompletedCount: "1",
					},
				},
			});
		});
		await expect(
			requestRemoteManagedCredentialSwitch("agent-1", "credential-target"),
		).rejects.toThrow("fresh_state_unverified");
		expect(mocks.rehost).not.toHaveBeenCalled();
	});

	it("refuses before remote provider preflight or journal admission when direct input is not independent", async () => {
		mocks.providerInput.mockRejectedValueOnce(
			new Error("provider_conversation_controlled_by_parent"),
		);

		await expect(
			requestRemoteManagedBuildRehost("agent-1", "agent:agent-1"),
		).rejects.toThrow("provider_conversation_controlled_by_parent");
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
	});

	it("rehosts an old remote build without changing conversation or credential locus", async () => {
		const idleReplacementGuard = {
			runtimeRevision: "10",
			outputSequence: "10",
			providerId: "codex" as const,
			conversationId: "conversation-exact",
		};
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "codex-source",
		});
		useStore.setState((current) => ({
			agents: current.agents.map((item) =>
				item.id === "agent-1"
					? { ...item, accountId: "stale-agent", credentialId: "stale-agent" }
					: item,
			),
		}));
		await expect(
			requestRemoteManagedBuildRehost("agent-1", "agent:agent-1", {
				idleReplacementGuard,
			}),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(mocks.rehost).toHaveBeenCalledWith(
			expect.objectContaining({
				operationId: expect.stringMatching(/^remote_rehost_[0-9a-f]{16}$/),
				sourceSessionId: "session-source",
				sourceFence,
				targetCredentialId: "credential-source",
				targetCredentialProfileDirectory: ".dure/accounts/codex-source",
				idleReplacementGuard,
				sourceOwnerId: "window:main:desktop:desktop-1:pane:agent:agent-1",
			}),
		);
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-replacement",
			conversationId: "conversation-exact",
			credentialId: "credential-source",
			runtimeBinding: {
				sessionId: "session-replacement",
				credentialId: "credential-source",
				credentialProfileDirectory: ".dure/accounts/codex-source",
			},
		});
	});

	it("quiesces the initiating pane for a confirmed legacy remote first hop", async () => {
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "codex-source",
		});

		await requestRemoteManagedBuildRehost("agent-1", "agent:agent-1", {
			expectedTargetBuildId: "build-confirmed",
		});

		expect(mocks.rehost).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceOwnerId: "window:main:desktop:desktop-1:pane:agent:agent-1",
				expectedTargetBuildId: "build-confirmed",
			}),
		);
		expect(mocks.rehost.mock.calls[0]?.[0]).not.toHaveProperty(
			"idleReplacementGuard",
		);
	});

	it("preflights before one exact remote journaled rehost and commits its receipt", async () => {
		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.rehost.mock.invocationCallOrder[0],
		);
		expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.providerInput.mock.invocationCallOrder[0],
		);
		expect(mocks.providerInput.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.preflight.mock.invocationCallOrder[0],
		);
		expect(mocks.rehost).toHaveBeenCalledWith(
			expect.objectContaining({
				operationId: expect.stringMatching(/^remote_switch_[0-9a-f]{16}$/),
				sourceSessionId: "session-source",
				sourceFence,
				targetCredentialId: "credential-target",
				targetCredentialProfileDirectory: ".dure/accounts/codex-target",
			}),
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-replacement",
			accountId: "credential-target",
			credentialId: "credential-target",
			runtimeBinding: {
				sessionId: "session-replacement",
				credentialId: "credential-target",
				credentialProfileDirectory: ".dure/accounts/codex-target",
				stopFence: { terminalEpoch: "terminal-generation-2" },
			},
		});
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("replays a durable response-loss receipt before any target preflight", async () => {
		mocks.reconcile.mockResolvedValueOnce(replacementReceipt());

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.providerInput).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
	});

	it("adopts an exact replacement from the durable receipt without catalog lifecycle", async () => {
		mocks.reconcile.mockResolvedValueOnce({
			...replacementReceipt(),
			replacement: {
				...replacementReceipt().replacement,
				lifecycle: "exited",
			},
		});

		await requestRemoteManagedCredentialSwitch(
			"agent-1",
			"credential-target",
			"agent:agent-1",
		);

		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
		expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
	});

	it("refuses a durable SSH receipt with the wrong legacy profile leaf", async () => {
		mocks.reconcile.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "codex-wrong",
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).rejects.toThrow("remote_hmux_managed_rehost_launch_reference_conflict");

		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-source",
		});
	});

	it("commits an exact SSH A-to-B successor before projecting Agent or pane state", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.commitNativeSuccessor.mockImplementationOnce(async (successor) => {
			expect(useStore.getState().agents[0]?.sessionId).toBe("session-source");
			expect(mocks.updateParameters).not.toHaveBeenCalled();
			expect(successor).toMatchObject({
				agentId: "agent-1",
				providerId: "codex",
				source: { sessionId: "session-source", stopFence: sourceFence },
				target: {
					sessionId: "session-replacement",
					createIdempotencyKey: "create-replacement",
				},
				targetCredential: {
					kind: "credential_reference",
					referenceId: "credential-target",
					profileDirectoryName: "codex-target",
				},
				routeAuthority: remoteRouteAuthority,
			});
			return nativeRuntimeReceipt();
		});

		await requestRemoteManagedCredentialSwitch(
			"agent-1",
			"credential-target",
			"agent:agent-1",
		);

		expect(mocks.resolveBackendRoute).toHaveBeenCalledWith("remote-primary");
		expect(mocks.commitNativeSuccessor).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
	});

	it("commits an exact SSH credential-to-default successor without a launch reference", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: undefined,
		});
		mocks.commitNativeSuccessor.mockImplementationOnce(async (successor) => {
			expect(successor.targetCredential).toEqual({ kind: "provider_default" });
			return {
				...nativeRuntimeReceipt(),
				executionProfile: { kind: "provider_default" },
			};
		});

		await requestRemoteManagedCredentialSwitch(
			"agent-1",
			null,
			"agent:agent-1",
		);

		expect(mocks.rehost.mock.calls[0]?.[0]).not.toHaveProperty(
			"targetCredentialId",
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			accountId: null,
			sessionId: "session-replacement",
		});
		expect(useStore.getState().agents[0]?.credentialId).toBeUndefined();
		expect(useStore.getState().agents[0]?.runtimeBinding).not.toHaveProperty(
			"credentialId",
		);
	});

	it("replays an exact CP-managed SSH successor after its local profile is removed", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed], accounts: [] });
		mocks.reconcile.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.commitNativeSuccessor.mockImplementationOnce(async (successor) => {
			expect(successor.targetCredential).toEqual({
				kind: "credential_reference",
				referenceId: "credential-target",
			});
			expect(useStore.getState().agents[0]?.sessionId).toBe("session-source");
			return nativeRuntimeReceipt();
		});

		await requestRemoteManagedCredentialSwitch(
			"agent-1",
			"credential-target",
			"agent:agent-1",
		);

		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
		expect(mocks.commitNativeSuccessor).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0]?.runtimeBinding).toMatchObject({
			sessionId: "session-replacement",
			credentialId: "credential-target",
		});
		expect(useStore.getState().agents[0]?.runtimeBinding).not.toHaveProperty(
			"credentialProfileDirectory",
		);
	});

	it("lets CP prove an old exact profile-leaf receipt after the local catalog is removed", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed], accounts: [] });
		mocks.reconcile.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "codex-target",
		});
		mocks.commitNativeSuccessor.mockImplementationOnce(async (successor) => {
			expect(successor.targetCredential).toEqual({
				kind: "credential_reference",
				referenceId: "credential-target",
			});
			return nativeRuntimeReceipt();
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				managed.id,
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(useStore.getState().agents[0]?.runtimeBinding).toMatchObject({
			sessionId: "session-replacement",
			credentialId: "credential-target",
		});
		expect(useStore.getState().agents[0]?.runtimeBinding).not.toHaveProperty(
			"credentialProfileDirectory",
		);
	});

	it("keeps SSH Agent and pane projections unchanged when CP refuses", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.commitNativeSuccessor.mockRejectedValueOnce(
			new Error("agent_runtime_native_rehost_source_conflict"),
		);

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).rejects.toThrow("agent_runtime_native_rehost_source_conflict");

		expect(useStore.getState().agents[0]?.sessionId).toBe("session-source");
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("adopts an unmanaged SSH successor through the shared checkpoint binding path", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.commitNativeSuccessor.mockResolvedValueOnce(undefined);

		await expect(
			requestRemoteManagedCredentialSwitch(
				managed.id,
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
		expect(mocks.commitCheckpointBinding).toHaveBeenCalledWith(
			remoteRouteAuthority,
			managed.id,
			expect.objectContaining({
				source: "ssh",
				sessionId: "session-replacement",
				workspaceId: "workspace-1",
				backendProfileId: "remote-primary",
				stopFence: expect.objectContaining({
					terminalEpoch: "terminal-generation-2",
				}),
			}),
		);
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("projects the authoritative receipt after a concurrent rename and permission edit", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.commitNativeSuccessor.mockImplementationOnce(async () => {
			useStore.setState((current) => ({
				agents: current.agents.map((candidate) =>
					candidate.id === managed.id
						? {
								...candidate,
								name: "renamed-after-native-commit",
								skipPermissions: true,
							}
						: candidate,
				),
			}));
			return nativeRuntimeReceipt();
		});

		await requestRemoteManagedCredentialSwitch(
			managed.id,
			"credential-target",
			"agent:agent-1",
		);

		expect(useStore.getState().agents[0]).toMatchObject({
			name: "renamed-after-native-commit",
			sessionId: "session-replacement",
			skipPermissions: false,
		});
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("does not let replaceable pane metadata block the backend and Agent commit", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.rehost.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});
		mocks.updateParameters.mockImplementationOnce(() => {
			throw new Error("pane projection interrupted");
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				managed.id,
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
		expect(mocks.rehost).toHaveBeenCalledOnce();
		expect(mocks.preflight).toHaveBeenCalledOnce();
		expect(mocks.commitNativeSuccessor).toHaveBeenCalledOnce();
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("uses the Host-projected conversation identity for the remote rehost CAS", async () => {
		const managed = cpManagedAgent();
		const binding = managed.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "ssh") {
			throw new Error("remote managed fixture required");
		}
		const projected: Agent = {
			...managed,
			conversationId: "conversation-stale",
			runtimeBinding: {
				...binding,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					...sourceFence,
					revision: "2",
					observedThroughOutputSeq: "10",
					providerId: "codex",
					conversationId: "conversation-exact",
					source: "provider_event",
				},
			},
		};
		useStore.setState({ agents: [projected] });

		await expect(
			requestRemoteManagedCredentialSwitch(
				projected.id,
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(mocks.rehost).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: "conversation-exact" }),
		);
		expect(mocks.commitNativeSuccessor).toHaveBeenCalledWith(
			expect.objectContaining({
				providerConversationRef: "conversation-exact",
			}),
		);
	});

	it("ignores stale pane runtime metadata and uses the Agent/backend source", async () => {
		const managed = cpManagedAgent();
		useStore.setState({ agents: [managed] });
		mocks.paneParams.mockReturnValue({
			agentId: "agent-foreign",
			binding: {
				...managed.runtimeBinding,
				workspaceId: "workspace-foreign",
			},
		});
		mocks.reconcile.mockResolvedValueOnce({
			...replacementReceipt(),
			launchReference: "credential-target",
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				managed.id,
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("reconciles once when the admitted SSH rehost loses its response", async () => {
		mocks.rehost.mockRejectedValueOnce(new Error("outcome unknown"));
		mocks.reconcile
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(replacementReceipt());

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });

		expect(mocks.rehost).toHaveBeenCalledOnce();
		expect(mocks.reconcile).toHaveBeenCalledTimes(2);
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			"session-replacement",
		);
	});

	it("does not preflight or stop a source whose turn is still active", async () => {
		useStore.setState({ agentActivity: { "agent-1": "working" } });

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).rejects.toThrow("remote_managed_credential_switch_requires_idle_turn");
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
	});

	it("commits the journal receipt after the selected profile mapping changes", async () => {
		mocks.rehost.mockImplementationOnce(async () => {
			useStore.setState({
				accounts: [
					{
						id: "credential-target",
						name: "target",
						provider: "codex",
						dir: "/local/accounts/codex-other",
					},
				],
			});
			return replacementReceipt();
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).resolves.toEqual({ conversationId: "conversation-exact" });
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-replacement",
			runtimeBinding: {
				credentialId: "credential-target",
				credentialProfileDirectory: ".dure/accounts/codex-target",
			},
		});
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("preserves a concurrently changed local source after the remote receipt", async () => {
		mocks.rehost.mockImplementationOnce(async () => {
			useStore.setState((current) => ({
				agents: current.agents.map((item) =>
					item.id === "agent-1"
						? { ...item, worktreePath: "/srv/other" }
						: item,
				),
			}));
			return replacementReceipt();
		});

		await expect(
			requestRemoteManagedCredentialSwitch(
				"agent-1",
				"credential-target",
				"agent:agent-1",
			),
		).rejects.toThrow(
			"remote managed replacement completed but local source CAS changed",
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-source",
			worktreePath: "/srv/other",
		});
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});
});

import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { RemoteHmuxCatalogReceiptV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	dockParams: vi.fn(),
	bindingFromPane: vi.fn(),
	localTransaction: vi.fn(),
	providerInput: vi.fn(),
	remoteBrokerRehost: vi.fn(),
	remoteBrokerReconcile: vi.fn(),
	remoteCatalog: vi.fn(),
	remoteRehost: vi.fn(),
	remoteTrust: vi.fn(),
	resolvePaneById: vi.fn(),
	resolvePane: vi.fn(),
	updateParameters: vi.fn(),
}));

vi.mock("@/lib/agents/providerConversationInputAuthority", () => ({
	requireIndependentProviderConversationInput: mocks.providerInput,
}));
vi.mock("@/lib/ipc", () => ({
	remoteHmuxCatalog: mocks.remoteCatalog,
	remoteHmuxKnownHostTrust: mocks.remoteTrust,
	remoteHmuxManagedRehost: mocks.remoteBrokerRehost,
	remoteHmuxManagedRehostReconcile: mocks.remoteBrokerReconcile,
}));
vi.mock("@/lib/sessions/credentials/remoteManagedCredentialSwitch", () => ({
	requestRemoteManagedBuildRehost: mocks.remoteRehost,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostTransaction", () => ({
	runManagedAgentRehostTransaction: mocks.localTransaction,
}));
vi.mock("@/lib/terminal/terminalBinding", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/terminal/terminalBinding")>()),
	bindingFromPane: mocks.bindingFromPane,
}));
vi.mock("@/lib/workspace/dock", () => ({
	resolvePaneById: mocks.resolvePaneById,
	resolvePaneReference: mocks.resolvePane,
}));

import { rehostManagedBuild } from "@/lib/sessions/managed/managedBuildRehostWorkflow";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const registeredDockviews: Array<{
	desktopId: string;
	api: DockviewApi;
}> = [];

const stopFence = stopFenceFixture({
	runnerPrincipal: "principal",
	runnerInstance: "instance",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});

function remoteAgent(): Agent {
	return {
		id: "remote-agent",
		name: "remote-agent",
		provider: "codex",
		projectId: "project-remote",
		worktreePath: "/srv/repo",
		branch: "main",
		sessionId: "remote-old",
		sessionKind: "ssh",
		conversationId: "conversation-1",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			sessionId: "remote-old",
			workspaceId: "ws-remote",
			createIdempotencyKey: "create-old",
			commandBridgeNonce: "bridge-old",
			stopFence,
		},
	};
}

function localAgent(): Agent {
	return agentFixture({
		id: "local-agent",
		name: "local-agent",
		projectId: "project-local",
		worktreePath: "/repo/local",
		branch: "main",
		sessionId: "local-old",
		conversationId: "conversation-local",
		runtimeBinding: managedBindingFixture({
			sessionId: "local-old",
			workspaceId: "ws-local",
			createIdempotencyKey: "create-local",
			stopFence,
		}),
	});
}

function catalog(
	targetBuildId = "build-current",
	capabilities: string[] = [],
): RemoteHmuxCatalogReceiptV1 {
	return {
		schemaVersion: 1,
		hostId: "host-1",
		sessions: [
			{
				sessionId: "remote-old",
				workspaceId: "ws-remote",
				sessionClass: "managed",
				lifecycle: "ready",
				providerId: "codex",
				...stopFence,
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities,
				hostLiveness: "live",
				gatewayBuildId: targetBuildId,
			},
		],
	};
}

function terminalOwnedRemoteBinding() {
	const source = remoteAgent().runtimeBinding;
	if (
		source?.runtime !== "hmux_managed_v1" ||
		source.source !== "ssh" ||
		!source.stopFence
	) {
		throw new Error("remote fixture binding is invalid");
	}
	return {
		...source,
		stopFence: source.stopFence,
		conversationIdentity: {
			schemaVersion: 1 as const,
			sessionId: source.sessionId,
			workspaceId: source.workspaceId,
			...source.stopFence,
			revision: "1",
			observedThroughOutputSeq: "42",
			providerId: "codex" as const,
			conversationId: "conversation-1",
			source: "provider_event" as const,
		},
	};
}

function terminalOwnedRemoteReceipt(
	binding: ReturnType<typeof terminalOwnedRemoteBinding>,
) {
	return {
		operationId: "remote_rehost_receipt",
		bridgeNonce: binding.commandBridgeNonce,
		conversationId: "conversation-1",
		replayed: false,
		sourceStopReceipt: {
			stopId: "stop-1",
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			...binding.stopFence,
			outcome: "stopped" as const,
			exitReason: "rehosted",
		},
		replacement: {
			idempotencyKey: "replacement-create",
			sessionId: "remote-new",
			workspaceId: binding.workspaceId,
			providerId: "codex",
			runnerPrincipal: binding.stopFence.runnerPrincipal,
			runnerInstance: "replacement-instance",
			channelEpoch: binding.stopFence.channelEpoch,
			hostInstanceId: "replacement-host",
			terminalEpoch: "replacement-terminal",
		},
	};
}

function installTerminalOwnedRemoteFixture(
	binding: ReturnType<typeof terminalOwnedRemoteBinding>,
	panelId = "term:remote-old",
) {
	mocks.dockParams.mockReturnValue({
		binding,
		cwd: "/srv/repo",
		sessionId: binding.sessionId,
	});
	mocks.bindingFromPane.mockReturnValue(binding);
	const resolved = {
		desktopId: "desktop-1",
		panelId,
		cwd: "/srv/repo",
		api: {
			getPanel: () => ({
				id: panelId,
				params: mocks.dockParams(),
				api: {
					component: "terminal",
					updateParameters: mocks.updateParameters,
				},
			}),
			toJSON: () => ({ layout: "remote-terminal" }),
		},
	};
	mocks.resolvePane.mockResolvedValue(resolved);
	mocks.resolvePaneById.mockResolvedValue(resolved);
	mocks.remoteBrokerRehost.mockResolvedValue(
		terminalOwnedRemoteReceipt(binding),
	);
	useStore.setState((state) => ({
		agents: [],
		projects: [],
		sessionCwd: {
			...state.sessionCwd,
			[binding.sessionId]: "/srv/repo",
		},
	}));
}

function registerTerminalOwnedRemotePane(
	binding: ReturnType<typeof terminalOwnedRemoteBinding>,
	panelId = "term:remote-old",
) {
	const group = { element: { isConnected: true } };
	type PanelParameters = Record<string, unknown>;
	const updateParameters = vi.fn((params: PanelParameters) => {
		panel.params = params;
	});
	const panel: {
		id: string;
		params: PanelParameters;
		group: typeof group;
		api: { component: string; updateParameters: typeof updateParameters };
	} = {
		id: panelId,
		params: {
			binding,
			cwd: "/srv/repo",
			sessionId: binding.sessionId,
		},
		group,
		api: { component: "terminal", updateParameters },
	};
	const api = {
		panels: [panel],
		groups: [group],
		getPanel: (candidateId: string) =>
			candidateId === panel.id ? panel : undefined,
		toJSON: () => ({
			panels: {
				[panel.id]: {
					id: panel.id,
					contentComponent: panel.api.component,
					params: panel.params,
				},
			},
		}),
	} as unknown as DockviewApi;
	registerDockview("desktop-1", api);
	registeredDockviews.push({ desktopId: "desktop-1", api });
	return { panel, updateParameters };
}

afterEach(() => {
	for (const { desktopId, api } of registeredDockviews.splice(0)) {
		unregisterDockview(desktopId, api);
	}
});

beforeEach(() => {
	vi.clearAllMocks();
	const agent = remoteAgent();
	mocks.dockParams.mockReturnValue({ agentRef: { agentId: "remote-agent" } });
	mocks.bindingFromPane.mockReturnValue(agent.runtimeBinding);
	mocks.providerInput.mockResolvedValue(undefined);
	mocks.remoteBrokerReconcile.mockResolvedValue(null);
	mocks.localTransaction.mockResolvedValue({
		state: "completed",
		rehost: { outcome: "rehosted" },
	});
	mocks.remoteTrust.mockResolvedValue({
		schemaVersion: 1,
		hostId: "host-1",
		hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
	});
	mocks.remoteCatalog.mockResolvedValue(catalog());
	mocks.resolvePane.mockResolvedValue({
		desktopId: "desktop-1",
		panelId: "agent:remote-agent",
		api: {
			getPanel: () => ({
				id: "agent:remote-agent",
				params: mocks.dockParams(),
				api: { component: "agent", updateParameters: mocks.updateParameters },
			}),
			toJSON: () => ({ layout: "remote" }),
		},
	});
	mocks.resolvePaneById.mockResolvedValue({
		desktopId: "desktop-1",
		panelId: "agent:remote-agent",
		api: {
			getPanel: () => ({
				id: "agent:remote-agent",
				params: mocks.dockParams(),
				api: { component: "agent", updateParameters: mocks.updateParameters },
			}),
			toJSON: () => ({ layout: "remote" }),
		},
	});
	useStore.setState({
		agents: [agent],
		projects: [
			{
				id: "project-remote",
				name: "remote",
				path: "/srv/repo",
				kind: "ssh",
				isRepo: true,
				sshHostId: "host-1",
			},
		],
		sshHosts: [
			{
				id: "host-1",
				name: "host",
				host: "example.test",
				port: 22,
				user: "agent",
				auth: "key",
				keyPath: "/tmp/key",
			},
		],
		hmuxSessionMetadata: {
			[hmuxSessionMetadataKey("ws-remote", "remote-old")]: {
				sessionId: "remote-old",
				workspaceId: "ws-remote",
				sessionClass: "managed",
				lifecycle: "ready",
				health: "compatible_old_healthy",
				hostBuildVersion: "build-old",
				inputAllowed: true,
				runtimeHost: "host-1",
				terminalEpoch: stopFence.terminalEpoch,
				stopFence,
				outputSeq: "42",
				capabilities: [],
			},
		},
	});
});

describe("managed build rehost workflow", () => {
	it("delegates local Agent rehost to the shared transaction", async () => {
		useStore.setState({ agents: [localAgent()] });

		await rehostManagedBuild("local-agent", "agent:local-agent");

		expect(mocks.localTransaction).toHaveBeenCalledWith({
			name: "local-agent",
			panelId: "agent:local-agent",
			confirmed: true,
		});
		expect(mocks.remoteCatalog).not.toHaveBeenCalled();
	});

	it.each([
		"pane-current",
		"launcher:previous",
		"term:previous",
		"agent:previous",
		"agent:remote-agent",
	])(
		"carries actual pane %s through one SSH inspection to the journaled broker",
		async (panelId) => {
			await rehostManagedBuild("remote-agent", panelId);

			expect(mocks.remoteCatalog).toHaveBeenCalledTimes(1);
			expect(mocks.remoteRehost).toHaveBeenCalledWith(
				"remote-agent",
				panelId,
				expect.objectContaining({
					expectedTargetBuildId: "build-current",
					expectedCatalogTarget: expect.objectContaining({ hostId: "host-1" }),
				}),
			);
		},
	);

	it("rehosts a healthy same-build SSH agent to restore its integrations", async () => {
		mocks.remoteCatalog.mockResolvedValue(catalog("build-old"));

		await rehostManagedBuild("remote-agent", "agent:remote-agent");

		expect(mocks.remoteRehost).toHaveBeenCalledWith(
			"remote-agent",
			"agent:remote-agent",
			expect.objectContaining({ expectedTargetBuildId: "build-old" }),
		);
	});

	it("does not duplicate SSH launch validation in the frontend", async () => {
		mocks.remoteCatalog.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				sshHosts: state.sshHosts.map((host) =>
					host.id === "host-1" ? { ...host, keyPath: "/tmp/key-next" } : host,
				),
			}));
			return catalog();
		});

		await rehostManagedBuild("remote-agent", "agent:remote-agent");
		expect(mocks.remoteRehost).toHaveBeenCalledOnce();
	});

	it("does not send an idle observation through explicit SSH rehost", async () => {
		mocks.remoteCatalog.mockResolvedValue(catalog("build-current", []));
		useStore.setState((state) => ({
			sessionAgentRuntimeState: {
				...state.sessionAgentRuntimeState,
				"remote-old": {
					terminalEpoch: stopFence.terminalEpoch,
					revision: "11",
					observedThroughOutputSeq: "42",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "provider_event",
					turnCompletedCount: "5",
				},
			},
		}));

		await rehostManagedBuild("remote-agent", "agent:remote-agent");

		expect(mocks.remoteRehost).toHaveBeenCalledOnce();
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("rehosts a terminal-owned SSH managed binding without Agent metadata", async () => {
		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		installTerminalOwnedRemoteFixture(binding, panelId);

		mocks.remoteCatalog.mockImplementationOnce(async () => {
			mocks.bindingFromPane.mockReturnValue({
				...binding,
				conversationIdentity: {
					...binding.conversationIdentity,
					revision: "2",
					observedThroughOutputSeq: "43",
				},
			});
			return catalog();
		});
		await rehostManagedBuild(binding, panelId);

		expect(mocks.remoteBrokerRehost).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceSessionId: binding.sessionId,
				providerId: "codex",
				conversationId: "conversation-1",
				cwd: "/srv/repo",
			}),
		);
		expect(mocks.updateParameters).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "remote-new",
				binding: expect.objectContaining({
					sessionId: "remote-new",
					workspaceId: binding.workspaceId,
				}),
			}),
		);
	});

	it("replays a durable terminal-owned rehost without repeating first-admission input checks", async () => {
		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		installTerminalOwnedRemoteFixture(binding, panelId);
		mocks.remoteBrokerReconcile.mockResolvedValueOnce(
			terminalOwnedRemoteReceipt(binding),
		);

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();

		expect(mocks.providerInput).not.toHaveBeenCalled();
		expect(mocks.remoteBrokerRehost).not.toHaveBeenCalled();
		expect(mocks.updateParameters).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "remote-new" }),
		);
	});

	it("keeps a durable terminal-owned rehost successful when its pane disappears", async () => {
		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		installTerminalOwnedRemoteFixture(binding, panelId);
		mocks.resolvePaneById.mockResolvedValueOnce({
			desktopId: "desktop-1",
			panelId,
			cwd: "/srv/repo",
			api: {
				getPanel: () => null,
				toJSON: () => ({ layout: "remote-terminal" }),
			},
		});

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();

		expect(mocks.remoteBrokerRehost).toHaveBeenCalledOnce();
		expect(mocks.updateParameters).not.toHaveBeenCalled();
	});

	it("rechecks the exact terminal-owned source after an empty journal lookup", async () => {
		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		installTerminalOwnedRemoteFixture(binding, panelId);
		mocks.remoteBrokerReconcile.mockImplementationOnce(async () => {
			mocks.bindingFromPane.mockReturnValue({
				...binding,
				createIdempotencyKey: "third-generation",
			});
			return null;
		});

		await expect(rehostManagedBuild(binding, panelId)).rejects.toMatchObject({
			code: "pane_changed",
		});

		expect(mocks.remoteBrokerRehost).not.toHaveBeenCalled();
	});

	it("repairs a completed terminal-owned rehost without catalog inspection", async () => {
		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		installTerminalOwnedRemoteFixture(binding, panelId);
		mocks.remoteBrokerReconcile.mockResolvedValueOnce(
			terminalOwnedRemoteReceipt(binding),
		);
		mocks.remoteCatalog.mockRejectedValueOnce(
			new Error("retired source is absent from catalog"),
		);

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();

		expect(mocks.remoteCatalog).not.toHaveBeenCalled();
		expect(mocks.remoteBrokerRehost).not.toHaveBeenCalled();
		expect(mocks.updateParameters).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "remote-new",
				binding: expect.objectContaining({
					createIdempotencyKey: "replacement-create",
					stopFence: expect.objectContaining({
						terminalEpoch: "replacement-terminal",
					}),
				}),
			}),
		);
	});

	it("CASes a canonical receipt through real pane resolution", async () => {
		const actualDock = await vi.importActual<
			typeof import("@/lib/workspace/dock")
		>("@/lib/workspace/dock");
		mocks.resolvePane.mockImplementation(actualDock.resolvePaneReference);
		mocks.resolvePaneById.mockImplementation(actualDock.resolvePaneById);
		const actualBinding = await vi.importActual<
			typeof import("@/lib/terminal/terminalBinding")
		>("@/lib/terminal/terminalBinding");
		mocks.bindingFromPane.mockImplementation(actualBinding.bindingFromPane);

		const binding = terminalOwnedRemoteBinding();
		const panelId = "term:remote-old";
		const { panel, updateParameters } = registerTerminalOwnedRemotePane(
			binding,
			panelId,
		);
		mocks.remoteBrokerReconcile.mockResolvedValue(
			terminalOwnedRemoteReceipt(binding),
		);
		useStore.setState((state) => ({
			agents: [],
			projects: [],
			sessionCwd: {
				...state.sessionCwd,
				[binding.sessionId]: "/srv/repo",
			},
		}));

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();
		expect(panel.params).toMatchObject({
			sessionId: "remote-new",
			binding: {
				sessionId: "remote-new",
				workspaceId: binding.workspaceId,
				createIdempotencyKey: "replacement-create",
				stopFence: { terminalEpoch: "replacement-terminal" },
			},
		});
		expect(updateParameters).toHaveBeenCalledTimes(1);

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();
		expect(updateParameters).toHaveBeenCalledTimes(1);

		const targetBinding = panel.params.binding as ReturnType<
			typeof terminalOwnedRemoteBinding
		>;
		const thirdBinding = {
			...targetBinding,
			sessionId: "remote-third",
			createIdempotencyKey: "third-create",
			stopFence: {
				...targetBinding.stopFence,
				runnerInstance: "third-instance",
				hostInstanceId: "third-host",
				terminalEpoch: "third-terminal",
			},
		};
		panel.params = {
			...panel.params,
			sessionId: thirdBinding.sessionId,
			binding: thirdBinding,
		};

		await expect(rehostManagedBuild(binding, panelId)).resolves.toBeUndefined();
		expect(updateParameters).toHaveBeenCalledTimes(1);
		expect(panel.params.binding).toBe(thirdBinding);
	});
});

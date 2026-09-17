import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { requireIndependentProviderConversationInput } from "@/lib/agents/providerConversationInputAuthority";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogReceiptV1,
	type RemoteHmuxCatalogTargetV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import { remoteHmuxCatalog, remoteHmuxKnownHostTrust } from "@/lib/ipc";
import { requestRemoteManagedBuildRehost } from "@/lib/sessions/credentials/remoteManagedCredentialSwitch";
import { runManagedAgentRehostTransaction } from "@/lib/sessions/managed/managedAgentRehostTransaction";
import { shortManagedRuntimeDigest } from "@/lib/sessions/managed/managedAgentRuntimeState";
import { managedAgentBuildRehostSource } from "@/lib/sessions/managed/managedBuildRehostAuthority";
import {
	type ManagedBuildRehostPreviewV1,
	managedBuildRehostPreview,
} from "@/lib/sessions/managed/managedBuildRehostPreview";
import { projectRemoteAutomaticManagedRehostSession } from "@/lib/sessions/managed/remoteAutomaticManagedRehost";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import {
	executeRemoteManagedRehostBroker,
	type RemoteManagedRehostBrokerReceipt,
	reconcileRemoteManagedRehostBroker,
} from "@/lib/sessions/managed/remoteManagedRehostBroker";
import {
	bindingFromPane,
	type RemoteHmuxManagedPaneBindingV1,
	remoteHmuxManagedBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { resolvePaneById, resolvePaneReference } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type {
	Agent,
	Project,
	Provider,
	ProviderConversationIdentityBindingV1,
	SshHostConfig,
} from "@/types";

interface RemoteManagedBuildRehostInspection {
	kind: "remote";
	agentId: string;
	panelId: string;
	sourceBinding: RemoteHmuxManagedPaneBindingV1;
	sourceAgent: Agent;
	sourceProject: Project;
	sourceHost: SshHostConfig;
	sourceTarget: RemoteHmuxCatalogTargetV1;
	sourcePermissionMode: "default" | "bypass_approvals";
	preview: ManagedBuildRehostPreviewV1;
}

interface RemotePaneBuildRehostInspection {
	kind: "remote_pane";
	panelId: string;
	sourceBinding: RemoteHmuxManagedPaneBindingV1;
	sourceHost: SshHostConfig;
	sourceTarget: RemoteHmuxCatalogTargetV1;
	sourceProviderId: Provider;
	sourceConversationId: string;
	sourceCwd: string;
	preview: ManagedBuildRehostPreviewV1;
}

type RemoteBuildRehostInspection =
	| RemoteManagedBuildRehostInspection
	| RemotePaneBuildRehostInspection;

function sameFencedConversationIdentity(
	left: ProviderConversationIdentityBindingV1 | undefined,
	right: ProviderConversationIdentityBindingV1 | undefined,
): boolean {
	return (
		left?.sessionId === right?.sessionId &&
		left?.workspaceId === right?.workspaceId &&
		sameHmuxManagedGeneration(left, right) &&
		left?.providerId === right?.providerId &&
		left?.conversationId === right?.conversationId
	);
}

function sameRemotePaneBinding(
	left: Agent["runtimeBinding"] | TerminalPaneBindingV1,
	right: RemoteHmuxManagedPaneBindingV1,
): boolean {
	return (
		sameRemoteManagedBinding(left, right) &&
		left?.runtime === "hmux_managed_v1" &&
		left.source === "ssh" &&
		sameFencedConversationIdentity(
			left.conversationIdentity,
			right.conversationIdentity,
		)
	);
}

function sameRemotePaneRuntime(
	left: Agent["runtimeBinding"] | TerminalPaneBindingV1,
	right: RemoteHmuxManagedPaneBindingV1,
): boolean {
	return (
		left?.runtime === "hmux_managed_v1" &&
		left.source === "ssh" &&
		left.hostId === right.hostId &&
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		left.credentialId === right.credentialId &&
		left.credentialProfileDirectory === right.credentialProfileDirectory &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence)
	);
}

function sourceGeneration(
	workspaceId: string,
	sessionId: string,
	fence: NonNullable<RemoteHmuxManagedPaneBindingV1["stopFence"]>,
): string {
	const seed = [
		"managed-build-rehost-source-v1",
		workspaceId,
		sessionId,
		fence.runnerPrincipal,
		fence.runnerInstance,
		fence.channelEpoch,
		fence.hostInstanceId,
		fence.terminalEpoch,
	].join("\0");
	return `${shortManagedRuntimeDigest(seed)}${shortManagedRuntimeDigest(`generation\0${seed}`)}`;
}

function exactRemoteCatalogSession(
	catalog: RemoteHmuxCatalogReceiptV1,
	binding: RemoteHmuxManagedPaneBindingV1,
) {
	const matches = catalog.sessions.filter(
		(session) =>
			session.sessionId === binding.sessionId &&
			session.workspaceId === binding.workspaceId,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

async function inspectRemoteManagedBuildRehost(
	agentId: string,
	requestedPanelId: string,
): Promise<RemoteManagedBuildRehostInspection> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "ssh" ||
		!binding.stopFence
	) {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_build_rehost_source_required",
		);
	}
	const conversationId = agent.conversationId?.trim();
	if (!conversationId) {
		throw new PaneCommandError(
			"invalid_request",
			"conversation_identity_required",
		);
	}
	const attached =
		state.hmuxSessionMetadata[
			hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)
		];
	const project = state.projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	const host = state.sshHosts.find(
		(candidate) => candidate.id === binding.hostId,
	);
	if (!host || project?.sshHostId !== binding.hostId) {
		throw new PaneCommandError(
			"invalid_request",
			"remote managed project or SSH host is unavailable",
		);
	}
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target = planRemoteHmuxCatalogTarget(state.sshHosts, host.id, trust);
	const catalog = await remoteHmuxCatalog(target);
	const projected = projectRemoteAutomaticManagedRehostSession(
		agent,
		attached,
		catalog,
	);
	const remote = exactRemoteCatalogSession(catalog, binding);
	if (!projected || !remote?.gatewayBuildId) {
		throw new PaneCommandError(
			"pane_changed",
			"remote_managed_build_rehost_source_changed",
		);
	}
	return {
		kind: "remote",
		agentId,
		panelId: requestedPanelId,
		sourceBinding: { ...binding, stopFence: { ...binding.stopFence } },
		sourceAgent: {
			...agent,
			terminalEnv: agent.terminalEnv ? { ...agent.terminalEnv } : undefined,
			runtimeBinding: { ...binding, stopFence: { ...binding.stopFence } },
		},
		sourceProject: { ...project },
		sourceHost: { ...host },
		sourceTarget: {
			...target,
			hostKeyFingerprints: [...target.hostKeyFingerprints],
		},
		sourcePermissionMode: effectiveAgentPermissionMode(
			agent,
			state.skipPermissions,
		),
		preview: managedBuildRehostPreview({
			location: "ssh",
			providerId: agent.provider,
			conversationId,
			sourceGeneration: sourceGeneration(
				binding.workspaceId,
				binding.sessionId,
				binding.stopFence,
			),
			sourceBuildId: projected?.hostBuildVersion,
			targetBuildId: remote.gatewayBuildId,
		}),
	};
}

async function inspectRemotePaneBuildRehost(
	binding: RemoteHmuxManagedPaneBindingV1,
	requestedPanelId: string,
): Promise<RemotePaneBuildRehostInspection> {
	const identity = binding.conversationIdentity;
	if (
		!binding.stopFence ||
		!identity ||
		identity.sessionId !== binding.sessionId ||
		identity.workspaceId !== binding.workspaceId ||
		!sameHmuxManagedGeneration(binding.stopFence, identity)
	) {
		throw new PaneCommandError(
			"invalid_request",
			"conversation_identity_required",
		);
	}
	const state = useStore.getState();
	const host = state.sshHosts.find(
		(candidate) => candidate.id === binding.hostId,
	);
	if (!host) {
		throw new PaneCommandError(
			"invalid_request",
			"remote managed SSH host is unavailable",
		);
	}
	const resolved = await resolvePaneReference(
		binding.sessionId,
		requestedPanelId,
	);
	const panel = resolved.api.getPanel(resolved.panelId);
	if (!panel) throw new PaneCommandError("pane_not_found", "pane disappeared");
	const paneBinding = bindingFromPane(
		dockPanelReference(panel),
		state.agents,
		state.projects,
	);
	if (!sameRemotePaneBinding(paneBinding, binding)) {
		throw new PaneCommandError(
			"pane_changed",
			"remote managed pane binding changed",
		);
	}
	const cwd = resolved.cwd?.trim();
	if (!cwd) {
		throw new PaneCommandError(
			"invalid_request",
			"remote managed pane working directory is unavailable",
		);
	}
	const attached =
		state.hmuxSessionMetadata[
			hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)
		];
	if (
		!attached ||
		attached.sessionId !== binding.sessionId ||
		attached.workspaceId !== binding.workspaceId ||
		attached.sessionClass !== "managed" ||
		!sameHmuxManagedGeneration(attached.stopFence, binding.stopFence) ||
		!attached.hostBuildVersion
	) {
		throw new PaneCommandError(
			"pane_changed",
			"remote_managed_build_rehost_source_changed",
		);
	}
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target = planRemoteHmuxCatalogTarget(state.sshHosts, host.id, trust);
	const catalog = await remoteHmuxCatalog(target);
	const remote = exactRemoteCatalogSession(catalog, binding);
	if (
		remote?.sessionClass !== "managed" ||
		remote.lifecycle !== "ready" ||
		remote.providerId !== identity.providerId ||
		!remote.gatewayBuildId ||
		!sameHmuxManagedGeneration(binding.stopFence, remote)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"remote_managed_build_rehost_source_changed",
		);
	}
	return {
		kind: "remote_pane",
		panelId: resolved.panelId,
		sourceBinding: {
			...binding,
			stopFence: { ...binding.stopFence },
			conversationIdentity: { ...identity },
		},
		sourceHost: { ...host },
		sourceTarget: {
			...target,
			hostKeyFingerprints: [...target.hostKeyFingerprints],
		},
		sourceProviderId: identity.providerId,
		sourceConversationId: identity.conversationId,
		sourceCwd: cwd,
		preview: managedBuildRehostPreview({
			location: "ssh",
			providerId: identity.providerId,
			conversationId: identity.conversationId,
			sourceGeneration: sourceGeneration(
				binding.workspaceId,
				binding.sessionId,
				binding.stopFence,
			),
			sourceBuildId: attached.hostBuildVersion,
			targetBuildId: remote.gatewayBuildId,
		}),
	};
}

async function inspectRemoteBuildRehost(
	source: string | RemoteHmuxManagedPaneBindingV1,
	panelId: string,
): Promise<RemoteBuildRehostInspection> {
	if (typeof source !== "string") {
		if (source.runtime !== "hmux_managed_v1" || source.source !== "ssh") {
			throw new PaneCommandError(
				"invalid_request",
				"remote_managed_build_rehost_source_required",
			);
		}
		return inspectRemotePaneBuildRehost(source, panelId);
	}
	const agentId = source;
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		managedAgentBuildRehostSource(agent) !== agentId ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "ssh"
	) {
		throw new PaneCommandError(
			"invalid_request",
			"native_managed_rehost_source_required",
		);
	}
	return inspectRemoteManagedBuildRehost(agentId, panelId);
}

async function executeRemotePaneBuildRehost(
	confirmed: RemotePaneBuildRehostInspection,
): Promise<void> {
	const binding = confirmed.sourceBinding;
	const stopFence = binding.stopFence;
	if (!stopFence) {
		throw new PaneCommandError(
			"pane_changed",
			"remote managed pane source fence changed",
		);
	}
	const execution = await executeRemoteManagedRehostBroker({
		purpose: "build_rehost",
		target: confirmed.sourceTarget,
		binding,
		providerId: confirmed.sourceProviderId,
		conversationId: confirmed.sourceConversationId,
		permissionMode: "default",
		cwd: confirmed.sourceCwd,
		terminalEnvironment: {},
		targetCredentialId: binding.credentialId,
		targetCredentialProfileDirectory: binding.credentialProfileDirectory,
		expectedTargetBuildId: confirmed.preview.targetBuildId,
		prepareInitiate: async () => {
			await requireIndependentProviderConversationInput(
				{
					provider: confirmed.sourceProviderId,
					conversationId: confirmed.sourceConversationId,
					executionLocation: "ssh",
					hostId: binding.hostId,
				},
				[confirmed.sourceHost],
			);
			const resolved = await resolvePaneReference(
				binding.sessionId,
				confirmed.panelId,
			);
			const panel = resolved.api.getPanel(resolved.panelId);
			if (!panel) {
				throw new PaneCommandError("pane_not_found", "pane disappeared");
			}
			const state = useStore.getState();
			const liveBinding = bindingFromPane(
				dockPanelReference(panel),
				state.agents,
				state.projects,
			);
			if (!sameRemotePaneBinding(liveBinding, binding)) {
				throw new PaneCommandError(
					"pane_changed",
					"remote managed pane binding changed before rehost admission",
				);
			}
		},
	});
	await repairRemotePaneBuildRehost(
		binding,
		confirmed.panelId,
		confirmed.sourceCwd,
		execution,
	);
}

async function repairRemotePaneBuildRehost(
	binding: RemoteHmuxManagedPaneBindingV1,
	panelId: string,
	sourceCwd: string | undefined,
	execution: RemoteManagedRehostBrokerReceipt,
): Promise<void> {
	try {
		const latestResolved = await resolvePaneById(panelId);
		const latestPanel = latestResolved.api.getPanel(latestResolved.panelId);
		if (!latestPanel) return;
		const latestPane = dockPanelReference(latestPanel);
		const latestParams = latestPane.params;
		const latestState = useStore.getState();
		const latestBinding = bindingFromPane(
			latestPane,
			latestState.agents,
			latestState.projects,
		);
		if (
			latestBinding?.runtime !== "hmux_managed_v1" ||
			latestBinding.source !== "ssh"
		) {
			return;
		}
		const sourceMatches = sameRemotePaneRuntime(latestBinding, binding);
		const targetMatches = sameRemotePaneRuntime(
			latestBinding,
			execution.replacementBinding,
		);
		if (!sourceMatches && !targetMatches) return;
		const replacementBinding = remoteHmuxManagedBinding(
			execution.replacementBinding.sessionId,
			execution.replacementBinding.workspaceId,
			latestBinding.hostId,
			latestBinding.commandBridgeNonce,
			execution.replacementBinding.createIdempotencyKey,
			execution.replacementBinding.stopFence,
			execution.replacementBinding.credentialId,
			execution.replacementBinding.credentialProfileDirectory,
			execution.replacementBinding.backendProfileId ??
				latestBinding.backendProfileId,
		);
		const agentPanel = latestPane.component === "agent";
		if (
			!agentPanel &&
			!sameRemoteManagedBinding(latestBinding, replacementBinding)
		) {
			latestPanel.api.updateParameters({
				...latestParams,
				sessionId: replacementBinding.sessionId,
				binding: replacementBinding,
			});
		}
		const cwd =
			sourceCwd?.trim() ||
			useStore.getState().sessionCwd[binding.sessionId]?.trim();
		if (cwd)
			useStore.setState((current) => {
				const sessionCwd = { ...current.sessionCwd };
				delete sessionCwd[binding.sessionId];
				sessionCwd[replacementBinding.sessionId] = cwd;
				return { sessionCwd };
			});
		if (!agentPanel) {
			useStore
				.getState()
				.saveLayout(latestResolved.desktopId, latestResolved.api.toJSON());
		}
	} catch {
		// The Host journal is canonical; pane repair remains presentation-only.
	}
}

async function reconcileRemotePaneBuildRehost(
	binding: RemoteHmuxManagedPaneBindingV1,
	panelId: string,
): Promise<boolean> {
	const state = useStore.getState();
	const host = state.sshHosts.find(
		(candidate) => candidate.id === binding.hostId,
	);
	if (!host) return false;
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target = planRemoteHmuxCatalogTarget(state.sshHosts, host.id, trust);
	const execution = await reconcileRemoteManagedRehostBroker({
		purpose: "build_rehost",
		target,
		binding,
		providerId: binding.conversationIdentity?.providerId,
		targetCredentialId: binding.credentialId,
		targetCredentialProfileDirectory: binding.credentialProfileDirectory,
	});
	if (!execution) return false;
	await repairRemotePaneBuildRehost(
		binding,
		panelId,
		state.sessionCwd[binding.sessionId],
		execution,
	);
	return true;
}

async function executeRemoteBuildRehost(
	confirmed: RemoteBuildRehostInspection,
): Promise<void> {
	if (confirmed.kind === "remote_pane") {
		await executeRemotePaneBuildRehost(confirmed);
		return;
	}
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === confirmed.agentId);
	if (managedAgentBuildRehostSource(agent) !== confirmed.agentId) {
		throw new PaneCommandError(
			"invalid_request",
			"native_managed_rehost_source_required",
		);
	}
	await requestRemoteManagedBuildRehost(confirmed.agentId, confirmed.panelId, {
		expectedTargetBuildId: confirmed.preview.targetBuildId,
		expectedCatalogTarget: confirmed.sourceTarget,
	});
}

/** Execute one user-requested build rehost. Local Agent panes delegate to the
 * same receipt transaction as the CLI; SSH sources retain their remote broker. */
export async function rehostManagedBuild(
	source: string | RemoteHmuxManagedPaneBindingV1,
	panelId: string,
): Promise<void> {
	if (typeof source === "string") {
		const agent = useStore
			.getState()
			.agents.find((candidate) => candidate.id === source);
		const binding = agent?.runtimeBinding;
		if (
			managedAgentBuildRehostSource(agent) !== source ||
			binding?.runtime !== "hmux_managed_v1"
		) {
			throw new PaneCommandError(
				"invalid_request",
				"native_managed_rehost_source_required",
			);
		}
		if (binding.source === "local") {
			const result = await runManagedAgentRehostTransaction({
				name: source,
				panelId,
				confirmed: true,
			});
			if (result.state === "confirmation_required") {
				throw new PaneCommandError(
					"invalid_request",
					"managed rehost confirmation was not carried to the transaction",
				);
			}
			return;
		}
		await executeRemoteBuildRehost(
			await inspectRemoteBuildRehost(source, panelId),
		);
		return;
	}
	if (await reconcileRemotePaneBuildRehost(source, panelId)) return;
	await executeRemoteBuildRehost(
		await inspectRemoteBuildRehost(source, panelId),
	);
}

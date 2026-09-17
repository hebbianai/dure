import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { requireIndependentProviderConversationInputForAgent } from "@/lib/agents/providerConversationInputAuthority";
import { remoteAccountDir } from "@/lib/agents/providers";
import { preflightRemoteAccountLaunch } from "@/lib/agents/remoteAccountOverlay";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogTargetV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import type { HmuxManagedIdleReplacementGuardV1 } from "@/lib/ipc";
import {
	remoteHmuxKnownHostTrust,
	remoteHmuxManagedRehost,
	remoteHmuxManagedRehostReconcile,
} from "@/lib/ipc";
import { commitManagedAgentCheckpointBinding } from "@/lib/sessions/managed/managedAgentCheckpointBinding";
import { shortManagedRuntimeDigest } from "@/lib/sessions/managed/managedAgentRuntimeState";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import {
	commitRemoteManagedAgentNativeRehost,
	resolveRemoteManagedAgentRehostRoute,
} from "@/lib/sessions/managed/remoteManagedAgentRehostCommit";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import { getHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import {
	type RemoteHmuxManagedPaneBindingV1,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import {
	resolveNamedAgentPaneSelection,
	revalidateAgentPaneSelection,
} from "@/lib/workspace/pane/agentPaneSelection";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { AccountProfile, Agent, HmuxManagedStopFenceV1 } from "@/types";

const REMOTE_REHOST_ROWS = 24;
const REMOTE_REHOST_COLUMNS = 80;

function mountedSourcePane(agentId: string, panelId?: string) {
	const panes = agentPaneLocations({}, mountedDockviewEntries()).filter(
		(pane) =>
			pane.agentId === agentId && (!panelId || pane.panelId === panelId),
	);
	return panes.length === 1 ? panes[0] : undefined;
}

type FencedRemoteManagedBinding = RemoteHmuxManagedPaneBindingV1 & {
	stopFence: NonNullable<RemoteHmuxManagedPaneBindingV1["stopFence"]>;
};

type RemoteManagedRehostAction =
	| { kind: "credential_switch" }
	| { kind: "build_rehost" };

type RemoteManagedRehostPurpose = RemoteManagedRehostAction["kind"];

function isCredentialReplacement(purpose: RemoteManagedRehostPurpose): boolean {
	return purpose === "credential_switch";
}

function operationId(
	agentId: string,
	binding: RemoteHmuxManagedPaneBindingV1,
	conversationId: string | undefined,
	targetCredentialId: string | null,
	purpose: RemoteManagedRehostPurpose,
	idleReplacementGuard?: HmuxManagedIdleReplacementGuardV1,
	expectedTargetBuildId?: string,
): string {
	const fence = binding.stopFence;
	const seed = [
		purpose === "credential_switch"
			? "remote-managed-credential-switch-v1"
			: idleReplacementGuard
				? "remote-managed-build-rehost-idle-guard-v1"
				: "remote-managed-build-rehost-v1",
		agentId,
		binding.hostId,
		binding.workspaceId,
		binding.sessionId,
		fence?.runnerPrincipal ?? "",
		fence?.runnerInstance ?? "",
		fence?.channelEpoch ?? "",
		fence?.hostInstanceId ?? "",
		fence?.terminalEpoch ?? "",
		conversationId,
		targetCredentialId ?? "runtime-default",
		idleReplacementGuard?.runtimeRevision ?? "",
		idleReplacementGuard?.outputSequence ?? "",
		idleReplacementGuard?.providerId ?? "",
		idleReplacementGuard?.conversationId ?? "",
		expectedTargetBuildId ?? "",
	].join("\0");
	const prefix =
		purpose === "credential_switch" ? "remote_switch" : "remote_rehost";
	return `${prefix}_${shortManagedRuntimeDigest(seed)}${shortManagedRuntimeDigest(`receipt\0${seed}`)}`;
}

function targetAccount(
	agent: Agent,
	targetCredentialId: string | null,
): AccountProfile | undefined {
	if (!targetCredentialId) return undefined;
	return useStore
		.getState()
		.accounts.find(
			(account) =>
				account.id === targetCredentialId &&
				account.provider === agent.provider,
		);
}

function remoteLaunchReferenceNeedsBackendProof(
	launchReference: string | undefined,
	targetCredentialId: string | null,
	targetCredentialProfileDirectory: string | undefined,
): boolean {
	if (targetCredentialId === null) {
		if (launchReference !== undefined) {
			throw new Error("remote_hmux_managed_rehost_launch_reference_conflict");
		}
		return false;
	}
	const legacyDirectoryReference = targetCredentialProfileDirectory
		?.split("/")
		.pop();
	return (
		launchReference !== targetCredentialId &&
		launchReference !== legacyDirectoryReference
	);
}

function remoteManagedSourceIsIdleOrRecovering(agent: Agent): boolean {
	const state = useStore.getState();
	const runtime = state.sessionAgentRuntimeState[agent.sessionId];
	return (
		runtime?.lifecycle === "exited" ||
		(runtime?.lifecycle === "running" &&
			runtime.activity === "waiting" &&
			runtime.attention !== "approval_required" &&
			state.agentActivity[agent.id] !== "working")
	);
}

function assertRemoteManagedSourceAdmission(agent: Agent): void {
	if (!remoteManagedSourceIsIdleOrRecovering(agent)) {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_credential_switch_requires_idle_turn",
		);
	}
}

function freshRemoteSourceGuard(
	agent: Agent,
	binding: FencedRemoteManagedBinding,
	paneHealthId: string,
) {
	const runtime = useStore.getState().sessionAgentRuntimeState[agent.sessionId];
	const health = getHmuxPaneHealth(paneHealthId);
	if (
		managedConversationId(agent) ||
		agent.pendingCredentialSwitch ||
		runtime?.lifecycle !== "running" ||
		runtime.activity !== "waiting" ||
		runtime.turnCompletedCount !== "0" ||
		runtime.terminalEpoch !== binding.stopFence.terminalEpoch ||
		health?.state !== "live" ||
		health.terminalEpoch !== runtime.terminalEpoch ||
		!health.receivedSequence ||
		health.receivedSequence !== health.presentedSequence
	) {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_credential_switch_fresh_state_unverified",
		);
	}
	return {
		runtimeRevision: runtime.revision,
		outputSequence: health.receivedSequence,
	};
}

/** Switch one remote managed provider using the remote runtime's journal-first
 * exact rehost broker. No source stop happens until provider/profile preflight
 * and the complete replacement payload are durable on that SSH account. */
async function requestRemoteManagedRehost(
	agentId: string,
	targetCredentialId: string | null,
	requestedPanelId: string | undefined,
	action: RemoteManagedRehostAction,
	idleReplacementGuard?: HmuxManagedIdleReplacementGuardV1,
	expectedTargetBuildId?: string,
	expectedCatalogTarget?: RemoteHmuxCatalogTargetV1,
): Promise<{ conversationId: string | null }> {
	const purpose = action.kind;
	const initial = useStore.getState();
	const agent = initial.agents.find((candidate) => candidate.id === agentId);
	const agentBinding = agent?.runtimeBinding;
	if (
		!agent ||
		agentBinding?.runtime !== "hmux_managed_v1" ||
		agentBinding.source !== "ssh" ||
		!agentBinding.stopFence
	) {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_credential_switch_source_fence_required",
		);
	}
	const exactAgentBinding: FencedRemoteManagedBinding = {
		...agentBinding,
		stopFence: agentBinding.stopFence,
	};
	const conversationId = managedConversationId(agent);
	if (!conversationId && purpose !== "credential_switch") {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_credential_switch_conversation_required",
		);
	}
	const account = targetAccount(agent, targetCredentialId);
	const project = initial.projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	const host = initial.sshHosts.find(
		(candidate) => candidate.id === agentBinding.hostId,
	);
	if (!project || project.sshHostId !== agentBinding.hostId || !host) {
		throw new PaneCommandError(
			"invalid_request",
			"remote managed project or SSH host is unavailable",
		);
	}
	const backendRouteAuthority = await resolveRemoteManagedAgentRehostRoute(
		agent,
		project,
		initial.sshHosts,
	);
	if (!conversationId && backendRouteAuthority) {
		throw new Error("remote_managed_credential_switch_conversation_required");
	}
	const sourcePermissionMode = effectiveAgentPermissionMode(
		agent,
		initial.skipPermissions,
	);
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target = planRemoteHmuxCatalogTarget(initial.sshHosts, host.id, trust);
	if (
		expectedCatalogTarget &&
		JSON.stringify(target) !== JSON.stringify(expectedCatalogTarget)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"remote managed SSH target changed after confirmation",
		);
	}
	const sourceBinding = exactAgentBinding;
	const rehostOperationId = operationId(
		agent.id,
		sourceBinding,
		conversationId,
		targetCredentialId,
		purpose,
		idleReplacementGuard,
		expectedTargetBuildId,
	);
	let reconcileRequest = {
		target,
		operationId: rehostOperationId,
		sourceSessionId: sourceBinding.sessionId,
		sourceWorkspaceId: sourceBinding.workspaceId,
		sourceFence: sourceBinding.stopFence,
		providerId: agent.provider,
		conversationId: conversationId ?? null,
		bridgeNonce: sourceBinding.commandBridgeNonce,
	} as const;
	let receipt: Awaited<ReturnType<typeof remoteHmuxManagedRehostReconcile>> =
		null;
	// ponytail: at most 16 refused attempts; use a backend attempt cursor if this grows.
	for (let attempt = 0; ; attempt += 1) {
		try {
			receipt = await remoteHmuxManagedRehostReconcile(reconcileRequest);
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				attempt === 16 ||
				!message.startsWith("hmux_remote_managed_rehost_precondition_refused:")
			)
				throw error;
			reconcileRequest = {
				...reconcileRequest,
				operationId: `${rehostOperationId}_retry_${attempt + 1}`,
			};
		}
	}
	const targetCredentialProfileDirectory =
		purpose === "build_rehost"
			? (sourceBinding.credentialProfileDirectory ??
				(account ? remoteAccountDir(account) : undefined))
			: account
				? remoteAccountDir(account)
				: undefined;
	if (!receipt) {
		const selection = resolveNamedAgentPaneSelection(
			agent.id,
			requestedPanelId,
		);
		const selectedPanelId =
			selection.kind === "pane" ? selection.panelId : undefined;
		const freshPane = !conversationId
			? mountedSourcePane(agent.id, selectedPanelId)
			: undefined;
		const sourcePaneHealthId = freshPane
			? hmuxPaneHealthId(freshPane.desktopId, freshPane.panelId)
			: "";
		if (
			purpose === "credential_switch" &&
			(sourceBinding.credentialId ?? agent.credentialId ?? null) ===
				targetCredentialId
		) {
			throw new PaneCommandError(
				"invalid_request",
				"credential_selection_unchanged",
			);
		}
		assertRemoteManagedSourceAdmission(agent);
		if (!conversationId)
			freshRemoteSourceGuard(agent, sourceBinding, sourcePaneHealthId);
		if (conversationId) {
			await requireIndependentProviderConversationInputForAgent(
				agent,
				initial.projects,
				initial.sshHosts,
			);
		}
		if (
			targetCredentialId &&
			!account &&
			!(purpose === "build_rehost" && targetCredentialProfileDirectory)
		) {
			throw new PaneCommandError(
				"invalid_request",
				"credential_reference_unavailable",
			);
		}
		if (isCredentialReplacement(purpose) || !targetCredentialProfileDirectory) {
			await preflightRemoteAccountLaunch(
				host,
				agent.provider,
				agent.worktreePath,
				account,
				{ requireCredential: true },
			);
		}
		const preflighted = useStore.getState();
		const currentAgent = preflighted.agents.find(
			(candidate) => candidate.id === agent.id,
		);
		const currentProject = preflighted.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const currentHost = preflighted.sshHosts.find(
			(candidate) => candidate.id === sourceBinding.hostId,
		);
		if (
			!currentAgent ||
			!sameManagedCreateSource(currentAgent, agent) ||
			managedConversationId(currentAgent) !== conversationId ||
			currentProject?.sshHostId !== sourceBinding.hostId ||
			JSON.stringify(currentHost) !== JSON.stringify(host) ||
			(isCredentialReplacement(purpose) &&
				targetCredentialId !== null &&
				targetAccount(currentAgent, targetCredentialId)?.dir !==
					account?.dir) ||
			effectiveAgentPermissionMode(
				currentAgent,
				preflighted.skipPermissions,
			) !== sourcePermissionMode
		) {
			throw new PaneCommandError(
				"pane_changed",
				"remote managed source changed during credential preflight",
			);
		}
		assertRemoteManagedSourceAdmission(currentAgent);
		const freshSourceGuard = conversationId
			? undefined
			: freshRemoteSourceGuard(currentAgent, sourceBinding, sourcePaneHealthId);
		revalidateAgentPaneSelection(selection);
		// A new pane-scoped command retains its recipient across preflight. An
		// accepted journal receipt above needs no surviving presentation.
		const sourcePane =
			purpose === "build_rehost"
				? mountedSourcePane(agent.id, selectedPanelId)
				: undefined;
		const sourceOwnerId = sourcePane
			? hmuxPaneOwnerId(
					getCurrentWebviewWindow().label,
					sourcePane.desktopId,
					sourcePane.panelId,
				)
			: undefined;
		try {
			receipt = await remoteHmuxManagedRehost({
				...reconcileRequest,
				...(freshSourceGuard ? { freshSourceGuard } : {}),
				permissionMode: sourcePermissionMode,
				cwd: agent.worktreePath,
				initialRows: REMOTE_REHOST_ROWS,
				initialColumns: REMOTE_REHOST_COLUMNS,
				terminalEnvironment: currentAgent.terminalEnv ?? {},
				...(idleReplacementGuard ? { idleReplacementGuard } : {}),
				...(expectedTargetBuildId ? { expectedTargetBuildId } : {}),
				...(sourceOwnerId ? { sourceOwnerId } : {}),
				...(targetCredentialId && targetCredentialProfileDirectory
					? {
							targetCredentialId,
							targetCredentialProfileDirectory,
						}
					: {}),
			});
		} catch (error) {
			try {
				receipt = await remoteHmuxManagedRehostReconcile(reconcileRequest);
			} catch {
				throw error;
			}
			if (!receipt) throw error;
		}
	}
	if (receipt.conversationId !== (conversationId ?? null)) {
		throw new Error("remote_hmux_managed_rehost_conversation_conflict");
	}
	const replacementFence: HmuxManagedStopFenceV1 = {
		runnerPrincipal: receipt.replacement.runnerPrincipal,
		runnerInstance: receipt.replacement.runnerInstance,
		channelEpoch: receipt.replacement.channelEpoch,
		hostInstanceId: receipt.replacement.hostInstanceId,
		terminalEpoch: receipt.replacement.terminalEpoch,
	};
	const launchReferenceNeedsBackendProof =
		remoteLaunchReferenceNeedsBackendProof(
			receipt.launchReference,
			targetCredentialId,
			targetCredentialProfileDirectory,
		);
	if (launchReferenceNeedsBackendProof && !backendRouteAuthority) {
		throw new Error("remote_hmux_managed_rehost_launch_reference_conflict");
	}
	const replacementCredentialProfileDirectory =
		targetCredentialId === null ? undefined : targetCredentialProfileDirectory;
	const replacementBinding = remoteHmuxManagedBinding(
		receipt.replacement.sessionId,
		receipt.replacement.workspaceId,
		sourceBinding.hostId,
		sourceBinding.commandBridgeNonce,
		receipt.replacement.idempotencyKey,
		replacementFence,
		targetCredentialId ?? undefined,
		replacementCredentialProfileDirectory,
		sourceBinding.backendProfileId,
	);
	const agentMetadataMatches = (candidate: Agent | undefined) =>
		candidate?.id === agent.id &&
		candidate.projectId === agent.projectId &&
		candidate.provider === agent.provider &&
		candidate.worktreePath === agent.worktreePath &&
		managedConversationId(candidate) === conversationId;
	const agentIsSource = (candidate: Agent | undefined) =>
		agentMetadataMatches(candidate) &&
		candidate?.sessionId === sourceBinding.sessionId &&
		sameRemoteManagedBinding(candidate.runtimeBinding, sourceBinding);
	const agentIsTarget = (candidate: Agent | undefined) =>
		agentMetadataMatches(candidate) &&
		candidate?.sessionId === replacementBinding.sessionId &&
		sameRemoteManagedBinding(candidate.runtimeBinding, replacementBinding);
	if (!agentIsSource(agent) && !agentIsTarget(agent)) {
		throw new PaneCommandError(
			"pane_changed",
			"remote managed Agent authority changed before backend commit",
		);
	}
	const backendReceipt =
		backendRouteAuthority && receipt.conversationId !== null
			? await commitRemoteManagedAgentNativeRehost({
					agent,
					operationId: rehostOperationId,
					sourceBinding: {
						...sourceBinding,
						stopFence: sourceBinding.stopFence,
					},
					targetBinding: {
						...replacementBinding,
						stopFence: replacementFence,
					},
					targetCredentialId,
					targetCredentialProfileDirectory:
						replacementCredentialProfileDirectory,
					providerConversationRef: receipt.conversationId,
					routeAuthority: backendRouteAuthority,
				})
			: undefined;
	if (launchReferenceNeedsBackendProof && !backendReceipt) {
		throw new Error("remote_hmux_managed_rehost_launch_reference_conflict");
	}
	if (backendRouteAuthority && !backendReceipt) {
		await commitManagedAgentCheckpointBinding(
			backendRouteAuthority,
			agent.id,
			replacementBinding,
		);
	}
	let committed = false;
	useStore.setState((current) => {
		const candidate = current.agents.find((item) => item.id === agent.id);
		if (!agentIsSource(candidate) && !agentIsTarget(candidate)) {
			return {};
		}
		committed = true;
		const sessionCwd = { ...current.sessionCwd };
		delete sessionCwd[sourceBinding.sessionId];
		sessionCwd[replacementBinding.sessionId] = agent.worktreePath;
		return {
			agents: current.agents.map((item) =>
				item.id === agent.id
					? {
							...item,
							...(backendReceipt
								? {
										executionProfile: backendReceipt.executionProfile,
										skipPermissions:
											backendReceipt.launchSelection.permissionMode ===
											"skip_permissions",
									}
								: {}),
							sessionId: replacementBinding.sessionId,
							runtimeBinding: replacementBinding,
							accountId: targetCredentialId,
							credentialId: targetCredentialId ?? undefined,
							pendingCredentialSwitch: undefined,
							pendingCmd: undefined,
							started: true,
						}
					: item,
			),
			sessionCwd,
		};
	});
	if (!committed) {
		throw new PaneCommandError(
			"pane_changed",
			"remote managed replacement completed but local source CAS changed",
		);
	}
	useStore.getState().setAgentActivity(agent.id, "connecting");
	return { conversationId: conversationId ?? null };
}

export async function requestRemoteManagedCredentialSwitch(
	agentId: string,
	targetCredentialId: string | null,
	requestedPanelId?: string,
): Promise<{ conversationId: string | null }> {
	return requestRemoteManagedRehost(
		agentId,
		targetCredentialId,
		requestedPanelId,
		{ kind: "credential_switch" },
	);
}

/** Replaces an old remote Host with the gateway's current runtime while
 * preserving the exact provider conversation and credential locus. The same
 * journal-first broker and local source CAS used by credential switching own
 * the destructive boundary. */
export async function requestRemoteManagedBuildRehost(
	agentId: string,
	requestedPanelId?: string,
	options?: {
		idleReplacementGuard?: HmuxManagedIdleReplacementGuardV1;
		expectedTargetBuildId?: string;
		expectedCatalogTarget?: RemoteHmuxCatalogTargetV1;
	},
): Promise<{ conversationId: string }> {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "ssh"
	) {
		throw new PaneCommandError(
			"invalid_request",
			"remote_managed_build_rehost_source_required",
		);
	}
	const result = await requestRemoteManagedRehost(
		agentId,
		binding.credentialId ?? null,
		requestedPanelId,
		{ kind: "build_rehost" },
		options?.idleReplacementGuard,
		options?.expectedTargetBuildId,
		options?.expectedCatalogTarget,
	);
	if (result.conversationId === null) {
		throw new Error("remote_managed_credential_switch_conversation_required");
	}
	return { conversationId: result.conversationId };
}

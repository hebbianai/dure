import { effectiveAgentSkipPermissions } from "@/lib/agents/agentPermissionMode";
import { computePromptIdentity } from "@/lib/agents/promptIdentity";
import {
	agentAccount,
	providerRunCmd,
	remoteAccountDir,
} from "@/lib/agents/providers";
import { preflightRemoteAccountLaunch } from "@/lib/agents/remoteAccountOverlay";
import {
	sameProjectOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import {
	assertNeverManagedCreateAdvanceResolution,
	ManagedCreateRejectedError,
	ManagedCreateRetrySameError,
} from "@/lib/hmux/managed/managedCreateResolution";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxManagedCreateReceiptV1,
	type RemoteManagedLaunchOptions,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	remoteHmuxKnownHostTrust,
	remoteHmuxManagedCreateAdvance,
} from "@/lib/ipc";
import {
	remoteManagedAgentLifecycleKey,
	withRemoteManagedAgentLifecycle,
} from "@/lib/sessions/launch/remoteManagedAgentLifecycle";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import { managedCreateSuccessorProjection } from "@/lib/sessions/managed/managedCreateSuccessorProjection";
import { useStore } from "@/store";
import type { Agent, HmuxManagedStopFenceV1 } from "@/types";

export interface RemoteManagedAgentEnsureReceipt {
	readonly agent: Agent;
	readonly stopFence: HmuxManagedStopFenceV1;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly idempotencyKey: string;
	readonly initialPromptAccepted?: boolean;
}

interface InFlightRemoteManagedEnsure {
	readonly launchOptions?: RemoteManagedLaunchOptions;
	readonly initialPrompt?: string;
	readonly operation: Promise<RemoteManagedAgentEnsureReceipt>;
}

const inFlight = new Map<string, InFlightRemoteManagedEnsure>();

/** Creates or reuses the exact remote managed lifetime before TerminalView
 * resolves its complete catalog fence. Provider credentials stay on the SSH
 * host. An explicit resume sends its exact provider-native conversation id;
 * a genuinely fresh create omits the seed and waits for the Host report. */
export async function ensureRemoteManagedAgentRuntime(
	agent: Agent,
	options: {
		columns: number;
		rows: number;
		initialPrompt?: string;
		launchOptions?: RemoteManagedLaunchOptions;
		beforeCreate?: () => void;
	},
): Promise<RemoteManagedAgentEnsureReceipt> {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "ssh") {
		throw new Error("agent is not bound to a remote managed Hmux runtime");
	}
	// A complete generation fence is already sufficient for the remote
	// controller to resolve and attach through the catalog. Re-running managed
	// create here can only replay an old create receipt; if that generation has
	// exited it turns pane remounts into an endless create/attach loop instead of
	// surfacing the exact exited generation to recovery UI.
	if (binding.stopFence) {
		const initialPromptDigest = options.initialPrompt
			? (await computePromptIdentity(options.initialPrompt)).promptDigest
			: undefined;
		return {
			agent,
			stopFence: binding.stopFence,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			idempotencyKey: binding.createIdempotencyKey,
			...(initialPromptDigest &&
			binding.initialPromptDigest === initialPromptDigest
				? { initialPromptAccepted: true }
				: {}),
		};
	}
	return advanceRemoteManagedAgentRuntime(agent, options);
}

/** Explicit launch/resume continues the same Hmux create ledger even when a
 * previous receipt exists. Hmux returns the current Host or its successor. */
export async function advanceRemoteManagedAgentRuntime(
	agent: Agent,
	options: Parameters<typeof ensureRemoteManagedAgentRuntime>[1],
): Promise<RemoteManagedAgentEnsureReceipt> {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "ssh") {
		throw new Error("agent is not bound to a remote managed Hmux runtime");
	}
	useStore.getState().setAgentActivity(agent.id, "connecting");
	const conversationId = agent.conversationId?.trim();
	if (agent.conversationId !== undefined && !conversationId) {
		throw new Error(
			"remote managed onboarding received an invalid explicit conversation id",
		);
	}
	const selectedAccount = agentAccount(agent);
	const credentialId =
		binding.credentialId ?? agent.credentialId ?? selectedAccount?.id;
	const account = credentialId
		? useStore
				.getState()
				.accounts.find(
					(candidate) =>
						candidate.id === credentialId &&
						candidate.provider === agent.provider,
				)
		: undefined;
	const accountProfileDirectory = account
		? remoteAccountDir(account)
		: undefined;
	const credentialProfileDirectory =
		binding.credentialProfileDirectory ?? accountProfileDirectory;
	if (Boolean(credentialId) !== Boolean(credentialProfileDirectory)) {
		throw new Error(
			"remote managed credential reference is missing its exact profile directory",
		);
	}
	const accountMappingIsAuthority =
		binding.credentialProfileDirectory === undefined && account !== undefined;
	const operationKey = [
		remoteManagedAgentLifecycleKey(binding),
		credentialId ?? "runtime-default",
		credentialProfileDirectory ?? "runtime-default-profile",
	].join("\0");
	const existing = inFlight.get(operationKey);
	if (existing) {
		if (
			options.initialPrompt !== undefined &&
			existing.initialPrompt !== undefined &&
			existing.initialPrompt !== options.initialPrompt
		) {
			throw new Error("managed_create_initial_prompt_conflict");
		}
		if (
			options.launchOptions &&
			(!existing.launchOptions ||
				Object.entries(options.launchOptions).some(
					([key, value]) =>
						value !==
						existing.launchOptions?.[key as keyof RemoteManagedLaunchOptions],
				))
		)
			throw new Error("managed_create_launch_options_conflict");
		return await existing.operation;
	}

	const operation = withRemoteManagedAgentLifecycle(binding, async () => {
		const initialState = useStore.getState();
		const initialAgent = initialState.agents.find(
			(candidate) => candidate.id === agent.id,
		);
		const project = initialState.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const host = initialState.sshHosts.find(
			(candidate) => candidate.id === binding.hostId,
		);
		if (
			!sameManagedCreateSource(initialAgent, agent) ||
			!project ||
			!host ||
			project.sshHostId !== host.id
		) {
			throw new Error("remote managed project or SSH host is unavailable");
		}
		await preflightRemoteAccountLaunch(
			host,
			agent.provider,
			agent.worktreePath,
			account,
			{
				requireCredential: true,
				remoteProfileDirectory: credentialProfileDirectory,
			},
		);
		const launchState = useStore.getState();
		const launchAgent = launchState.agents.find(
			(candidate) => candidate.id === agent.id,
		);
		const launchProject = launchState.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const launchHost = launchState.sshHosts.find(
			(candidate) => candidate.id === binding.hostId,
		);
		const launchAccount = account
			? launchState.accounts.find(
					(candidate) =>
						candidate.id === account.id &&
						candidate.provider === agent.provider,
				)
			: undefined;
		if (
			!sameManagedCreateSource(launchAgent, agent) ||
			!sameProjectOperationalIdentity(launchProject, project) ||
			!sameSshHostOperationalIdentity(launchHost, host) ||
			(accountMappingIsAuthority && launchAccount?.dir !== account?.dir)
		) {
			throw new Error("remote managed create source changed during preflight");
		}
		const bypassApprovals = effectiveAgentSkipPermissions(
			agent,
			launchState.skipPermissions,
		);
		const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
		const readyState = useStore.getState();
		const readyAgent = readyState.agents.find(
			(candidate) => candidate.id === agent.id,
		);
		const readyProject = readyState.projects.find(
			(candidate) => candidate.id === agent.projectId,
		);
		const readyHost = readyState.sshHosts.find(
			(candidate) => candidate.id === binding.hostId,
		);
		if (
			!sameManagedCreateSource(readyAgent, agent) ||
			!sameProjectOperationalIdentity(readyProject, project) ||
			!sameSshHostOperationalIdentity(readyHost, host) ||
			effectiveAgentSkipPermissions(agent, readyState.skipPermissions) !==
				bypassApprovals
		) {
			throw new Error("remote managed create source changed before create");
		}
		const target = planRemoteHmuxCatalogTarget(
			readyState.sshHosts,
			host.id,
			trust,
		);
		options.beforeCreate?.();
		const resolution = await remoteHmuxManagedCreateAdvance({
			...(options.launchOptions
				? { launchOptions: options.launchOptions }
				: {}),
			target,
			idempotencyKey: binding.createIdempotencyKey,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			providerId: agent.provider,
			...(conversationId ? { conversationId } : {}),
			permissionMode: bypassApprovals ? "bypass_approvals" : "default",
			bridgeNonce: binding.commandBridgeNonce,
			cwd: agent.worktreePath,
			// Rolling compatibility only. Current backends derive the reviewed
			// provider launch plan and ignore this legacy field.
			command: providerRunCmd(agent.provider, {
				...(conversationId ? { convId: conversationId } : {}),
				skipPermissions: bypassApprovals,
			}),
			...(options.initialPrompt === undefined
				? {}
				: { initialPrompt: options.initialPrompt }),
			initialRows: Math.max(1, Math.min(65_535, options.rows)),
			initialColumns: Math.max(1, Math.min(65_535, options.columns)),
			terminalEnvironment: agent.terminalEnv ?? {},
			...(credentialId && credentialProfileDirectory
				? {
						credentialId,
						credentialProfileDirectory,
					}
				: {}),
		});
		let receipt: RemoteHmuxManagedCreateReceiptV1;
		switch (resolution.state) {
			case "current":
			case "advanced":
				receipt = resolution.receipt;
				break;
			case "retry_same":
				throw new ManagedCreateRetrySameError(
					resolution.reason,
					resolution.code,
					resolution.message,
				);
			case "rejected":
				throw new ManagedCreateRejectedError(
					resolution.code,
					resolution.message,
				);
			default:
				return assertNeverManagedCreateAdvanceResolution(resolution);
		}
		const initialPromptDigest =
			options.initialPrompt && receipt.initialPromptAccepted
				? (await computePromptIdentity(options.initialPrompt)).promptDigest
				: undefined;
		const stopFence = {
			runnerPrincipal: receipt.session.runnerPrincipal,
			runnerInstance: receipt.session.runnerInstance,
			channelEpoch: receipt.session.channelEpoch,
			hostInstanceId: receipt.session.hostInstanceId,
			terminalEpoch: receipt.session.terminalEpoch,
		};
		let committedAgent: Agent | undefined;
		useStore.setState((current) => {
			const candidate = current.agents.find((item) => item.id === agent.id);
			const currentBinding = candidate?.runtimeBinding;
			const currentProject = current.projects.find(
				(projectCandidate) => projectCandidate.id === agent.projectId,
			);
			const currentHost = current.sshHosts.find(
				(hostCandidate) => hostCandidate.id === binding.hostId,
			);
			const currentAccount = account
				? current.accounts.find(
						(accountCandidate) =>
							accountCandidate.id === account.id &&
							accountCandidate.provider === agent.provider,
					)
				: undefined;
			if (
				!candidate ||
				!sameManagedCreateSource(candidate, agent) ||
				currentBinding?.runtime !== "hmux_managed_v1" ||
				currentBinding.source !== "ssh" ||
				!sameProjectOperationalIdentity(currentProject, project) ||
				!sameSshHostOperationalIdentity(currentHost, host) ||
				(accountMappingIsAuthority && currentAccount?.dir !== account?.dir) ||
				effectiveAgentSkipPermissions(agent, current.skipPermissions) !==
					bypassApprovals
			) {
				return {};
			}
			const projection = managedCreateSuccessorProjection(current, candidate, {
				...currentBinding,
				sessionId: receipt.session.sessionId,
				createIdempotencyKey: receipt.idempotencyKey,
				stopFence,
				initialPromptDigest,
				...(credentialId ? { credentialId } : {}),
				...(credentialProfileDirectory ? { credentialProfileDirectory } : {}),
			});
			committedAgent = projection.agents.find(
				(projected) => projected.id === candidate.id,
			);
			return projection;
		});
		if (!committedAgent) {
			throw new ManagedCreateRetrySameError(
				"authority_inconsistent",
				"remote_managed_create_receipt_commit_changed",
				"remote managed create source changed before receipt commit",
			);
		}
		return {
			agent: committedAgent,
			stopFence,
			sessionId: receipt.session.sessionId,
			workspaceId: receipt.session.workspaceId,
			idempotencyKey: receipt.idempotencyKey,
			...(receipt.initialPromptAccepted === true
				? { initialPromptAccepted: true }
				: {}),
		};
	});
	inFlight.set(operationKey, {
		initialPrompt: options.initialPrompt,
		launchOptions: options.launchOptions,
		operation,
	});
	try {
		return await operation;
	} finally {
		if (inFlight.get(operationKey)?.operation === operation) {
			inFlight.delete(operationKey);
		}
	}
}

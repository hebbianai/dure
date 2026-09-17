import { nanoid } from "nanoid";
import {
	buildInitialAgentRegistration,
	resolveAgentLaunchCredential,
} from "@/lib/agents/agentLaunchCredential";
import {
	launchAgentRegistrationEvidence,
	rollbackCreatedAgentRegistration,
} from "@/lib/agents/agentRegistrationRollback";
import {
	ProviderExplicitResumeUnsupportedError,
	providerSupportsExplicitResume,
} from "@/lib/agents/providers";
import { normalizeSlashPath } from "@/lib/files/paths";
import { isDureProviderConversationRefV1 } from "@/lib/ipc/dureProtocolIdentity";
import {
	advanceRemoteManagedAgentRuntime,
	ensureRemoteManagedAgentRuntime,
} from "@/lib/sessions/launch/remoteManagedAgentRuntime";
import {
	launchPreparedManagedConversationPane,
	ManagedConversationAlreadyActiveError,
} from "@/lib/sessions/managed/managedConversationLaunch";
import { resolveManagedConversationOwnership } from "@/lib/sessions/managed/managedConversationOwnership";
import { admitManagedCreateRegistration } from "@/lib/sessions/managed/managedCreateRegistrationAdmission";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import { openAgentPanel } from "@/lib/workspace/dock";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import type { Agent, Project, Provider } from "@/types";

const REMOTE_BOOTSTRAP_GEOMETRY = { columns: 120, rows: 30 } as const;
const remoteLaunches = new Map<string, Promise<Agent>>();

interface RemoteConversationState {
	agents: readonly Agent[];
	projects: readonly Project[];
}

function nextConversationName(
	agents: readonly Pick<Agent, "name" | "projectId">[],
	projectId: string,
	provider: Provider,
): string {
	const names = new Set(
		agents
			.filter((agent) => agent.projectId === projectId)
			.map((agent) => agent.name),
	);
	const base = `${provider}-resume`;
	let name = base;
	for (let suffix = 2; names.has(name); suffix += 1) name = `${base}-${suffix}`;
	return name;
}

function agentExecutionHost(
	agent: Agent,
	projects: readonly Project[],
): string | undefined {
	const binding = agent.runtimeBinding;
	if (binding) return binding.source === "ssh" ? binding.hostId : undefined;
	const project = projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	return project?.kind === "ssh" ? project.sshHostId : undefined;
}

function exactRemoteConversationOwner(
	state: RemoteConversationState,
	input: { provider: Provider; conversationId: string; hostId: string },
	excludeAgentId?: string,
): Agent | undefined {
	const candidates = state.agents.filter(
		(candidate) =>
			candidate.id !== excludeAgentId &&
			candidate.provider === input.provider &&
			candidate.conversationId?.trim() === input.conversationId &&
			agentExecutionHost(candidate, state.projects) === input.hostId,
	);
	if (candidates.length > 1) {
		throw new Error("remote_conversation_owner_ambiguous");
	}
	return candidates[0];
}

async function resumeRemoteConversationOwner(
	agent: Agent,
	desktopId: string,
): Promise<Agent> {
	// A history action explicitly continues this create ledger. Client activity
	// cannot distinguish a live Host from a lost reply or an exited generation.
	const { agent: resumed } = await advanceRemoteManagedAgentRuntime(
		agent,
		REMOTE_BOOTSTRAP_GEOMETRY,
	);
	const state = useStore.getState();
	const existing = agentPaneLocations(
		state.layouts,
		mountedDockviewEntries(),
	).find((pane) => pane.agentId === resumed.id);
	if (existing) {
		navigateToPanel(existing.desktopId, existing.panelId);
		return resumed;
	}
	if (!openAgentPanel(desktopId, resumed)) {
		throw new Error("managed conversation target desktop is not mounted");
	}
	return resumed;
}

/** Open an exact provider-native conversation whose local folder has not yet
 * been registered in Dure. The click is the user's explicit path selection:
 * create/reuse only that Project, register one managed Hmux Agent, then mount
 * the pane on the current desktop. No import desktop or seed Agent is created. */
export async function launchDiscoveredLocalConversationPane(input: {
	provider: Provider;
	conversationId: string;
	cwd: string;
	workspaceRoot: string;
	desktopId: string;
	existingOwner?: "reject" | "return";
	position?: PanelPosition;
}): Promise<Agent> {
	const conversationId = input.conversationId.trim();
	const cwd = normalizeSlashPath(input.cwd.trim());
	const workspaceRoot = normalizeSlashPath(input.workspaceRoot.trim());
	const desktopId = input.desktopId.trim();
	if (!isDureProviderConversationRefV1(conversationId)) {
		throw new Error("invalid_conversation_identity");
	}
	if (!providerSupportsExplicitResume(input.provider)) {
		throw new ProviderExplicitResumeUnsupportedError(input.provider);
	}
	if (!input.cwd.trim() || !input.workspaceRoot.trim()) {
		throw new Error("discovered conversation workspace is required");
	}
	if (!desktopId)
		throw new Error("managed conversation target desktop is required");

	const ownership = await resolveManagedConversationOwnership({
		providerId: input.provider,
		conversationId,
	});
	if (ownership.state === "active") {
		if (input.existingOwner === "return") return ownership.agent;
		throw new ManagedConversationAlreadyActiveError(ownership.agent.id);
	}

	if (ownership.state === "pending") {
		return launchPreparedManagedConversationPane(ownership.agent, desktopId, {
			ownership,
			...(input.position ? { position: input.position } : {}),
		});
	}

	const before = useStore.getState();
	const project = await before.ensureProjectForPath(workspaceRoot);
	if (project.kind !== "local") {
		throw new Error("discovered local conversation requires a local project");
	}
	const state = useStore.getState();
	const credential = resolveAgentLaunchCredential({
		provider: input.provider,
		activeAccountId: state.activeAccounts[input.provider],
		accounts: state.accounts,
	});
	const id = `agent-${nanoid(8)}`;
	const registration = buildInitialAgentRegistration({
		id,
		name: nextConversationName(state.agents, project.id, input.provider),
		provider: input.provider,
		project,
		worktreePath: cwd,
		branch: "",
		credential,
	});
	const agent: Agent = {
		...registration,
		started: false,
		conversationId,
	};

	return launchPreparedManagedConversationPane(agent, desktopId, {
		existingOwner: input.existingOwner,
		ownership,
		...(input.position ? { position: input.position } : {}),
	});
}

/** Register one exact SSH folder and resume its provider-native conversation.
 * The host/path selection is already confirmed by the caller. Registration is
 * staged before the remote create boundary, while the pane appears only after
 * the remote Host returns and commits its exact generation fence. */
export function launchDiscoveredRemoteConversationPane(input: {
	provider: Provider;
	conversationId: string;
	cwd: string;
	workspaceRoot: string;
	hostId: string;
	desktopId: string;
}): Promise<Agent> {
	const conversationId = input.conversationId.trim();
	const cwd = normalizeSlashPath(input.cwd.trim());
	const workspaceRoot = normalizeSlashPath(input.workspaceRoot.trim());
	const hostId = input.hostId.trim();
	const desktopId = input.desktopId.trim();
	if (!isDureProviderConversationRefV1(conversationId)) {
		return Promise.reject(new Error("invalid_conversation_identity"));
	}
	if (!providerSupportsExplicitResume(input.provider)) {
		return Promise.reject(
			new ProviderExplicitResumeUnsupportedError(input.provider),
		);
	}
	if (!input.cwd.trim() || !input.workspaceRoot.trim()) {
		return Promise.reject(
			new Error("discovered conversation workspace is required"),
		);
	}
	if (!hostId) {
		return Promise.reject(new Error("discovered SSH host is required"));
	}
	if (!desktopId) {
		return Promise.reject(
			new Error("managed conversation target desktop is required"),
		);
	}

	const operationKey = `${hostId}\0${input.provider}\0${conversationId}`;
	const existingOperation = remoteLaunches.get(operationKey);
	if (existingOperation) return existingOperation;

	const operation = (async () => {
		const initialOwner = exactRemoteConversationOwner(useStore.getState(), {
			provider: input.provider,
			conversationId,
			hostId,
		});
		if (initialOwner) {
			return resumeRemoteConversationOwner(initialOwner, desktopId);
		}

		const project = await useStore
			.getState()
			.ensureProjectForPath(workspaceRoot, hostId);
		if (project.kind !== "ssh" || project.sshHostId !== hostId) {
			throw new Error("discovered remote conversation requires an SSH project");
		}
		const state = useStore.getState();
		const ownerAfterProject = exactRemoteConversationOwner(state, {
			provider: input.provider,
			conversationId,
			hostId,
		});
		if (ownerAfterProject) {
			return resumeRemoteConversationOwner(ownerAfterProject, desktopId);
		}

		const credential = resolveAgentLaunchCredential({
			provider: input.provider,
			activeAccountId: state.activeAccounts[input.provider],
			accounts: state.accounts,
		});
		const id = `agent-${nanoid(8)}`;
		const registration = buildInitialAgentRegistration({
			id,
			name: nextConversationName(state.agents, project.id, input.provider),
			provider: input.provider,
			project,
			worktreePath: cwd,
			branch: "",
			credential,
		});
		const agent: Agent = {
			...registration,
			started: false,
			conversationId,
		};
		const rollbackEvidence = launchAgentRegistrationEvidence(agent);
		let racedOwner: Agent | undefined;
		useStore.setState((current) => {
			racedOwner = exactRemoteConversationOwner(current, {
				provider: input.provider,
				conversationId,
				hostId,
			});
			if (racedOwner) return {};
			const currentProject = current.projects.find(
				(candidate) => candidate.id === project.id,
			);
			if (
				currentProject?.kind !== "ssh" ||
				currentProject.sshHostId !== hostId ||
				currentProject.path !== project.path
			) {
				throw new Error(
					"discovered remote project changed before registration",
				);
			}
			return {
				agents: [...current.agents, agent],
				agentActivity: {
					...current.agentActivity,
					[agent.id]: "connecting",
				},
			};
		});
		if (racedOwner) {
			return resumeRemoteConversationOwner(racedOwner, desktopId);
		}

		const admission = await admitManagedCreateRegistration(
			agent,
			(launchAgent) =>
				ensureRemoteManagedAgentRuntime(launchAgent, {
					...REMOTE_BOOTSTRAP_GEOMETRY,
					beforeCreate: () => {
						const current = useStore.getState();
						const registered = current.agents.find((candidate) =>
							sameManagedCreateSource(candidate, launchAgent),
						);
						if (!registered) {
							throw new Error(
								"remote conversation registration changed before create",
							);
						}
						if (
							exactRemoteConversationOwner(
								current,
								{ provider: input.provider, conversationId, hostId },
								launchAgent.id,
							)
						) {
							throw new Error(
								"remote conversation owner appeared before create",
							);
						}
					},
				}),
		);
		if (admission.state === "rejected") {
			await rollbackCreatedAgentRegistration(admission.agent, rollbackEvidence);
			throw admission.error;
		}
		if (admission.state === "retained") throw admission.error;
		const launched = admission.value.agent;
		if (!openAgentPanel(desktopId, launched)) {
			throw new Error("managed conversation target desktop is not mounted");
		}
		useStore.setState((current) => ({
			stats: {
				...current.stats,
				agentsStarted: current.stats.agentsStarted + 1,
			},
		}));
		return launched;
	})();
	remoteLaunches.set(operationKey, operation);
	const clearOperation = () => {
		if (remoteLaunches.get(operationKey) === operation) {
			remoteLaunches.delete(operationKey);
		}
	};
	void operation.then(clearOperation, clearOperation);
	return operation;
}

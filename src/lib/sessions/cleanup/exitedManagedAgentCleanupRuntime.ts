import { emit } from "@tauri-apps/api/event";
import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
} from "@/lib/agents/agentRemovalRegistration";
import { isExitedHmuxSession } from "@/lib/agents/agentRuntimeLiveness";
import { isLegacyAgentWriterTarget } from "@/lib/agents/agentWriterPartition";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import {
	isHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	type HmuxRetireExitedItem,
	type HmuxRetireExitedReceipt,
	type HmuxSessionSummary,
	hmux,
} from "@/lib/ipc";
import {
	absentManagedAgentCleanupEligibleIds,
	type ExitedManagedAgentCleanupCandidate,
	type ExitedManagedAgentCleanupPlan,
	planExitedManagedAgentCleanup,
	sameExitedManagedAgentCleanupCandidate,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanup";
import type { CleanupCompensationStorage } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensation";
import {
	browserCleanupCompensationStorage,
	reconcileExitedManagedAgentCleanupCompensations,
	stageCurrentExitedManagedAgentCleanupCompensation,
	stageCurrentRemoteNeverCreatedManagedAgentCleanupCompensation,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensationRuntime";
import {
	planRemoteNeverCreatedManagedAgentCleanup,
	sameRemoteNeverCreatedManagedAgentCleanupCandidate,
} from "@/lib/sessions/cleanup/remoteNeverCreatedManagedAgentCleanup";
import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

type ExitedManagedAgentCleanupSkipReason =
	| "already_removed"
	| "binding_changed"
	| "generation_changed"
	| "source_not_exited"
	| "retire_refused"
	| "stale_cleanup_refused"
	| "error";

export interface ExitedManagedAgentCleanupReceipt {
	agentId: string;
	agentName: string;
	sessionId: string;
	workspaceId: string;
	outcome: "cleaned" | "skipped";
	sourceState?: "absent" | "retired" | "stale_removed";
	reason?: ExitedManagedAgentCleanupSkipReason;
	hmuxReason?: HmuxRetireExitedReceipt["reason"];
	message?: string;
}

export interface ExitedManagedAgentCleanupRuntime {
	listSessions: () => Promise<HmuxSessionSummary[]>;
	retireExitedSessions: (
		items: HmuxRetireExitedItem[],
		confirmed: boolean,
	) => Promise<HmuxRetireExitedReceipt[]>;
	cleanupStaleSessions: (
		items: HmuxRetireExitedItem[],
		confirmed: boolean,
	) => Promise<HmuxRetireExitedReceipt[]>;
	currentAgents: () => readonly Agent[];
	currentProjects: () => readonly Project[];
	absentEligibleAgentIds: () => ReadonlySet<string>;
	forget: (
		candidate: ExitedManagedAgentCleanupCandidate,
	) => boolean | Promise<boolean>;
	reconcileReplacement: (
		session: HmuxSessionSummary,
	) => boolean | Promise<boolean>;
}

export const EXITED_MANAGED_AGENT_CLEANED_EVENT =
	"agent:exited-managed-cleaned:v3";

interface ExitedManagedAgentCleanedSyncPayload {
	schemaVersion: 3;
	agentId: string;
	sessionId: string;
	workspaceId: string;
	createIdempotencyKey?: string;
	credentialId?: string;
	credentialGeneration?: number;
	stopFence?: ExitedManagedAgentCleanupCandidate["binding"]["stopFence"];
	sourceState?: "exited" | "stale";
	sourceTerminalEpoch?: string;
}

interface RemoteNeverCreatedManagedAgentCleanedSyncPayload {
	schemaVersion: 4;
	source: "ssh";
	agentId: string;
	hostId: string;
	sessionId: string;
	workspaceId: string;
	createIdempotencyKey: string;
	commandBridgeNonce: string;
}

async function applyRemoteNeverCreatedManagedAgentCleanupSync(
	value: Record<string, unknown>,
	options?: { storage?: CleanupCompensationStorage },
): Promise<boolean> {
	if (
		value.schemaVersion !== 4 ||
		value.source !== "ssh" ||
		![
			"agentId",
			"hostId",
			"sessionId",
			"workspaceId",
			"createIdempotencyKey",
			"commandBridgeNonce",
		].every((key) => {
			const entry = value[key];
			return typeof entry === "string" && entry.length > 0;
		})
	) {
		return false;
	}
	const payload =
		value as unknown as RemoteNeverCreatedManagedAgentCleanedSyncPayload;
	const state = useStore.getState();
	const agent = state.agents.find((current) => current.id === payload.agentId);
	if (!agent) return true;
	if (!isLegacyAgentWriterTarget(agent)) return false;
	const candidate = planRemoteNeverCreatedManagedAgentCleanup({
		agent,
		projects: state.projects,
		sshHosts: state.sshHosts,
	});
	if (
		!candidate ||
		candidate.binding.hostId !== payload.hostId ||
		candidate.binding.sessionId !== payload.sessionId ||
		candidate.binding.workspaceId !== payload.workspaceId ||
		candidate.binding.createIdempotencyKey !== payload.createIdempotencyKey ||
		candidate.binding.commandBridgeNonce !== payload.commandBridgeNonce ||
		!stageCurrentRemoteNeverCreatedManagedAgentCleanupCompensation(
			candidate,
			options?.storage ? { storage: options.storage } : undefined,
		)
	) {
		return false;
	}
	return removeAgentProjectionDurably({
		agents: [
			{
				agentId: agent.id,
				panelIds: [`agent:${agent.id}`],
				sessionIds: [agent.sessionId],
				applies: (current, projects, sshHosts) =>
					sameRemoteNeverCreatedManagedAgentCleanupCandidate(
						{ agent: current, projects, sshHosts },
						candidate,
					),
			},
		],
	});
}

function cleanupSyncPayload(
	candidate: ExitedManagedAgentCleanupCandidate,
): ExitedManagedAgentCleanedSyncPayload {
	return {
		schemaVersion: 3,
		agentId: candidate.agentId,
		sessionId: candidate.binding.sessionId,
		workspaceId: candidate.binding.workspaceId,
		...(candidate.binding.createIdempotencyKey
			? {
					createIdempotencyKey: candidate.binding.createIdempotencyKey,
				}
			: {}),
		...(candidate.binding.credentialId
			? { credentialId: candidate.binding.credentialId }
			: {}),
		...(candidate.binding.credentialGeneration !== undefined
			? {
					credentialGeneration: candidate.binding.credentialGeneration,
				}
			: {}),
		...(candidate.binding.stopFence
			? { stopFence: candidate.binding.stopFence }
			: {}),
		...(candidate.sourceState === "exited" || candidate.sourceState === "stale"
			? { sourceState: candidate.sourceState }
			: {}),
		...(candidate.terminalEpoch
			? { sourceTerminalEpoch: candidate.terminalEpoch }
			: {}),
	};
}

export async function applyExitedManagedAgentCleanupSync(
	value: unknown,
	options?: { storage?: CleanupCompensationStorage },
): Promise<boolean> {
	if (!value || typeof value !== "object") return false;
	if ((value as { schemaVersion?: unknown }).schemaVersion === 4) {
		return applyRemoteNeverCreatedManagedAgentCleanupSync(
			value as Record<string, unknown>,
			options,
		);
	}
	const payload = value as Partial<ExitedManagedAgentCleanedSyncPayload>;
	if (
		payload.schemaVersion !== 3 ||
		typeof payload.agentId !== "string" ||
		typeof payload.sessionId !== "string" ||
		typeof payload.workspaceId !== "string" ||
		(payload.sourceTerminalEpoch !== undefined &&
			(typeof payload.sourceTerminalEpoch !== "string" ||
				payload.sourceTerminalEpoch.length === 0)) ||
		(payload.sourceState !== undefined &&
			payload.sourceState !== "exited" &&
			payload.sourceState !== "stale")
	) {
		return false;
	}
	if (
		payload.stopFence !== undefined &&
		!isHmuxManagedGenerationV1(payload.stopFence)
	) {
		return false;
	}
	const state = useStore.getState();
	const agent = state.agents.find((current) => current.id === payload.agentId);
	if (!agent) return true;
	if (!isLegacyAgentWriterTarget(agent)) return false;
	const binding = bindingForAgent(agent, state.projects);
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		binding.hostId !== "local" ||
		binding.sessionId !== payload.sessionId ||
		binding.workspaceId !== payload.workspaceId ||
		binding.createIdempotencyKey !== payload.createIdempotencyKey ||
		binding.credentialId !== payload.credentialId ||
		binding.credentialGeneration !== payload.credentialGeneration ||
		!sameHmuxManagedGeneration(binding.stopFence, payload.stopFence)
	) {
		return false;
	}
	const candidate: ExitedManagedAgentCleanupCandidate = {
		agentId: agent.id,
		agentName: agent.name,
		projectName: agent.projectId,
		binding,
		sourceState:
			payload.sourceState ??
			(payload.sourceTerminalEpoch ? "exited" : "absent"),
		...(payload.sourceTerminalEpoch
			? { terminalEpoch: payload.sourceTerminalEpoch }
			: {}),
	};
	const registration = agentRemovalRegistrationIdentity(agent);
	if (
		!stageCurrentExitedManagedAgentCleanupCompensation(
			candidate,
			options?.storage ? { storage: options.storage } : undefined,
		)
	) {
		return false;
	}
	return removeAgentProjectionDurably({
		agents: [
			{
				agentId: agent.id,
				panelIds: [`agent:${agent.id}`],
				sessionIds: [agent.sessionId],
				applies: (current, projects) => {
					if (
						!isLegacyAgentWriterTarget(current) ||
						!sameAgentRemovalProjection(current, registration)
					) {
						return false;
					}
					const currentBinding = bindingForAgent(current, projects);
					return (
						currentBinding?.runtime === "hmux_managed_v1" &&
						currentBinding.source === "local" &&
						currentBinding.hostId === "local" &&
						sameExitedManagedAgentCleanupCandidate(candidate, {
							...candidate,
							binding: currentBinding,
						})
					);
				},
			},
		],
	});
}

const runtime: ExitedManagedAgentCleanupRuntime = {
	listSessions: hmux.listSessions,
	retireExitedSessions: hmux.retireExitedSessions,
	cleanupStaleSessions: hmux.cleanupStaleSessions,
	currentAgents: () => useStore.getState().agents,
	currentProjects: () => useStore.getState().projects,
	absentEligibleAgentIds: () => {
		const state = useStore.getState();
		return absentManagedAgentCleanupEligibleIds({
			agents: state.agents,
			agentActivity: state.agentActivity,
			sessionAgentRuntimeState: state.sessionAgentRuntimeState,
		});
	},
	forget: async (candidate) => {
		if (!stageCurrentExitedManagedAgentCleanupCompensation(candidate)) {
			return false;
		}
		const payload = cleanupSyncPayload(candidate);
		await emit(EXITED_MANAGED_AGENT_CLEANED_EVENT, payload);
		return applyExitedManagedAgentCleanupSync(payload);
	},
	reconcileReplacement: (session) => {
		const storage = browserCleanupCompensationStorage();
		if (!storage) return false;
		return reconcileExitedManagedAgentCleanupCompensations([session]).some(
			(receipt) => receipt.outcome !== "refused",
		);
	},
};

function exactSession(
	sessions: readonly HmuxSessionSummary[],
	candidate: ExitedManagedAgentCleanupCandidate,
): HmuxSessionSummary | undefined {
	return sessions.find(
		(session) =>
			session.sessionId === candidate.binding.sessionId &&
			session.workspaceId === candidate.binding.workspaceId,
	);
}

function currentCandidate(
	expected: ExitedManagedAgentCleanupCandidate,
	sessions: readonly HmuxSessionSummary[],
	deps: ExitedManagedAgentCleanupRuntime,
): ExitedManagedAgentCleanupCandidate | undefined {
	return planExitedManagedAgentCleanup({
		agents: deps
			.currentAgents()
			.filter((agent) => agent.id === expected.agentId),
		projects: deps.currentProjects(),
		sessions,
		absentEligibleAgentIds: deps.absentEligibleAgentIds(),
	}).candidates[0];
}

function currentBindingMatches(
	expected: ExitedManagedAgentCleanupCandidate,
	deps: ExitedManagedAgentCleanupRuntime,
): boolean {
	const agent = deps
		.currentAgents()
		.find((candidate) => candidate.id === expected.agentId);
	if (!isLegacyAgentWriterTarget(agent)) return false;
	const binding = bindingForAgent(agent, deps.currentProjects());
	return (
		binding?.runtime === "hmux_managed_v1" &&
		binding.source === "local" &&
		binding.hostId === "local" &&
		sameExitedManagedAgentCleanupCandidate(expected, {
			...expected,
			binding,
		})
	);
}

function receipt(
	candidate: ExitedManagedAgentCleanupCandidate,
	patch: Pick<
		ExitedManagedAgentCleanupReceipt,
		"outcome" | "sourceState" | "reason" | "hmuxReason" | "message"
	>,
): ExitedManagedAgentCleanupReceipt {
	return {
		agentId: candidate.agentId,
		agentName: candidate.agentName,
		sessionId: candidate.binding.sessionId,
		workspaceId: candidate.binding.workspaceId,
		...patch,
	};
}

async function retireExited(
	candidate: ExitedManagedAgentCleanupCandidate,
	deps: ExitedManagedAgentCleanupRuntime,
): Promise<DiscoveryCleanupResult> {
	const item = {
		workspaceId: candidate.binding.workspaceId,
		sessionId: candidate.binding.sessionId,
		terminalEpoch: candidate.terminalEpoch,
	};
	const preview = await deps.retireExitedSessions([item], false);
	const previewReceipt = preview[0];
	if (
		preview.length !== 1 ||
		previewReceipt?.workspaceId !== item.workspaceId ||
		previewReceipt?.sessionId !== item.sessionId
	) {
		return discoveryCleanupRefusal(undefined);
	}
	if (previewReceipt.outcome !== "retirable" || !previewReceipt.generation) {
		return discoveryCleanupRefusal(previewReceipt);
	}
	const executed = await deps.retireExitedSessions(
		[{ ...item, generation: previewReceipt.generation }],
		true,
	);
	const result = executed[0];
	if (
		executed.length !== 1 ||
		result?.workspaceId !== item.workspaceId ||
		result?.sessionId !== item.sessionId
	) {
		return discoveryCleanupRefusal(undefined);
	}
	return result.outcome === "retired" || result.outcome === "already_retired"
		? { outcome: "removed" }
		: discoveryCleanupRefusal(result);
}

interface DiscoveryCleanupResult {
	outcome: "removed" | "absent" | "refused";
	reason?: HmuxRetireExitedReceipt["reason"];
	message?: string;
}

function discoveryCleanupRefusal(
	receipt: HmuxRetireExitedReceipt | undefined,
): DiscoveryCleanupResult {
	return {
		outcome: "refused",
		...(receipt?.reason ? { reason: receipt.reason } : {}),
		...(receipt?.message ? { message: receipt.message } : {}),
	};
}

async function cleanupStale(
	candidate: ExitedManagedAgentCleanupCandidate,
	deps: ExitedManagedAgentCleanupRuntime,
): Promise<DiscoveryCleanupResult> {
	const item = {
		workspaceId: candidate.binding.workspaceId,
		sessionId: candidate.binding.sessionId,
		terminalEpoch: candidate.terminalEpoch,
	};
	const preview = await deps.cleanupStaleSessions([item], false);
	const previewReceipt = preview[0];
	if (
		preview.length !== 1 ||
		previewReceipt?.workspaceId !== item.workspaceId ||
		previewReceipt?.sessionId !== item.sessionId
	) {
		return discoveryCleanupRefusal(undefined);
	}
	// The exact manifest may disappear between the session census and the
	// non-mutating cleanup preview. That is the desired idempotent end state;
	// the final census below still fences a concurrent replacement before the
	// registration is forgotten.
	if (
		previewReceipt.outcome === "skipped" &&
		previewReceipt.reason === "not_found"
	) {
		return { outcome: "absent" };
	}
	if (previewReceipt.outcome !== "retirable" || !previewReceipt.generation) {
		return discoveryCleanupRefusal(previewReceipt);
	}
	const executed = await deps.cleanupStaleSessions(
		[{ ...item, generation: previewReceipt.generation }],
		true,
	);
	const result = executed[0];
	if (
		executed.length === 1 &&
		result?.workspaceId === item.workspaceId &&
		result?.sessionId === item.sessionId &&
		(result.outcome === "retired" || result.outcome === "already_retired")
	) {
		return { outcome: "removed" };
	}
	if (
		executed.length === 1 &&
		result?.workspaceId === item.workspaceId &&
		result?.sessionId === item.sessionId &&
		result.outcome === "skipped" &&
		result.reason === "not_found"
	) {
		return { outcome: "absent" };
	}
	return discoveryCleanupRefusal(
		executed.length === 1 &&
			result?.workspaceId === item.workspaceId &&
			result?.sessionId === item.sessionId
			? result
			: undefined,
	);
}

export async function previewExitedManagedAgentCleanup(
	deps: ExitedManagedAgentCleanupRuntime = runtime,
): Promise<ExitedManagedAgentCleanupPlan> {
	const sessions = await deps.listSessions();
	return planExitedManagedAgentCleanup({
		agents: deps.currentAgents(),
		projects: deps.currentProjects(),
		sessions,
		absentEligibleAgentIds: deps.absentEligibleAgentIds(),
	});
}

export async function executeExitedManagedAgentCleanup(
	expectedCandidates: readonly ExitedManagedAgentCleanupCandidate[],
	deps: ExitedManagedAgentCleanupRuntime = runtime,
): Promise<ExitedManagedAgentCleanupReceipt[]> {
	const receipts: ExitedManagedAgentCleanupReceipt[] = [];
	for (const expected of expectedCandidates) {
		try {
			const agents = deps.currentAgents();
			if (!agents.some((agent) => agent.id === expected.agentId)) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "already_removed",
					}),
				);
				continue;
			}
			const sessions = await deps.listSessions();
			const current = currentCandidate(expected, sessions, deps);
			if (!current) {
				const source = exactSession(sessions, expected);
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason:
							source && !isExitedHmuxSession(source)
								? "source_not_exited"
								: "binding_changed",
					}),
				);
				continue;
			}
			if (expected.sourceState !== current.sourceState) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "generation_changed",
					}),
				);
				continue;
			}
			if (
				(expected.sourceState === "exited" ||
					expected.sourceState === "stale") &&
				current.sourceState === expected.sourceState &&
				current.terminalEpoch !== expected.terminalEpoch
			) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "generation_changed",
					}),
				);
				continue;
			}
			if (!sameExitedManagedAgentCleanupCandidate(expected, current)) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "binding_changed",
					}),
				);
				continue;
			}
			let sourceState: "absent" | "retired" | "stale_removed" = "absent";
			if (current.sourceState === "exited") {
				const cleanup = await retireExited(current, deps);
				if (cleanup.outcome !== "removed") {
					receipts.push(
						receipt(expected, {
							outcome: "skipped",
							reason: "retire_refused",
							hmuxReason: cleanup.reason,
							message: cleanup.message,
						}),
					);
					continue;
				}
				sourceState = "retired";
			} else if (current.sourceState === "stale") {
				const cleanup = await cleanupStale(current, deps);
				if (cleanup.outcome === "refused") {
					receipts.push(
						receipt(expected, {
							outcome: "skipped",
							reason: "stale_cleanup_refused",
							hmuxReason: cleanup.reason,
							message: cleanup.message,
						}),
					);
					continue;
				}
				sourceState = cleanup.outcome === "absent" ? "absent" : "stale_removed";
			}
			const latestSessions = await deps.listSessions();
			const latestSource = exactSession(latestSessions, expected);
			if (latestSource) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "generation_changed",
					}),
				);
				continue;
			}
			if (!currentBindingMatches(expected, deps)) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "binding_changed",
					}),
				);
				continue;
			}
			if (!(await deps.forget(expected))) {
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "binding_changed",
					}),
				);
				continue;
			}
			const postForgetSource = exactSession(
				await deps.listSessions(),
				expected,
			);
			if (postForgetSource) {
				const restored = await deps.reconcileReplacement(postForgetSource);
				receipts.push(
					receipt(expected, {
						outcome: "skipped",
						reason: "generation_changed",
						...(restored
							? {}
							: {
									message:
										"replacement detected; durable cleanup compensation remains pending",
								}),
					}),
				);
				continue;
			}
			receipts.push(receipt(expected, { outcome: "cleaned", sourceState }));
		} catch (error) {
			receipts.push(
				receipt(expected, {
					outcome: "skipped",
					reason: "error",
					message: String(error),
				}),
			);
		}
	}
	return receipts;
}

export async function cleanupExitedManagedAgentRegistration(
	target: string | Agent,
	deps: ExitedManagedAgentCleanupRuntime = runtime,
): Promise<ExitedManagedAgentCleanupReceipt | undefined> {
	const agent =
		typeof target === "string"
			? deps.currentAgents().find((candidate) => candidate.id === target)
			: target;
	if (!agent) return undefined;
	const plan = planExitedManagedAgentCleanup({
		agents: [agent],
		projects: deps.currentProjects(),
		sessions: await deps.listSessions(),
		absentEligibleAgentIds: deps.absentEligibleAgentIds(),
	});
	const candidate = plan.candidates[0];
	if (!candidate) return undefined;
	return (await executeExitedManagedAgentCleanup([candidate], deps))[0];
}

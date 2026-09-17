import {
	type AgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";
import {
	type AgentRunPresentationWorktree,
	type AgentRunReceiptWorktree,
	projectAgentRunWorkspace,
	snapshotAgentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import {
	type AgentExecutionProfileV1,
	parseAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import {
	type BackendPresentationTarget,
	parseBackendPresentationTarget,
} from "@/lib/cli/backendPresentationTarget";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import { parseRunPresentationWorktree } from "@/lib/cli/runPresentationWorktree";
import {
	isHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
	isDureProviderConversationRefV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { isRecord } from "@/lib/payloadGuards";
import type {
	HmuxManagedPaneBindingV1,
	RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { AppState } from "@/store";
import type { Agent, HmuxManagedStopFenceV1, Project, Provider } from "@/types";

const REQUEST_KEYS = new Set([
	"schemaVersion",
	"runtime",
	"source",
	"hostId",
	"remote",
	"backendProfileId",
	"operationId",
	"agentId",
	"agentName",
	"projectId",
	"projectPath",
	"providerId",
	"executionProfile",
	"preparedSessionId",
	"sessionId",
	"launchIdempotencyKey",
	"workspaceId",
	"providerConversationRef",
	"worktree",
	"generation",
	"permissionMode",
	"spaceId",
	"windowLabel",
	"referencePanelId",
]);
const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;
const WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH_LENGTH = 4096;

export type ManagedRunPresentationBinding =
	| HmuxManagedPaneBindingV1
	| RemoteHmuxManagedPaneBindingV1;

interface CliManagedRunPresentationRequestFields {
	schemaVersion: 1;
	runtime: "hmux_managed_v1";
	/** Exact control-plane route. Missing only on legacy presentation requests. */
	backendProfileId?: string;
	operationId: string;
	agentId: string;
	agentName: string;
	projectId: string;
	projectPath?: string;
	providerId: Provider;
	/** Backend-owned credential selection for this exact runtime. Missing only
	 * on legacy CLI presentation requests. */
	executionProfile?: AgentExecutionProfileV1;
	/** Immutable Session preference from the prepared spawn plan. */
	preparedSessionId: string;
	sessionId: string;
	/** Exact effective managed-create key, normalized at the wire boundary. */
	launchIdempotencyKey: string;
	workspaceId: string;
	providerConversationRef?: string | null;
	worktree: AgentRunReceiptWorktree;
	generation: HmuxManagedStopFenceV1;
	permissionMode: "default" | "auto_edit" | "skip_permissions";
	spaceId: string;
	windowLabel: string;
	referencePanelId?: string;
}

export type CliManagedRunPresentationRequest =
	CliManagedRunPresentationRequestFields & BackendPresentationTarget;

export type CliManagedRunPresentationState = Pick<
	AppState,
	| "agents"
	| "projects"
	| "sshHosts"
	| "spaces"
	| "agentActivity"
	| "sessionCwd"
	| "stats"
>;

/** Pane-independent subset of the presentation request: everything the store
 * projection reads, minus the window-coupled fields (spaceId, windowLabel,
 * referencePanelId) that only the pane-attaching presentation path needs. */
export type ManagedRunProjectionInput =
	CliManagedRunPresentationRequest extends infer Request
		? Request extends unknown
			? Omit<Request, "spaceId" | "windowLabel" | "referencePanelId"> & {
					presentationWorktree?: AgentRunPresentationWorktree;
				}
			: never
		: never;

export class CliManagedRunPresentationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CliManagedRunPresentationError";
	}
}

export function failCliManagedRunPresentation(
	code: string,
	message: string,
): never {
	throw new CliManagedRunPresentationError(code, message);
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>) {
	return Object.keys(value).every((key) => allowed.has(key));
}

function token(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
		failCliManagedRunPresentation("invalid_request", `${label} is invalid`);
	}
	return value;
}

function optionalPath(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!value ||
		value.length > MAX_PATH_LENGTH ||
		containsCliControlCharacter(value)
	) {
		failCliManagedRunPresentation("invalid_request", "projectPath is invalid");
	}
	return value;
}

function windowLabel(value: unknown): string {
	if (typeof value !== "string" || !WINDOW_LABEL.test(value)) {
		failCliManagedRunPresentation("invalid_request", "windowLabel is invalid");
	}
	return value;
}

export function parseCliManagedRunPresentationRequest(
	value: unknown,
): CliManagedRunPresentationRequest {
	if (
		!isRecord(value) ||
		!exactKeys(value, REQUEST_KEYS) ||
		value.schemaVersion !== 1 ||
		value.runtime !== "hmux_managed_v1" ||
		(value.source !== "local" && value.source !== "ssh") ||
		(value.permissionMode !== "default" &&
			value.permissionMode !== "auto_edit" &&
			value.permissionMode !== "skip_permissions") ||
		!isHmuxManagedGenerationV1(value.generation)
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"managed Run presentation request is invalid",
		);
	}
	const providerId = token(value.providerId, "providerId");
	const executionProfile =
		value.executionProfile === undefined
			? undefined
			: parseAgentExecutionProfileV1(value.executionProfile);
	if (!PROVIDER_IDS.includes(providerId as Provider)) {
		failCliManagedRunPresentation(
			"invalid_request",
			"providerId is unsupported",
		);
	}
	if (value.executionProfile !== undefined && !executionProfile) {
		failCliManagedRunPresentation(
			"invalid_request",
			"executionProfile is invalid",
		);
	}
	const executionTarget = parseBackendPresentationTarget(
		value,
		failCliManagedRunPresentation,
	);
	const backendProfileId = value.backendProfileId;
	if (
		backendProfileId !== undefined &&
		!isDureBackendProfileIdV1(backendProfileId)
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"backendProfileId is invalid",
		);
	}
	if (
		executionTarget.source === "ssh" &&
		backendProfileId !== undefined &&
		backendProfileId !== executionTarget.hostId
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"backend profile identity is inconsistent",
		);
	}
	const operationId = token(value.operationId, "operationId");
	if (!isDureDomainIdV1(operationId)) {
		failCliManagedRunPresentation("invalid_request", "operationId is invalid");
	}
	const sessionId = token(value.sessionId, "sessionId");
	const legacyPreparedSessionId = operationId.startsWith("spawn-")
		? `session-${operationId.slice("spawn-".length)}`
		: undefined;
	const preparedSessionId =
		value.preparedSessionId === undefined
			? legacyPreparedSessionId
			: token(value.preparedSessionId, "preparedSessionId");
	if (!preparedSessionId) {
		failCliManagedRunPresentation(
			"invalid_request",
			"preparedSessionId is required for this managed Run identity",
		);
	}
	const preparedLaunchIdempotencyKey = `spawn-runtime:${operationId}`;
	const launchIdempotencyKey =
		value.launchIdempotencyKey === undefined
			? sessionId === preparedSessionId
				? preparedLaunchIdempotencyKey
				: undefined
			: token(value.launchIdempotencyKey, "launchIdempotencyKey");
	if (
		!launchIdempotencyKey ||
		(sessionId === preparedSessionId) !==
			(launchIdempotencyKey === preparedLaunchIdempotencyKey)
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"managed Run effective Session and create key do not form one identity",
		);
	}
	const providerConversationRef =
		value.providerConversationRef === undefined ||
		value.providerConversationRef === null
			? null
			: value.providerConversationRef;
	if (
		providerConversationRef !== null &&
		!isDureProviderConversationRefV1(providerConversationRef)
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"providerConversationRef is invalid",
		);
	}
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		...executionTarget,
		...(backendProfileId ? { backendProfileId } : {}),
		operationId,
		agentId: token(value.agentId, "agentId"),
		agentName: token(value.agentName, "agentName"),
		projectId: token(value.projectId, "projectId"),
		...(value.projectPath !== undefined
			? { projectPath: optionalPath(value.projectPath) }
			: {}),
		providerId: providerId as Provider,
		...(executionProfile ? { executionProfile } : {}),
		preparedSessionId,
		sessionId,
		launchIdempotencyKey,
		workspaceId: token(value.workspaceId, "workspaceId"),
		providerConversationRef,
		worktree:
			parseRunPresentationWorktree(value.worktree) ??
			failCliManagedRunPresentation("invalid_request", "worktree is invalid"),
		generation: value.generation,
		permissionMode: value.permissionMode,
		spaceId: token(value.spaceId, "spaceId"),
		windowLabel: windowLabel(value.windowLabel),
		...(value.referencePanelId !== undefined
			? {
					referencePanelId: token(value.referencePanelId, "referencePanelId"),
				}
			: {}),
	};
}

export function requireManagedRunPresentationGeneration(
	observed: HmuxManagedStopFenceV1 | undefined,
	expected: HmuxManagedStopFenceV1,
): HmuxManagedStopFenceV1 {
	if (!observed || !sameHmuxManagedGeneration(observed, expected)) {
		failCliManagedRunPresentation(
			"managed_session_generation_mismatch",
			"managed Run Session generation changed before presentation",
		);
	}
	return observed;
}

function sameRuntime(
	agent: Agent,
	request: ManagedRunProjectionInput,
	expected: ManagedRunPresentationBinding,
) {
	const binding = agent.runtimeBinding;
	return (
		binding?.runtime === "hmux_managed_v1" &&
		binding.sessionId === request.sessionId &&
		binding.workspaceId === request.workspaceId &&
		binding.source === request.source &&
		binding.hostId === expected.hostId
	);
}

function credentialProjection(
	profile: AgentExecutionProfileV1 | undefined,
): { accountId: string | null; credentialId?: string } | undefined {
	if (!profile) return undefined;
	return profile.kind === "credential_reference"
		? {
				accountId: profile.reference_id,
				credentialId: profile.reference_id,
			}
		: { accountId: null };
}

function bindingWithCredential(
	binding: ManagedRunPresentationBinding,
	profile: AgentExecutionProfileV1 | undefined,
): ManagedRunPresentationBinding {
	if (!profile) return binding;
	const identity = { ...binding };
	delete identity.credentialId;
	return profile.kind === "credential_reference"
		? { ...identity, credentialId: profile.reference_id }
		: identity;
}

export function projectManagedRunPresentationAgent(
	state: CliManagedRunPresentationState,
	request: ManagedRunProjectionInput,
	project: Project,
	binding: ManagedRunPresentationBinding,
): {
	patch: Partial<CliManagedRunPresentationState>;
	agent: Agent;
	outcome: "created" | "reused";
} {
	const canonicalSpawn: AgentCanonicalSpawnV1 | undefined =
		request.backendProfileId === undefined
			? undefined
			: {
					schemaVersion: 1,
					backendProfileId: request.backendProfileId,
					operationId: request.operationId,
				};
	const presentationWorktree =
		request.presentationWorktree ??
		snapshotAgentRunPresentationWorktree(
			request.worktree,
			state.agents,
			project,
			request.providerId,
		);
	const { path: worktreePath, branch } = projectAgentRunWorkspace(
		presentationWorktree,
		project.path,
	);
	const credential = credentialProjection(request.executionProfile);
	const projectedBinding = bindingWithCredential(
		binding,
		request.executionProfile,
	);
	const runtimeOwners = state.agents.filter((agent) =>
		sameRuntime(agent, request, binding),
	);
	if (runtimeOwners.length > 1) {
		failCliManagedRunPresentation(
			"client_agent_session_ambiguous",
			"managed Run session already has multiple Agent projections",
		);
	}
	const idOwner = state.agents.find((agent) => agent.id === request.agentId);
	const existing = runtimeOwners[0];
	if (idOwner && idOwner !== existing) {
		failCliManagedRunPresentation(
			"client_agent_identity_conflict",
			"managed Run Agent identity is already in use",
		);
	}
	if (existing) {
		if (
			existing.id !== request.agentId ||
			existing.name !== request.agentName ||
			existing.provider !== request.providerId ||
			existing.projectId !== project.id ||
			existing.worktreePath !== worktreePath ||
			existing.branch !== branch ||
			(existing.conversationId ?? null) !==
				(request.providerConversationRef ?? null) ||
			existing.runtimeBinding?.hostId !== binding.hostId ||
			(existing.canonicalSpawn !== undefined &&
				!sameAgentCanonicalSpawn(existing.canonicalSpawn, canonicalSpawn))
		) {
			failCliManagedRunPresentation(
				"client_agent_identity_conflict",
				"existing projection disagrees with the canonical Agent identity",
			);
		}
		const agent: Agent = {
			...existing,
			...(canonicalSpawn ? { canonicalSpawn } : {}),
			started: true,
			runtimeBinding: projectedBinding,
			...(request.providerConversationRef
				? { conversationId: request.providerConversationRef }
				: {}),
			...(request.executionProfile
				? { executionProfile: request.executionProfile }
				: {}),
			...(credential
				? {
						accountId: credential.accountId,
						credentialId: credential.credentialId,
					}
				: {}),
		};
		return {
			agent,
			outcome: "reused",
			patch: {
				agents: state.agents.map((candidate) =>
					candidate.id === agent.id ? agent : candidate,
				),
				sessionCwd: {
					...state.sessionCwd,
					[request.sessionId]: worktreePath,
				},
			},
		};
	}
	if (
		state.agents.some(
			(agent) =>
				agent.projectId === project.id && agent.name === request.agentName,
		)
	) {
		failCliManagedRunPresentation(
			"client_agent_name_conflict",
			"managed Run Agent name is already in use for this project",
		);
	}
	const agent: Agent = {
		id: request.agentId,
		...(canonicalSpawn ? { canonicalSpawn } : {}),
		name: request.agentName,
		provider: request.providerId,
		projectId: project.id,
		worktreePath,
		branch,
		sessionId: request.sessionId,
		sessionKind: request.source === "local" ? "pty" : "ssh",
		runtimeBinding: projectedBinding,
		...(request.providerConversationRef
			? { conversationId: request.providerConversationRef }
			: {}),
		...(request.executionProfile
			? { executionProfile: request.executionProfile }
			: {}),
		started: true,
		skipPermissions: request.permissionMode === "skip_permissions",
		...(credential
			? {
					accountId: credential.accountId,
					credentialId: credential.credentialId,
				}
			: {}),
	};
	return {
		agent,
		outcome: "created",
		patch: {
			agents: [...state.agents, agent],
			agentActivity: {
				...state.agentActivity,
				[agent.id]: "connecting",
			},
			sessionCwd: {
				...state.sessionCwd,
				[request.sessionId]: worktreePath,
			},
			stats: {
				...state.stats,
				agentsStarted: state.stats.agentsStarted + 1,
			},
		},
	};
}

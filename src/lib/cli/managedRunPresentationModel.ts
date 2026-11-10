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
import {
	type HmuxManagedPaneBindingV1,
	normalizeTerminalPaneBindingV1,
	type RemoteHmuxManagedPaneBindingV1,
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
/** Receipt-free identity: the backend's current runtime of an Agent that the
 * app launched, resumed or imported. It has no spawn operation or worktree
 * receipt, only the runtime workspace root. */
const AGENT_RUNTIME_REQUEST_KEYS = new Set([
	...[...REQUEST_KEYS].filter(
		(key) => !["operationId", "preparedSessionId", "worktree"].includes(key),
	),
	"identity",
	"workspaceRootPath",
]);
const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;
const WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH_LENGTH = 4096;

export type ManagedRunPresentationBinding =
	| HmuxManagedPaneBindingV1
	| RemoteHmuxManagedPaneBindingV1;

/** A spawned Run: the launch receipt names the operation and prepared Session. */
interface ManagedRunSpawnIdentity {
	identity?: undefined;
	operationId: string;
	/** Immutable Session preference from the prepared spawn plan. */
	preparedSessionId: string;
	/** Exact effective managed-create key, normalized at the wire boundary. */
	launchIdempotencyKey: string;
}

/** An Agent without a Run record. Presenting it never records a canonical
 * spawn, so stop and removal keep their app-launched semantics. */
interface ManagedRunAgentRuntimeIdentity {
	identity: "agent_runtime";
	operationId?: undefined;
	preparedSessionId?: undefined;
	/** Reported by the backend after a transition or rehost; otherwise read
	 * from the exact live Host's create receipt before presentation. */
	launchIdempotencyKey?: string;
}

interface CliManagedRunPresentationRequestFields {
	schemaVersion: 1;
	runtime: "hmux_managed_v1";
	/** Exact control-plane route. Missing only on legacy presentation requests. */
	backendProfileId?: string;
	agentId: string;
	agentName: string;
	projectId: string;
	projectPath?: string;
	providerId: Provider;
	/** Backend-owned credential selection for this exact runtime. Missing only
	 * on legacy CLI presentation requests. */
	executionProfile?: AgentExecutionProfileV1;
	sessionId: string;
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
	CliManagedRunPresentationRequestFields &
		(ManagedRunSpawnIdentity | ManagedRunAgentRuntimeIdentity) &
		BackendPresentationTarget;

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

/** A spawned Run's projection input, the only identity background
 * registration accepts because it records the Run's canonical spawn. */
export type ManagedRunSpawnProjectionInput = Extract<
	ManagedRunProjectionInput,
	{ identity?: undefined }
>;

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

type ManagedRunProjectionCommon = Omit<
	CliManagedRunPresentationRequestFields,
	"worktree" | "spaceId" | "windowLabel" | "referencePanelId"
> &
	BackendPresentationTarget;

/** Fields both identities share, validated against one exact key set. */
function parseManagedRunProjectionCommon(
	value: unknown,
	allowed: Set<string>,
): ManagedRunProjectionCommon & { raw: Record<string, unknown> } {
	if (
		!isRecord(value) ||
		!exactKeys(value, allowed) ||
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
		raw: value,
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		...executionTarget,
		...(backendProfileId ? { backendProfileId } : {}),
		agentId: token(value.agentId, "agentId"),
		agentName: token(value.agentName, "agentName"),
		projectId: token(value.projectId, "projectId"),
		...(value.projectPath !== undefined
			? { projectPath: optionalPath(value.projectPath) }
			: {}),
		providerId: providerId as Provider,
		...(executionProfile ? { executionProfile } : {}),
		sessionId: token(value.sessionId, "sessionId"),
		workspaceId: token(value.workspaceId, "workspaceId"),
		providerConversationRef,
		generation: value.generation,
		permissionMode: value.permissionMode,
	};
}

/** A spawned Run's projection input. Background registration accepts only
 * this identity: it records the Run's canonical spawn. */
export function parseManagedRunProjectionInput(
	value: unknown,
): ManagedRunSpawnProjectionInput {
	const { raw, ...common } = parseManagedRunProjectionCommon(
		value,
		new Set(
			[...REQUEST_KEYS].filter(
				(key) => !["spaceId", "windowLabel", "referencePanelId"].includes(key),
			),
		),
	);
	const operationId = token(raw.operationId, "operationId");
	if (!isDureDomainIdV1(operationId)) {
		failCliManagedRunPresentation("invalid_request", "operationId is invalid");
	}
	const sessionId = common.sessionId;
	const legacyPreparedSessionId = operationId.startsWith("spawn-")
		? `session-${operationId.slice("spawn-".length)}`
		: undefined;
	const preparedSessionId =
		raw.preparedSessionId === undefined
			? legacyPreparedSessionId
			: token(raw.preparedSessionId, "preparedSessionId");
	if (!preparedSessionId) {
		failCliManagedRunPresentation(
			"invalid_request",
			"preparedSessionId is required for this managed Run identity",
		);
	}
	const preparedLaunchIdempotencyKey = `spawn-runtime:${operationId}`;
	const launchIdempotencyKey =
		raw.launchIdempotencyKey === undefined
			? sessionId === preparedSessionId
				? preparedLaunchIdempotencyKey
				: undefined
			: token(raw.launchIdempotencyKey, "launchIdempotencyKey");
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
	return {
		...common,
		operationId,
		preparedSessionId,
		launchIdempotencyKey,
		worktree:
			parseRunPresentationWorktree(raw.worktree) ??
			failCliManagedRunPresentation("invalid_request", "worktree is invalid"),
	};
}

/** An Agent without a Run record, identified only by the backend's current
 * runtime. Its workspace is the project root or an existing checkout; the
 * backend carries no branch, so a new projection shows none. */
function parseAgentRuntimeProjectionInput(
	value: unknown,
): Extract<ManagedRunProjectionInput, { identity: "agent_runtime" }> {
	const { raw, ...common } = parseManagedRunProjectionCommon(
		value,
		new Set(
			[...AGENT_RUNTIME_REQUEST_KEYS].filter(
				(key) => !["spaceId", "windowLabel", "referencePanelId"].includes(key),
			),
		),
	);
	if (
		raw.identity !== "agent_runtime" ||
		common.backendProfileId === undefined ||
		!common.projectPath
	) {
		failCliManagedRunPresentation(
			"invalid_request",
			"Agent runtime presentation requires its backend profile and project root",
		);
	}
	const workspaceRootPath = optionalPath(raw.workspaceRootPath);
	if (!workspaceRootPath?.startsWith("/")) {
		failCliManagedRunPresentation(
			"invalid_request",
			"workspaceRootPath is invalid",
		);
	}
	return {
		...common,
		identity: "agent_runtime",
		...(raw.launchIdempotencyKey === undefined
			? {}
			: {
					launchIdempotencyKey: token(
						raw.launchIdempotencyKey,
						"launchIdempotencyKey",
					),
				}),
		worktree:
			normalizedRoot(workspaceRootPath) === normalizedRoot(common.projectPath)
				? { kind: "project_root" }
				: {
						kind: "existing_checkout",
						branch: "",
						rootPath: workspaceRootPath,
					},
	};
}

function normalizedRoot(path: string): string {
	return path.replace(/\/+$/u, "") || path;
}

export function parseCliManagedRunPresentationRequest(
	value: unknown,
): CliManagedRunPresentationRequest {
	if (!isRecord(value))
		failCliManagedRunPresentation(
			"invalid_request",
			"managed Run presentation request is invalid",
		);
	const {
		spaceId,
		windowLabel: label,
		referencePanelId,
		...projection
	} = value;
	return {
		...(projection.identity === "agent_runtime"
			? parseAgentRuntimeProjectionInput(projection)
			: parseManagedRunProjectionInput(projection)),
		spaceId: token(spaceId, "spaceId"),
		windowLabel: windowLabel(label),
		...(referencePanelId === undefined
			? {}
			: { referencePanelId: token(referencePanelId, "referencePanelId") }),
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
		request.backendProfileId === undefined || request.operationId === undefined
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
	const { path: worktreePath, branch: receiptBranch } =
		projectAgentRunWorkspace(presentationWorktree, project.path);
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
	// A runtime-only identity carries no branch; an existing projection of the
	// same runtime and checkout keeps the branch it was launched with.
	const branch =
		request.identity === "agent_runtime" &&
		existing?.worktreePath === worktreePath
			? existing.branch
			: receiptBranch;
	if (idOwner && idOwner !== existing) {
		failCliManagedRunPresentation(
			"client_agent_identity_conflict",
			"managed Run Agent identity is already in use",
		);
	}
	if (existing) {
		// A launch receipt can predate the first provider event or a verified
		// continuation. Preserve the projection owned by this exact live Host.
		const previousBinding = normalizeTerminalPaneBindingV1(
			existing.runtimeBinding,
		);
		const previousIdentity =
			previousBinding?.runtime === "hmux_managed_v1"
				? previousBinding.conversationIdentity
				: undefined;
		const currentIdentity =
			previousIdentity &&
			binding.stopFence &&
			previousIdentity.providerId === request.providerId &&
			previousIdentity.conversationId === existing.conversationId &&
			sameHmuxManagedGeneration(previousIdentity, binding.stopFence)
				? previousIdentity
				: undefined;
		if (
			existing.id !== request.agentId ||
			existing.name !== request.agentName ||
			existing.provider !== request.providerId ||
			existing.projectId !== project.id ||
			existing.worktreePath !== worktreePath ||
			existing.branch !== branch ||
			(!currentIdentity &&
				(existing.conversationId ?? null) !==
					(request.providerConversationRef ?? null)) ||
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
			runtimeBinding: {
				...projectedBinding,
				...(currentIdentity ? { conversationIdentity: currentIdentity } : {}),
			},
			...(currentIdentity
				? { conversationId: currentIdentity.conversationId }
				: request.providerConversationRef
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

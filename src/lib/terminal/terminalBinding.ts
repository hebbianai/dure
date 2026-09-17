import { hasOnlyKeys, nonEmptyString } from "@/lib/payloadGuards";
import {
	isHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	Agent,
	HmuxManagedStopFenceV1,
	Project,
	ProviderConversationIdentityBindingV1,
} from "@/types";
import { PROVIDERS } from "@/types";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import { paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";

const TERMINAL_BINDING_SCHEMA_VERSION = 1 as const;

export interface HmuxLocalPaneBindingV1 {
	schemaVersion: typeof TERMINAL_BINDING_SCHEMA_VERSION;
	runtime: "hmux_session_v1";
	source: "local";
	hostId: "local";
	sessionId: string;
	workspaceId: string;
}

export interface HmuxStandalonePaneBindingV1 {
	schemaVersion: typeof TERMINAL_BINDING_SCHEMA_VERSION;
	runtime: "hmux_standalone_v1";
	source: "local";
	hostId: "local";
	sessionId: string;
	workspaceId: string;
}

export interface RemoteHmuxStandalonePaneBindingV1 {
	schemaVersion: typeof TERMINAL_BINDING_SCHEMA_VERSION;
	runtime: "hmux_standalone_v1";
	source: "ssh";
	hostId: string;
	sessionId: string;
	workspaceId: string;
	commandBridgeNonce: string;
}

export interface RemoteHmuxManagedPaneBindingV1 {
	schemaVersion: typeof TERMINAL_BINDING_SCHEMA_VERSION;
	runtime: "hmux_managed_v1";
	source: "ssh";
	hostId: string;
	sessionId: string;
	workspaceId: string;
	createIdempotencyKey: string;
	/** Digest of the first prompt accepted by this managed generation. */
	initialPromptDigest?: string;
	commandBridgeNonce: string;
	/** Exact non-secret control-plane route for runtime transitions. */
	backendProfileId?: string;
	stopFence?: HmuxManagedStopFenceV1;
	/** Non-secret credential profile reference on the remote account. */
	credentialId?: string;
	/** Exact provider-scoped profile directory selected for this generation. */
	credentialProfileDirectory?: string;
	/** Latest exact Host-owned provider conversation identity projection. */
	conversationIdentity?: ProviderConversationIdentityBindingV1;
}

export interface HmuxManagedPaneBindingV1 {
	schemaVersion: typeof TERMINAL_BINDING_SCHEMA_VERSION;
	runtime: "hmux_managed_v1";
	source: "local";
	hostId: "local";
	sessionId: string;
	workspaceId: string;
	/** Stable create operation identity. Optional only for pre-field bindings. */
	createIdempotencyKey?: string;
	/** Exact non-secret control-plane route for runtime transitions. */
	backendProfileId?: string;
	stopFence?: HmuxManagedStopFenceV1;
	/** Non-secret reference only; provider auth material is never persisted. */
	credentialId?: string;
	/** Non-secret generation only; never a token or credential payload. */
	credentialGeneration?: number;
	/** Latest exact Host-owned provider conversation identity projection. */
	conversationIdentity?: ProviderConversationIdentityBindingV1;
}

export type HmuxPaneBindingV1 =
	| HmuxLocalPaneBindingV1
	| HmuxStandalonePaneBindingV1
	| RemoteHmuxStandalonePaneBindingV1
	| RemoteHmuxManagedPaneBindingV1
	| HmuxManagedPaneBindingV1;

/** Durable, non-secret runtime identity stored with each pane layout. */
export type TerminalPaneBindingV1 = HmuxPaneBindingV1;

/** Returns the latest Host-owned provider identity only for managed bindings. */
export function hmuxPaneConversationId(
	binding: HmuxPaneBindingV1 | undefined,
): string | undefined {
	return binding?.runtime === "hmux_managed_v1"
		? binding.conversationIdentity?.conversationId
		: undefined;
}

const MAX_U64 = 18_446_744_073_709_551_615n;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const SAFE_REMOTE_PROFILE_DIRECTORY =
	/^\.dure\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const PROVIDER_IDS = new Set(Object.keys(PROVIDERS));

function decimalU64(value: unknown, nonZero = false): value is string {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		return false;
	}
	return (!nonZero || value !== "0") && BigInt(value) <= MAX_U64;
}

function safeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && SAFE_OPAQUE_ID.test(value);
}

/** Exact local managed launch binding equality used by presentation CAS paths.
 * Host-observed conversation projection revisions are intentionally excluded. */
export function sameHmuxManagedLaunchBinding(
	left: unknown,
	right: HmuxManagedPaneBindingV1,
): boolean {
	return (
		isTerminalPaneBindingV1(left) &&
		left.runtime === "hmux_managed_v1" &&
		left.source === "local" &&
		left.hostId === right.hostId &&
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		left.backendProfileId === right.backendProfileId &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence) &&
		left.credentialId === right.credentialId &&
		left.credentialGeneration === right.credentialGeneration
	);
}

function isConversationIdentityBinding(
	value: unknown,
	sessionId: string,
	workspaceId: string,
): value is ProviderConversationIdentityBindingV1 {
	if (!value || typeof value !== "object") return false;
	const identity = value as Record<string, unknown>;
	return (
		identity.schemaVersion === 1 &&
		identity.sessionId === sessionId &&
		identity.workspaceId === workspaceId &&
		safeOpaqueId(identity.sessionId) &&
		safeOpaqueId(identity.workspaceId) &&
		safeOpaqueId(identity.runnerPrincipal) &&
		safeOpaqueId(identity.runnerInstance) &&
		decimalU64(identity.channelEpoch, true) &&
		safeOpaqueId(identity.hostInstanceId) &&
		safeOpaqueId(identity.terminalEpoch) &&
		decimalU64(identity.revision, true) &&
		decimalU64(identity.observedThroughOutputSeq) &&
		safeOpaqueId(identity.providerId) &&
		PROVIDER_IDS.has(identity.providerId) &&
		safeOpaqueId(identity.conversationId) &&
		(identity.source === "launch_request" ||
			identity.source === "provider_event") &&
		hasOnlyKeys(identity, [
			"schemaVersion",
			"sessionId",
			"workspaceId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
			"revision",
			"observedThroughOutputSeq",
			"providerId",
			"conversationId",
			"source",
		])
	);
}

function isRemoteConversationIdentityBinding(
	value: unknown,
	sessionId: string,
	workspaceId: string,
	stopFence: unknown,
): value is ProviderConversationIdentityBindingV1 {
	return (
		isConversationIdentityBinding(value, sessionId, workspaceId) &&
		isHmuxManagedGenerationV1(stopFence) &&
		sameHmuxManagedGeneration(stopFence, value)
	);
}

export function isTerminalPaneBindingV1(
	value: unknown,
): value is TerminalPaneBindingV1 {
	if (!value || typeof value !== "object") return false;
	const binding = value as Record<string, unknown>;
	if (
		binding.schemaVersion !== TERMINAL_BINDING_SCHEMA_VERSION ||
		!nonEmptyString(binding.sessionId)
	) {
		return false;
	}
	if (
		binding.runtime === "hmux_session_v1" ||
		binding.runtime === "hmux_standalone_v1" ||
		binding.runtime === "hmux_managed_v1"
	) {
		if (binding.source === "ssh") {
			const baseValid =
				(binding.runtime === "hmux_standalone_v1" ||
					binding.runtime === "hmux_managed_v1") &&
				nonEmptyString(binding.hostId) &&
				binding.hostId !== "local" &&
				nonEmptyString(binding.workspaceId) &&
				nonEmptyString(binding.commandBridgeNonce);
			if (!baseValid) return false;
			return binding.runtime === "hmux_managed_v1"
				? nonEmptyString(binding.createIdempotencyKey) &&
						(binding.initialPromptDigest === undefined || (typeof binding.initialPromptDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(binding.initialPromptDigest))) &&
						(binding.backendProfileId === undefined ||
							safeOpaqueId(binding.backendProfileId)) &&
						(binding.stopFence === undefined ||
							isHmuxManagedGenerationV1(binding.stopFence)) &&
						(binding.credentialId === undefined ||
							safeOpaqueId(binding.credentialId)) &&
						(binding.credentialProfileDirectory === undefined ||
							(typeof binding.credentialProfileDirectory === "string" &&
								SAFE_REMOTE_PROFILE_DIRECTORY.test(
									binding.credentialProfileDirectory,
								))) &&
						(binding.conversationIdentity === undefined ||
							isRemoteConversationIdentityBinding(
								binding.conversationIdentity,
								binding.sessionId,
								binding.workspaceId as string,
								binding.stopFence,
							)) &&
						hasOnlyKeys(binding, [
							"schemaVersion",
							"runtime",
							"source",
							"hostId",
							"sessionId",
							"workspaceId",
							"createIdempotencyKey",
							"initialPromptDigest",
							"commandBridgeNonce",
							"backendProfileId",
							"stopFence",
							"credentialId",
							"credentialProfileDirectory",
							"conversationIdentity",
						])
				: hasOnlyKeys(binding, [
						"schemaVersion",
						"runtime",
						"source",
						"hostId",
						"sessionId",
						"workspaceId",
						"commandBridgeNonce",
					]);
		}
		const baseValid =
			binding.source === "local" &&
			binding.hostId === "local" &&
			nonEmptyString(binding.workspaceId);
		if (!baseValid) return false;
		if (binding.runtime === "hmux_managed_v1") {
			return (
				(binding.createIdempotencyKey === undefined ||
					nonEmptyString(binding.createIdempotencyKey)) &&
				(binding.backendProfileId === undefined ||
					safeOpaqueId(binding.backendProfileId)) &&
				(binding.credentialId === undefined ||
					nonEmptyString(binding.credentialId)) &&
				(binding.credentialGeneration === undefined ||
					(nonEmptyString(binding.credentialId) &&
						Number.isSafeInteger(binding.credentialGeneration) &&
						(binding.credentialGeneration as number) >= 0)) &&
				(binding.conversationIdentity === undefined ||
					isConversationIdentityBinding(
						binding.conversationIdentity,
						binding.sessionId,
						binding.workspaceId as string,
					)) &&
				(binding.stopFence === undefined ||
					isHmuxManagedGenerationV1(binding.stopFence)) &&
				hasOnlyKeys(binding, [
					"schemaVersion",
					"runtime",
					"source",
					"hostId",
					"sessionId",
					"workspaceId",
					"createIdempotencyKey",
					"backendProfileId",
					"credentialId",
					"credentialGeneration",
					"conversationIdentity",
					"stopFence",
				])
			);
		}
		return hasOnlyKeys(binding, [
			"schemaVersion",
			"runtime",
			"source",
			"hostId",
			"sessionId",
			"workspaceId",
		]);
	}
	return false;
}

/** Rebuild a durable binding from its public fields. This strips unknown
 * properties (including accidental auth material) without changing runtime
 * identity. An unrecognizable explicit binding fails closed. */
export function normalizeTerminalPaneBindingV1(
	value: unknown,
): TerminalPaneBindingV1 | undefined {
	if (isTerminalPaneBindingV1(value)) return value;
	if (!value || typeof value !== "object") return undefined;
	const binding = value as Record<string, unknown>;
	if (!nonEmptyString(binding.sessionId)) return undefined;
	if (
		binding.runtime === "hmux_managed_v1" &&
		binding.source === "local" &&
		binding.hostId === "local" &&
		nonEmptyString(binding.workspaceId)
	) {
		const credentialId = nonEmptyString(binding.credentialId)
			? binding.credentialId
			: undefined;
		const conversationIdentity = isConversationIdentityBinding(
			binding.conversationIdentity,
			binding.sessionId,
			binding.workspaceId,
		)
			? binding.conversationIdentity
			: undefined;
		return {
			...hmuxManagedBinding(
				binding.sessionId,
				binding.workspaceId,
				credentialId,
				credentialId &&
					Number.isSafeInteger(binding.credentialGeneration) &&
					(binding.credentialGeneration as number) >= 0
					? (binding.credentialGeneration as number)
					: undefined,
				undefined,
				safeOpaqueId(binding.backendProfileId)
					? binding.backendProfileId
					: undefined,
			),
			createIdempotencyKey: nonEmptyString(binding.createIdempotencyKey)
				? binding.createIdempotencyKey
				: binding.sessionId,
			...(conversationIdentity ? { conversationIdentity } : {}),
			...(isHmuxManagedGenerationV1(binding.stopFence)
				? { stopFence: binding.stopFence }
				: {}),
		};
	}
	if (
		binding.runtime === "hmux_managed_v1" &&
		binding.source === "ssh" &&
		nonEmptyString(binding.hostId) &&
		binding.hostId !== "local" &&
		nonEmptyString(binding.workspaceId) &&
		nonEmptyString(binding.createIdempotencyKey) &&
		nonEmptyString(binding.commandBridgeNonce)
	) {
		const conversationIdentity = isRemoteConversationIdentityBinding(
			binding.conversationIdentity,
			binding.sessionId,
			binding.workspaceId,
			binding.stopFence,
		)
			? binding.conversationIdentity
			: undefined;
		return {
			...remoteHmuxManagedBinding(
				binding.sessionId,
				binding.workspaceId,
				binding.hostId,
				binding.commandBridgeNonce,
				binding.createIdempotencyKey,
				isHmuxManagedGenerationV1(binding.stopFence)
					? binding.stopFence
					: undefined,
				safeOpaqueId(binding.credentialId) ? binding.credentialId : undefined,
				typeof binding.credentialProfileDirectory === "string" &&
					SAFE_REMOTE_PROFILE_DIRECTORY.test(binding.credentialProfileDirectory)
					? binding.credentialProfileDirectory
					: undefined,
				safeOpaqueId(binding.backendProfileId)
					? binding.backendProfileId
					: undefined,
			),
			...(typeof binding.initialPromptDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(binding.initialPromptDigest) ? { initialPromptDigest: binding.initialPromptDigest } : {}),
			...(conversationIdentity ? { conversationIdentity } : {}),
		};
	}
	if (
		(binding.runtime === "hmux_session_v1" ||
			binding.runtime === "hmux_standalone_v1") &&
		binding.source === "local" &&
		binding.hostId === "local" &&
		nonEmptyString(binding.workspaceId)
	) {
		return binding.runtime === "hmux_session_v1"
			? hmuxLocalBinding(binding.sessionId, binding.workspaceId)
			: hmuxStandaloneBinding(binding.sessionId, binding.workspaceId);
	}
	if (
		binding.runtime === "hmux_standalone_v1" &&
		binding.source === "ssh" &&
		nonEmptyString(binding.hostId) &&
		binding.hostId !== "local" &&
		nonEmptyString(binding.workspaceId) &&
		nonEmptyString(binding.commandBridgeNonce)
	) {
		return remoteHmuxStandaloneBinding(
			binding.sessionId,
			binding.workspaceId,
			binding.hostId,
			binding.commandBridgeNonce,
		);
	}
	return undefined;
}

export function hmuxLocalBinding(
	sessionId: string,
	workspaceId: string,
): HmuxLocalPaneBindingV1 {
	return {
		schemaVersion: TERMINAL_BINDING_SCHEMA_VERSION,
		runtime: "hmux_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
		workspaceId,
	};
}

export function hmuxStandaloneBinding(
	sessionId: string,
	workspaceId: string,
): HmuxStandalonePaneBindingV1 {
	return {
		schemaVersion: TERMINAL_BINDING_SCHEMA_VERSION,
		runtime: "hmux_standalone_v1",
		source: "local",
		hostId: "local",
		sessionId,
		workspaceId,
	};
}

export function remoteHmuxStandaloneBinding(
	sessionId: string,
	workspaceId: string,
	hostId: string,
	commandBridgeNonce: string,
): RemoteHmuxStandalonePaneBindingV1 {
	if (
		!nonEmptyString(sessionId) ||
		!nonEmptyString(workspaceId) ||
		!nonEmptyString(hostId) ||
		hostId === "local" ||
		!nonEmptyString(commandBridgeNonce)
	) {
		throw new Error(
			"remote Hmux binding requires exact remote runtime identity",
		);
	}
	return {
		schemaVersion: TERMINAL_BINDING_SCHEMA_VERSION,
		runtime: "hmux_standalone_v1",
		source: "ssh",
		hostId,
		sessionId,
		workspaceId,
		commandBridgeNonce,
	};
}

export function remoteHmuxManagedBinding(
	sessionId: string,
	workspaceId: string,
	hostId: string,
	commandBridgeNonce: string,
	createIdempotencyKey = sessionId,
	stopFence?: HmuxManagedStopFenceV1,
	credentialId?: string,
	credentialProfileDirectory?: string,
	backendProfileId?: string,
): RemoteHmuxManagedPaneBindingV1 {
	const standalone = remoteHmuxStandaloneBinding(
		sessionId,
		workspaceId,
		hostId,
		commandBridgeNonce,
	);
	return {
		...standalone,
		runtime: "hmux_managed_v1",
		createIdempotencyKey,
		...(stopFence ? { stopFence } : {}),
		...(credentialId ? { credentialId } : {}),
		...(credentialProfileDirectory ? { credentialProfileDirectory } : {}),
		...(backendProfileId ? { backendProfileId } : {}),
	};
}

export function hmuxStandalonePaneParams(
	current: Record<string, unknown>,
	sessionId: string,
	workspaceId: string,
	cwd?: string,
): Record<string, unknown> {
	return {
		...current,
		sessionId,
		...(cwd === undefined ? {} : { cwd }),
		binding: hmuxStandaloneBinding(sessionId, workspaceId),
	};
}

export function hmuxManagedBinding(
	sessionId: string,
	workspaceId: string,
	credentialId?: string,
	credentialGeneration?: number,
	stopFence?: HmuxManagedStopFenceV1,
	backendProfileId?: string,
): HmuxManagedPaneBindingV1 {
	if (credentialGeneration !== undefined && !credentialId) {
		throw new Error(
			"credential generation requires a non-secret credential reference",
		);
	}
	return {
		schemaVersion: TERMINAL_BINDING_SCHEMA_VERSION,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId,
		workspaceId,
		createIdempotencyKey: sessionId,
		...(stopFence ? { stopFence } : {}),
		...(credentialId ? { credentialId } : {}),
		...(credentialGeneration !== undefined ? { credentialGeneration } : {}),
		...(backendProfileId ? { backendProfileId } : {}),
	};
}

export function isHmuxPaneBinding(
	binding: TerminalPaneBindingV1 | undefined,
): binding is HmuxPaneBindingV1 {
	return (
		binding?.runtime === "hmux_session_v1" ||
		binding?.runtime === "hmux_standalone_v1" ||
		binding?.runtime === "hmux_managed_v1"
	);
}

export function isHmuxControllerPaneBinding(
	binding: TerminalPaneBindingV1 | undefined,
): binding is HmuxStandalonePaneBindingV1 | HmuxManagedPaneBindingV1 {
	return (
		(binding?.runtime === "hmux_standalone_v1" && binding.source === "local") ||
		(binding?.runtime === "hmux_managed_v1" && binding.source === "local")
	);
}

export function isRemoteHmuxStandalonePaneBinding(
	binding: TerminalPaneBindingV1 | undefined,
): binding is RemoteHmuxStandalonePaneBindingV1 {
	return binding?.runtime === "hmux_standalone_v1" && binding.source === "ssh";
}

export function isRemoteHmuxPaneBinding(
	binding: TerminalPaneBindingV1 | undefined,
): binding is
	| RemoteHmuxStandalonePaneBindingV1
	| RemoteHmuxManagedPaneBindingV1 {
	return (
		binding?.source === "ssh" &&
		(binding.runtime === "hmux_standalone_v1" ||
			binding.runtime === "hmux_managed_v1")
	);
}

export function bindingForAgent(
	agent: Agent,
	projects: readonly Project[],
): TerminalPaneBindingV1 | undefined {
	// Legacy inference is retired: rehydration promotes bindingless records
	// onto the managed runtime, so a still-missing binding means an orphaned
	// record — undefined routes its pane to the retirement notice.
	void projects;
	return agent.runtimeBinding !== undefined
		? normalizeTerminalPaneBindingV1(agent.runtimeBinding)
		: undefined;
}

export function bindingFromPane(
	{ component, params }: SerializedPanelRef,
	agents: readonly Agent[],
	projects: readonly Project[],
): TerminalPaneBindingV1 | undefined {
	// Content selects the target contract; Agent runtime facts stay in the registry.
	if (component === "agent") {
		const agentId = agentIdFromPaneParameters(params);
		const agent = agents.find((candidate) => candidate.id === agentId);
		return agent ? bindingForAgent(agent, projects) : undefined;
	}
	const existing = params.binding;
	const normalizedExisting = normalizeTerminalPaneBindingV1(existing);
	const sessionId =
		typeof params.sessionId === "string" ? params.sessionId : undefined;
	if (normalizedExisting) {
		if (
			component === "terminal" &&
			normalizedExisting.sessionId === sessionId
		) {
			return normalizedExisting;
		}
		if (
			component === "ssh" &&
			normalizedExisting.source === "ssh" &&
			normalizedExisting.sessionId === sessionId &&
			normalizedExisting.hostId === params.hostId
		) {
			return normalizedExisting;
		}
	}
	return undefined;
}

/** Add V1 bindings to persisted legacy Terminal panels without changing
 * unrelated layout data. Agent panes resolve through the Agent registry and
 * never copy runtime identity into Dockview parameters. */
export function migrateTerminalBindingsInLayout(
	value: unknown,
	agents: readonly Agent[],
	projects: readonly Project[],
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			migrateTerminalBindingsInLayout(entry, agents, projects),
		);
	}
	if (!value || typeof value !== "object") return value;

	const record = value as Record<string, unknown>;
	const migrated: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		migrated[key] = migrateTerminalBindingsInLayout(entry, agents, projects);
	}

	if (
		typeof record.id !== "string" ||
		!record.params ||
		typeof record.params !== "object"
	) {
		return migrated;
	}
	const params = migrated.params as Record<string, unknown>;
	const component = paneContentComponent(record);
	if (component === "agent") return migrated;
	const binding = bindingFromPane(
		{ id: record.id, component, params },
		agents,
		projects,
	);
	if (binding && !params.binding) migrated.params = { ...params, binding };
	return migrated;
}

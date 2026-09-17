import type { RemoteHmuxCatalogSessionV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { asRecord as recordOf } from "@/lib/payloadGuards";
import {
	type HmuxManagedPaneBindingV1,
	normalizeTerminalPaneBindingV1,
	type RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	type Agent,
	PROVIDERS,
	type Provider,
	type TerminalEnvironment,
} from "@/types";

export const EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY =
	"dure:exited-managed-agent-cleanup-compensation:v1";

const SCHEMA_VERSION = 1 as const;
const RETENTION_MS = 5 * 60 * 1_000;
const MAX_RECORDS = 64;
const MAX_DOCUMENT_BYTES = 512 * 1_024;
const MAX_STRING_LENGTH = 16 * 1_024;
const TERMINAL_ENVIRONMENT_KEYS = new Set([
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"FORCE_COLOR",
]);
const PROVIDER_IDS = new Set<Provider>(Object.keys(PROVIDERS) as Provider[]);

export type ManagedCleanupBinding =
	| HmuxManagedPaneBindingV1
	| RemoteHmuxManagedPaneBindingV1;

type CleanupAgent = Agent & { runtimeBinding: ManagedCleanupBinding };

export interface CleanupCompensationStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface ExitedManagedAgentCleanupCompensation {
	schemaVersion: typeof SCHEMA_VERSION;
	cleanupId: string;
	createdAtMs: number;
	phase: "prepared" | "replacement_observed";
	agent: Agent;
	replacementAgent?: Agent;
	sourceBinding: ManagedCleanupBinding;
	sourceTerminalEpoch?: string;
	desktopIds: string[];
}

interface CompensationDocument {
	schemaVersion: typeof SCHEMA_VERSION;
	records: ExitedManagedAgentCleanupCompensation[];
}

function boundedString(value: unknown, allowEmpty = false): string | undefined {
	if (typeof value !== "string") return undefined;
	if ((!allowEmpty && value.length === 0) || value.length > MAX_STRING_LENGTH) {
		return undefined;
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return value === undefined ? undefined : boundedString(value, true);
}

function terminalEnvironment(value: unknown): TerminalEnvironment | undefined {
	if (value === undefined) return undefined;
	const record = recordOf(value);
	if (
		!record ||
		!Object.entries(record).every(
			([key, entry]) =>
				TERMINAL_ENVIRONMENT_KEYS.has(key) &&
				(typeof entry === "string" || entry === null),
		)
	) {
		return undefined;
	}
	return { ...record } as TerminalEnvironment;
}

/** A cleanup tombstone keeps only the non-secret Agent fields needed to
 * restore the IDE-owned registration. Host-derived identity is deliberately
 * dropped and must be rebuilt from the replacement census. */
function cleanupAgent(value: unknown): CleanupAgent | undefined {
	const raw = recordOf(value);
	if (!raw) return undefined;
	const runtimeBinding = normalizeTerminalPaneBindingV1(raw.runtimeBinding);
	const providerId = raw.provider;
	const kind = raw.sessionKind;
	const id = boundedString(raw.id);
	const name = boundedString(raw.name);
	const projectId = boundedString(raw.projectId);
	const worktreePath = boundedString(raw.worktreePath);
	const branch = boundedString(raw.branch, true);
	const sessionId = boundedString(raw.sessionId);
	if (
		!id ||
		!name ||
		!projectId ||
		!worktreePath ||
		branch === undefined ||
		!sessionId ||
		(kind !== "pty" && kind !== "ssh") ||
		typeof providerId !== "string" ||
		!PROVIDER_IDS.has(providerId as Provider) ||
		runtimeBinding?.runtime !== "hmux_managed_v1" ||
		(runtimeBinding.source === "local" &&
			(kind !== "pty" || runtimeBinding.hostId !== "local")) ||
		(runtimeBinding.source === "ssh" && kind !== "ssh") ||
		runtimeBinding.sessionId !== sessionId
	) {
		return undefined;
	}
	const displayName = optionalString(raw.displayName);
	const terminalEnv = terminalEnvironment(raw.terminalEnv);
	if (raw.terminalEnv !== undefined && !terminalEnv) return undefined;
	const comment = optionalString(raw.comment);
	const accountId =
		raw.accountId === null ? null : optionalString(raw.accountId);
	const credentialId = optionalString(raw.credentialId);
	const conversationId = optionalString(raw.conversationId);
	if (
		(raw.displayName !== undefined && displayName === undefined) ||
		(raw.comment !== undefined && comment === undefined) ||
		(raw.accountId !== undefined && accountId === undefined) ||
		(raw.credentialId !== undefined && credentialId === undefined) ||
		(raw.conversationId !== undefined && conversationId === undefined) ||
		(raw.started !== undefined && typeof raw.started !== "boolean") ||
		(raw.skipPermissions !== undefined &&
			typeof raw.skipPermissions !== "boolean") ||
		(raw.commentUpdatedAt !== undefined &&
			(typeof raw.commentUpdatedAt !== "number" ||
				!Number.isFinite(raw.commentUpdatedAt)))
	) {
		return undefined;
	}
	return {
		id,
		name,
		...(displayName !== undefined ? { displayName } : {}),
		provider: providerId as Provider,
		projectId,
		worktreePath,
		branch,
		sessionId,
		sessionKind: kind,
		runtimeBinding,
		...(raw.started !== undefined ? { started: raw.started as boolean } : {}),
		...(terminalEnv ? { terminalEnv } : {}),
		...(comment !== undefined ? { comment } : {}),
		...(raw.commentUpdatedAt !== undefined
			? { commentUpdatedAt: raw.commentUpdatedAt as number }
			: {}),
		...(raw.accountId !== undefined ? { accountId } : {}),
		...(raw.skipPermissions !== undefined
			? { skipPermissions: raw.skipPermissions as boolean }
			: {}),
		...(credentialId !== undefined ? { credentialId } : {}),
		...(conversationId !== undefined ? { conversationId } : {}),
	} as CleanupAgent;
}

function cleanupIdentity(
	agentId: string,
	binding: ManagedCleanupBinding,
	sourceTerminalEpoch: string | undefined,
): string {
	if (binding.source === "ssh") {
		return JSON.stringify([
			agentId,
			binding.source,
			binding.hostId,
			binding.workspaceId,
			binding.sessionId,
			binding.createIdempotencyKey,
			binding.commandBridgeNonce,
			binding.stopFence ?? null,
			sourceTerminalEpoch ?? null,
		]);
	}
	return JSON.stringify([
		agentId,
		binding.workspaceId,
		binding.sessionId,
		binding.createIdempotencyKey ?? null,
		binding.stopFence ?? null,
		sourceTerminalEpoch ?? null,
	]);
}

export function sameExitedManagedAgentCleanupBinding(
	left: ManagedCleanupBinding,
	right: ManagedCleanupBinding,
): boolean {
	if (
		left.source !== right.source ||
		left.hostId !== right.hostId ||
		left.sessionId !== right.sessionId ||
		left.workspaceId !== right.workspaceId ||
		left.createIdempotencyKey !== right.createIdempotencyKey ||
		!sameHmuxManagedGeneration(left.stopFence, right.stopFence)
	) {
		return false;
	}
	if (left.source === "ssh" && right.source === "ssh") {
		return left.commandBridgeNonce === right.commandBridgeNonce;
	}
	if (left.source === "local" && right.source === "local") {
		return (
			left.credentialId === right.credentialId &&
			left.credentialGeneration === right.credentialGeneration
		);
	}
	return false;
}

function normalizedRecord(
	value: unknown,
	nowMs: number,
): ExitedManagedAgentCleanupCompensation | undefined {
	const raw = recordOf(value);
	const agent = cleanupAgent(raw?.agent);
	const sourceBinding = normalizeTerminalPaneBindingV1(raw?.sourceBinding);
	const replacementAgent =
		raw?.replacementAgent === undefined
			? undefined
			: cleanupAgent(raw.replacementAgent);
	const cleanupId = boundedString(raw?.cleanupId);
	const createdAtMs = raw?.createdAtMs;
	const sourceTerminalEpoch = optionalString(raw?.sourceTerminalEpoch);
	const rawDesktopIds = raw?.desktopIds;
	const desktopIds = Array.isArray(rawDesktopIds)
		? [
				...new Set(
					rawDesktopIds.flatMap((entry) => {
						const id = boundedString(entry);
						return id ? [id] : [];
					}),
				),
			].slice(0, 32)
		: undefined;
	if (
		raw?.schemaVersion !== SCHEMA_VERSION ||
		!cleanupId ||
		!agent ||
		sourceBinding?.runtime !== "hmux_managed_v1" ||
		agent.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		agent.runtimeBinding.source !== sourceBinding.source ||
		agent.id.length === 0 ||
		agent.sessionId !== sourceBinding.sessionId ||
		typeof createdAtMs !== "number" ||
		!Number.isFinite(createdAtMs) ||
		createdAtMs < 0 ||
		createdAtMs > nowMs + 60_000 ||
		nowMs - createdAtMs > RETENTION_MS ||
		(raw.phase !== "prepared" && raw.phase !== "replacement_observed") ||
		(raw.phase === "prepared" && raw.replacementAgent !== undefined) ||
		(raw.phase === "replacement_observed" && !replacementAgent) ||
		desktopIds === undefined ||
		(raw.sourceTerminalEpoch !== undefined &&
			sourceTerminalEpoch === undefined) ||
		cleanupId !==
			cleanupIdentity(agent.id, sourceBinding, sourceTerminalEpoch) ||
		!sameExitedManagedAgentCleanupBinding(
			agent.runtimeBinding,
			sourceBinding,
		) ||
		(replacementAgent !== undefined &&
			(replacementAgent.id !== agent.id ||
				replacementAgent.sessionId !== sourceBinding.sessionId ||
				replacementAgent.runtimeBinding?.runtime !== "hmux_managed_v1" ||
				replacementAgent.runtimeBinding.source !== sourceBinding.source ||
				replacementAgent.runtimeBinding.hostId !== sourceBinding.hostId ||
				replacementAgent.runtimeBinding.workspaceId !==
					sourceBinding.workspaceId ||
				sameExitedManagedAgentCleanupBinding(
					replacementAgent.runtimeBinding,
					sourceBinding,
				)))
	) {
		return undefined;
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		cleanupId,
		createdAtMs,
		phase: raw.phase,
		agent,
		...(replacementAgent ? { replacementAgent } : {}),
		sourceBinding,
		...(sourceTerminalEpoch ? { sourceTerminalEpoch } : {}),
		desktopIds,
	};
}

function readDocument(
	storage: CleanupCompensationStorage,
	nowMs: number,
): CompensationDocument | undefined {
	let raw: string | null;
	try {
		raw = storage.getItem(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY);
	} catch {
		return undefined;
	}
	if (!raw) return { schemaVersion: SCHEMA_VERSION, records: [] };
	if (new TextEncoder().encode(raw).byteLength > MAX_DOCUMENT_BYTES) {
		return undefined;
	}
	try {
		const value = JSON.parse(raw) as unknown;
		const document = recordOf(value);
		if (
			document?.schemaVersion !== SCHEMA_VERSION ||
			!Array.isArray(document.records) ||
			document.records.length > MAX_RECORDS
		) {
			return undefined;
		}
		const records: ExitedManagedAgentCleanupCompensation[] = [];
		for (const entry of document.records) {
			const entryRecord = recordOf(entry);
			const createdAtMs = entryRecord?.createdAtMs;
			const normalized = normalizedRecord(entry, nowMs);
			if (normalized) {
				records.push(normalized);
				continue;
			}
			const isExpired =
				typeof createdAtMs === "number" &&
				Number.isFinite(createdAtMs) &&
				nowMs - createdAtMs > RETENTION_MS;
			if (!isExpired || !normalizedRecord(entry, createdAtMs)) {
				return undefined;
			}
		}
		return { schemaVersion: SCHEMA_VERSION, records };
	} catch {
		return undefined;
	}
}

function writeDocument(
	storage: CleanupCompensationStorage,
	document: CompensationDocument,
): boolean {
	const raw = JSON.stringify(document);
	if (new TextEncoder().encode(raw).byteLength > MAX_DOCUMENT_BYTES) {
		return false;
	}
	try {
		storage.setItem(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY, raw);
		return true;
	} catch {
		return false;
	}
}

export function stageExitedManagedAgentCleanupCompensation(input: {
	agent: Agent;
	sourceBinding: ManagedCleanupBinding;
	sourceTerminalEpoch?: string;
	desktopIds: readonly string[];
	storage: CleanupCompensationStorage;
	nowMs?: number;
}): boolean {
	const nowMs = input.nowMs ?? Date.now();
	const agent = cleanupAgent(input.agent);
	const sourceBinding = normalizeTerminalPaneBindingV1(input.sourceBinding);
	const sourceTerminalEpoch = optionalString(input.sourceTerminalEpoch);
	const desktopIds = [...new Set(input.desktopIds)].flatMap((entry) => {
		const id = boundedString(entry);
		return id ? [id] : [];
	});
	if (
		!agent ||
		sourceBinding?.runtime !== "hmux_managed_v1" ||
		agent.id !== input.agent.id ||
		agent.sessionId !== sourceBinding.sessionId ||
		agent.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		!sameExitedManagedAgentCleanupBinding(
			agent.runtimeBinding,
			sourceBinding,
		) ||
		(input.sourceTerminalEpoch !== undefined &&
			sourceTerminalEpoch === undefined) ||
		desktopIds.length !== new Set(input.desktopIds).size ||
		desktopIds.length > 32
	) {
		return false;
	}
	const document = readDocument(input.storage, nowMs);
	if (!document) return false;
	const cleanupId = cleanupIdentity(
		agent.id,
		sourceBinding,
		sourceTerminalEpoch,
	);
	const existing = document.records.find(
		(record) => record.cleanupId === cleanupId,
	);
	if (existing) {
		const desktopIds = [
			...new Set([...existing.desktopIds, ...input.desktopIds]),
		].slice(0, 32);
		if (desktopIds.length === existing.desktopIds.length) return true;
		return writeDocument(input.storage, {
			...document,
			records: document.records.map((record) =>
				record.cleanupId === cleanupId ? { ...record, desktopIds } : record,
			),
		});
	}
	if (document.records.length >= MAX_RECORDS) return false;
	return writeDocument(input.storage, {
		schemaVersion: SCHEMA_VERSION,
		records: [
			...document.records,
			{
				schemaVersion: SCHEMA_VERSION,
				cleanupId,
				createdAtMs: nowMs,
				phase: "prepared",
				agent,
				sourceBinding,
				...(sourceTerminalEpoch ? { sourceTerminalEpoch } : {}),
				desktopIds,
			},
		],
	});
}

export function exitedManagedAgentCleanupCompensations(
	storage: CleanupCompensationStorage,
	nowMs = Date.now(),
): readonly ExitedManagedAgentCleanupCompensation[] {
	return readDocument(storage, nowMs)?.records ?? [];
}

export function markExitedManagedAgentCleanupReplacement(
	storage: CleanupCompensationStorage,
	cleanupId: string,
	replacementAgent: Agent,
	nowMs = Date.now(),
): boolean {
	const document = readDocument(storage, nowMs);
	if (!document) return false;
	const target = document.records.find(
		(record) => record.cleanupId === cleanupId,
	);
	const normalizedReplacement = cleanupAgent(replacementAgent);
	if (
		!target ||
		!normalizedReplacement ||
		normalizedReplacement.id !== target.agent.id ||
		normalizedReplacement.sessionId !== target.sourceBinding.sessionId ||
		normalizedReplacement.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		normalizedReplacement.runtimeBinding.source !==
			target.sourceBinding.source ||
		normalizedReplacement.runtimeBinding.hostId !==
			target.sourceBinding.hostId ||
		normalizedReplacement.runtimeBinding.workspaceId !==
			target.sourceBinding.workspaceId ||
		sameExitedManagedAgentCleanupBinding(
			normalizedReplacement.runtimeBinding,
			target.sourceBinding,
		)
	) {
		return false;
	}
	return writeDocument(storage, {
		...document,
		records: document.records.map((record) =>
			record.cleanupId === cleanupId
				? {
						...record,
						phase: "replacement_observed",
						replacementAgent: normalizedReplacement,
					}
				: record,
		),
	});
}

export function updateExitedManagedAgentCleanupPendingDesktops(
	storage: CleanupCompensationStorage,
	cleanupId: string,
	desktopIds: readonly string[],
	nowMs = Date.now(),
): boolean {
	const document = readDocument(storage, nowMs);
	if (!document) return false;
	const target = document.records.find(
		(record) => record.cleanupId === cleanupId,
	);
	if (!target) return false;
	const normalized = [...new Set(desktopIds)].flatMap((entry) => {
		const id = boundedString(entry);
		return id ? [id] : [];
	});
	if (
		normalized.length !== new Set(desktopIds).size ||
		normalized.length > 32
	) {
		return false;
	}
	return writeDocument(storage, {
		...document,
		records: document.records.map((record) =>
			record.cleanupId === cleanupId
				? { ...record, desktopIds: normalized }
				: record,
		),
	});
}

export function retireExitedManagedAgentCleanupCompensation(
	storage: CleanupCompensationStorage,
	cleanupId: string,
	nowMs = Date.now(),
): boolean {
	const document = readDocument(storage, nowMs);
	if (!document) return false;
	const records = document.records.filter(
		(record) => record.cleanupId !== cleanupId,
	);
	if (records.length === document.records.length) return true;
	if (records.length === 0) {
		try {
			storage.removeItem(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY);
			return true;
		} catch {
			return false;
		}
	}
	return writeDocument(storage, { ...document, records });
}

export function replacementAgentFromCleanupCompensation(
	record: ExitedManagedAgentCleanupCompensation,
	summary: HmuxSessionSummary,
): Agent | undefined {
	if (
		record.sourceBinding.source !== "local" ||
		(record.phase !== "prepared" && record.phase !== "replacement_observed") ||
		summary.sessionId !== record.sourceBinding.sessionId ||
		summary.workspaceId !== record.sourceBinding.workspaceId ||
		summary.sessionClass !== "managed" ||
		summary.lifecycle !== "ready" ||
		(summary.health !== "current_healthy" &&
			summary.health !== "compatible_old_healthy") ||
		summary.hostProcessAlive === false ||
		!summary.stopFence ||
		summary.stopFence.terminalEpoch !== summary.terminalEpoch ||
		(record.sourceTerminalEpoch !== undefined &&
			summary.terminalEpoch === record.sourceTerminalEpoch) ||
		sameHmuxManagedGeneration(record.sourceBinding.stopFence, summary.stopFence)
	) {
		return undefined;
	}
	if (record.replacementAgent) {
		const binding = record.replacementAgent.runtimeBinding;
		if (
			binding?.runtime !== "hmux_managed_v1" ||
			!sameHmuxManagedGeneration(binding.stopFence, summary.stopFence)
		) {
			return undefined;
		}
		return record.replacementAgent;
	}
	const { conversationIdentity: _sourceIdentity, ...sourceBinding } =
		record.sourceBinding;
	return {
		...record.agent,
		sessionId: summary.sessionId,
		started: true,
		pendingCmd: undefined,
		pendingCredentialSwitch: undefined,
		conversationIdentity: undefined,
		runtimeBinding: {
			...sourceBinding,
			stopFence: summary.stopFence,
		},
	};
}

export function replacementAgentFromRemoteCleanupCompensation(
	record: ExitedManagedAgentCleanupCompensation,
	summary: RemoteHmuxCatalogSessionV1,
): Agent | undefined {
	if (
		record.sourceBinding.source !== "ssh" ||
		(record.phase !== "prepared" && record.phase !== "replacement_observed") ||
		summary.sessionId !== record.sourceBinding.sessionId ||
		summary.workspaceId !== record.sourceBinding.workspaceId ||
		summary.sessionClass !== "managed" ||
		summary.lifecycle !== "ready" ||
		summary.providerId !== record.agent.provider ||
		(record.sourceTerminalEpoch !== undefined &&
			summary.terminalEpoch === record.sourceTerminalEpoch)
	) {
		return undefined;
	}
	const stopFence = {
		runnerPrincipal: summary.runnerPrincipal,
		runnerInstance: summary.runnerInstance,
		channelEpoch: summary.channelEpoch,
		hostInstanceId: summary.hostInstanceId,
		terminalEpoch: summary.terminalEpoch,
	};
	if (sameHmuxManagedGeneration(record.sourceBinding.stopFence, stopFence)) {
		return undefined;
	}
	if (record.replacementAgent) {
		const binding = record.replacementAgent.runtimeBinding;
		if (
			binding?.runtime !== "hmux_managed_v1" ||
			binding.source !== "ssh" ||
			!sameHmuxManagedGeneration(binding.stopFence, stopFence)
		) {
			return undefined;
		}
		return record.replacementAgent;
	}
	const { conversationIdentity: _sourceIdentity, ...sourceBinding } =
		record.sourceBinding;
	return {
		...record.agent,
		sessionId: summary.sessionId,
		started: true,
		pendingCmd: undefined,
		pendingCredentialSwitch: undefined,
		conversationIdentity: undefined,
		runtimeBinding: { ...sourceBinding, stopFence },
	};
}

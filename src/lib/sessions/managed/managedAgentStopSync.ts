import { emit } from "@tauri-apps/api/event";
import {
	agentRemovalRegistrationIdentity,
	type ManagedAgentRemovalRegistrationIdentity,
	parseManagedAgentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import {
	isLegacyAgentWriterTarget,
	type LegacyAgentWriterTarget,
	requireLegacyAgentWriterTarget,
} from "@/lib/agents/agentWriterPartition";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	isManagedCreateChainStopReceiptV2,
	type LegacyOrderedManagedCreateChainStopEventReceiptV1,
	type ManagedCreateChainStopReceiptV1,
	managedCreateChainStopIncludesIdentity,
	managedCreateChainStopLegacyOrderedV1EventProjection,
	managedCreateChainStopLegacyV1Projection,
} from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import type { RemoteHmuxCatalogTargetV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	type HmuxManagedCreateChainStopReceipt,
	type HmuxManagedStopFenceV1,
	type HmuxManagedStopReceipt,
	prepareTrustedSshTarget,
} from "@/lib/ipc";
import { hasOnlyKeys, isRecord, nonEmptyString } from "@/lib/payloadGuards";
import type { requireAnyManagedAgentBinding } from "@/lib/sessions/managed/managedAgentTarget";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { useStore } from "@/store";
import type { Agent, Project, SshHostConfig } from "@/types";

export const MANAGED_AGENT_STOPPED_EVENT = "agent:managed-stopped:v3";
export const MANAGED_AGENT_CHAIN_STOPPED_EVENT =
	"agent:managed-chain-stopped:v1";
export const LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT =
	"agent:managed-stopped:v2";

export interface ManagedAgentStopTarget {
	readonly agent: LegacyAgentWriterTarget;
	readonly binding: ReturnType<typeof requireAnyManagedAgentBinding>;
	readonly remoteTarget?: RemoteHmuxCatalogTargetV1;
}

interface ManagedAgentStoppedSyncPayload {
	schemaVersion: 3;
	registration: ManagedAgentRemovalRegistrationIdentity;
	receipt: HmuxManagedStopReceipt;
}

interface ManagedAgentChainStoppedSyncPayload {
	schemaVersion: 4;
	registration: ManagedAgentRemovalRegistrationIdentity;
	authority: ManagedAgentChainStopAuthority;
	receipt: HmuxManagedCreateChainStopReceipt;
}

type ManagedAgentChainStopAuthority =
	| { readonly source: "local" }
	| { readonly source: "ssh"; readonly target: TrustedSshTargetV1 };

interface LegacyManagedAgentStoppedSyncPayloadV2 {
	readonly schemaVersion: 2;
	readonly agentId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly stopFence: HmuxManagedStopFenceV1;
	readonly sourceStopFence?: HmuxManagedStopFenceV1;
	readonly receipt: HmuxManagedStopReceipt;
}

interface LegacyManagedAgentChainStoppedSyncPayloadV3Frozen {
	readonly schemaVersion: 3;
	readonly agentId: string;
	readonly source: "local";
	readonly hostId: string;
	readonly idempotencyKey: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly receipt: ManagedCreateChainStopReceiptV1;
}

interface LegacyManagedAgentChainStoppedSyncPayloadV3Ordered {
	readonly schemaVersion: 3;
	readonly agentId: string;
	readonly source: "local";
	readonly hostId: string;
	readonly receipt: LegacyOrderedManagedCreateChainStopEventReceiptV1;
}

type LegacyManagedAgentChainStoppedSyncPayload =
	| LegacyManagedAgentStoppedSyncPayloadV2
	| LegacyManagedAgentChainStoppedSyncPayloadV3Frozen
	| LegacyManagedAgentChainStoppedSyncPayloadV3Ordered;

export type ManagedAgentStopReceipt =
	| HmuxManagedStopReceipt
	| HmuxManagedCreateChainStopReceipt;

function receiptMatchesIdentity(
	receipt: HmuxManagedStopReceipt,
	sessionId: string,
	workspaceId: string,
): boolean {
	return (
		typeof receipt.stopId === "string" &&
		receipt.stopId.length > 0 &&
		receipt.sessionId === sessionId &&
		receipt.workspaceId === workspaceId &&
		typeof receipt.runnerPrincipal === "string" &&
		receipt.runnerPrincipal.length > 0 &&
		typeof receipt.runnerInstance === "string" &&
		receipt.runnerInstance.length > 0 &&
		typeof receipt.channelEpoch === "number" &&
		Number.isSafeInteger(receipt.channelEpoch) &&
		receipt.channelEpoch >= 0 &&
		typeof receipt.hostInstanceId === "string" &&
		receipt.hostInstanceId.length > 0 &&
		typeof receipt.terminalEpoch === "string" &&
		receipt.terminalEpoch.length > 0 &&
		(receipt.outcome === "stopped" || receipt.outcome === "already_exited") &&
		typeof receipt.exitReason === "string"
	);
}

function managedStopReceiptGeneration(
	receipt: HmuxManagedStopReceipt,
): HmuxManagedStopFenceV1 {
	return {
		runnerPrincipal: receipt.runnerPrincipal,
		runnerInstance: receipt.runnerInstance,
		channelEpoch: receipt.channelEpoch.toString(),
		hostInstanceId: receipt.hostInstanceId,
		terminalEpoch: receipt.terminalEpoch,
	};
}

export function remoteStopAuthorityIdentity(
	target: RemoteHmuxCatalogTargetV1,
): string {
	return JSON.stringify([
		target.schemaVersion,
		target.hostId,
		target.host,
		target.port,
		target.user,
		target.auth,
		target.secretId ?? null,
		target.keyPath ?? null,
		[...target.hostKeyFingerprints].sort(),
	]);
}

function configuredSshStopAuthorityIdentity(
	hosts: readonly SshHostConfig[],
	hostId: string,
): string | undefined {
	const host = hosts.find((candidate) => candidate.id === hostId);
	return host
		? JSON.stringify([
				host.id,
				host.host,
				host.port,
				host.user,
				host.auth,
				sshHostSecretId(host) ?? null,
				host.password ?? null,
				host.keyPath ?? null,
			])
		: undefined;
}

function managedChainStopAuthority(
	target: ManagedAgentStopTarget,
): ManagedAgentChainStopAuthority {
	if (target.binding.source === "local") return { source: "local" };
	const remote = target.remoteTarget;
	if (!remote || remote.hostId !== target.binding.hostId) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Agent and frozen SSH cleanup authority disagree",
		);
	}
	return {
		source: "ssh",
		target: {
			...remote,
			hostKeyFingerprints: [...remote.hostKeyFingerprints],
		},
	};
}

function parseManagedChainStopAuthority(
	value: unknown,
): ManagedAgentChainStopAuthority | undefined {
	if (!isRecord(value)) return undefined;
	if (value.source === "local") {
		return hasOnlyKeys(value, ["source"]) ? { source: "local" } : undefined;
	}
	if (
		value.source !== "ssh" ||
		!hasOnlyKeys(value, ["source", "target"]) ||
		!isRecord(value.target)
	) {
		return undefined;
	}
	const target = value.target;
	const fingerprints = target.hostKeyFingerprints;
	if (
		target.schemaVersion !== 1 ||
		!nonEmptyString(target.hostId) ||
		!nonEmptyString(target.host) ||
		!Number.isSafeInteger(target.port) ||
		Number(target.port) < 1 ||
		Number(target.port) > 65_535 ||
		!nonEmptyString(target.user) ||
		(target.auth !== "auto" &&
			target.auth !== "password" &&
			target.auth !== "key") ||
		(target.secretId !== undefined && !nonEmptyString(target.secretId)) ||
		(target.keyPath !== undefined && !nonEmptyString(target.keyPath)) ||
		!Array.isArray(fingerprints) ||
		fingerprints.length === 0 ||
		!fingerprints.every(nonEmptyString) ||
		!hasOnlyKeys(target, [
			"schemaVersion",
			"hostId",
			"host",
			"port",
			"user",
			"auth",
			"secretId",
			"keyPath",
			"hostKeyFingerprints",
		])
	) {
		return undefined;
	}
	return {
		source: "ssh",
		target: {
			schemaVersion: 1,
			hostId: target.hostId,
			host: target.host,
			port: Number(target.port),
			user: target.user,
			auth: target.auth,
			...(target.secretId ? { secretId: target.secretId } : {}),
			...(target.keyPath ? { keyPath: target.keyPath } : {}),
			hostKeyFingerprints: [...fingerprints],
		},
	};
}

function managedStopRegistration(
	target: ManagedAgentStopTarget,
): ManagedAgentRemovalRegistrationIdentity {
	const registration = agentRemovalRegistrationIdentity(target.agent);
	if (registration.runtimeBinding?.runtime !== "hmux_managed_v1") {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux stop target lost its registered binding",
		);
	}
	return {
		...registration,
		runtimeBinding: registration.runtimeBinding,
	};
}

function managedAgentStoppedSyncPayload(
	target: ManagedAgentStopTarget,
	receipt: HmuxManagedStopReceipt,
): ManagedAgentStoppedSyncPayload {
	if (
		!receiptMatchesIdentity(
			receipt,
			target.binding.sessionId,
			target.binding.workspaceId,
		)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux stop receipt cannot remove a different agent",
		);
	}
	return {
		schemaVersion: 3,
		registration: managedStopRegistration(target),
		receipt,
	};
}

function managedAgentChainStoppedSyncPayload(
	target: ManagedAgentStopTarget,
	receipt: HmuxManagedCreateChainStopReceipt,
): ManagedAgentChainStoppedSyncPayload {
	const { binding } = target;
	const idempotencyKey = binding.createIdempotencyKey;
	if (
		idempotencyKey === undefined ||
		!managedCreateChainStopIncludesIdentity(receipt, {
			idempotencyKey,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		})
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed Hmux chain-stop receipt cannot remove a different agent",
		);
	}
	return {
		schemaVersion: 4,
		registration: managedStopRegistration(target),
		authority: managedChainStopAuthority(target),
		receipt,
	};
}

function legacyManagedAgentChainStoppedSyncPayloads(
	target: ManagedAgentStopTarget,
	receipt: HmuxManagedCreateChainStopReceipt,
): LegacyManagedAgentChainStoppedSyncPayload[] {
	if (target.binding.source !== "local") return [];
	const envelope = {
		agentId: target.agent.id,
		source: "local" as const,
		hostId: target.binding.hostId,
	};
	const payloads: LegacyManagedAgentChainStoppedSyncPayload[] =
		receipt.chain.map((identity) => ({
			schemaVersion: 3,
			...envelope,
			idempotencyKey: identity.idempotencyKey,
			sessionId: identity.sessionId,
			workspaceId: identity.workspaceId,
			receipt: managedCreateChainStopLegacyV1Projection(receipt, identity),
		}));
	if (receipt.stopReceipt) {
		const stopFence = managedStopReceiptGeneration(receipt.stopReceipt);
		const sourceStopFence =
			target.binding.stopFence &&
			!sameHmuxManagedGeneration(target.binding.stopFence, stopFence)
				? target.binding.stopFence
				: undefined;
		payloads.unshift({
			schemaVersion: 2,
			agentId: target.agent.id,
			sessionId: receipt.stopReceipt.sessionId,
			workspaceId: receipt.stopReceipt.workspaceId,
			stopFence,
			...(sourceStopFence ? { sourceStopFence } : {}),
			receipt: receipt.stopReceipt,
		});
	}
	payloads.push({
		schemaVersion: 3,
		...envelope,
		receipt: managedCreateChainStopLegacyOrderedV1EventProjection(receipt),
	});
	return payloads;
}

function parseManagedAgentStoppedSyncPayload(
	value: unknown,
): ManagedAgentStoppedSyncPayload | undefined {
	if (!isRecord(value)) return undefined;
	const payload = value as Partial<ManagedAgentStoppedSyncPayload>;
	const registration = parseManagedAgentRemovalRegistrationIdentity(
		payload.registration,
	);
	if (
		payload.schemaVersion !== 3 ||
		!registration ||
		!payload.receipt ||
		!receiptMatchesIdentity(
			payload.receipt,
			registration.runtimeBinding.sessionId,
			registration.runtimeBinding.workspaceId,
		) ||
		!hasOnlyKeys(value, ["schemaVersion", "registration", "receipt"])
	) {
		return undefined;
	}
	return {
		schemaVersion: 3,
		registration,
		receipt: payload.receipt,
	};
}

function parseManagedAgentChainStoppedSyncPayload(
	value: unknown,
): ManagedAgentChainStoppedSyncPayload | undefined {
	if (!isRecord(value)) return undefined;
	const payload = value as Partial<ManagedAgentChainStoppedSyncPayload>;
	const registration = parseManagedAgentRemovalRegistrationIdentity(
		payload.registration,
	);
	const binding = registration?.runtimeBinding;
	const authority = parseManagedChainStopAuthority(payload.authority);
	if (
		payload.schemaVersion !== 4 ||
		!registration ||
		binding?.runtime !== "hmux_managed_v1" ||
		registration.sessionId !== binding.sessionId ||
		authority?.source !== binding.source ||
		(authority.source === "ssh" &&
			authority.target.hostId !== binding.hostId) ||
		binding.createIdempotencyKey === undefined ||
		!isManagedCreateChainStopReceiptV2(payload.receipt, {
			idempotencyKey: binding.createIdempotencyKey,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		}) ||
		!hasOnlyKeys(value, [
			"schemaVersion",
			"registration",
			"authority",
			"receipt",
		])
	) {
		return undefined;
	}
	return {
		schemaVersion: 4,
		registration,
		authority,
		receipt: payload.receipt,
	};
}

async function removeManagedAgentDurably(
	agentId: string,
	sessionId: string,
	applies: (
		agent: Agent,
		projects: readonly Project[],
		sshHosts: readonly SshHostConfig[],
	) => boolean,
): Promise<boolean> {
	return removeAgentProjectionDurably({
		agents: [
			{
				agentId,
				panelIds: [`agent:${agentId}`],
				sessionIds: [sessionId],
				applies,
			},
		],
	});
}

export async function applyManagedAgentStoppedSync(
	value: unknown,
): Promise<boolean> {
	const stopped = parseManagedAgentStoppedSyncPayload(value);
	if (!stopped) return false;
	return removeManagedAgentDurably(
		stopped.registration.id,
		stopped.registration.sessionId,
		(agent, projects) =>
			isLegacyAgentWriterTarget(agent) &&
			managedStoppedPayloadAppliesToAgent(stopped, agent, projects),
	);
}

export async function applyManagedAgentChainStoppedSync(
	value: unknown,
): Promise<boolean> {
	const stopped = parseManagedAgentChainStoppedSyncPayload(value);
	if (!stopped) return false;
	let configuredAuthority: string | undefined;
	if (stopped.authority.source === "ssh") {
		const projected = await recoverCurrentDurableStoreProjection();
		if (!projected) return false;
		const state = useStore.getState();
		configuredAuthority = configuredSshStopAuthorityIdentity(
			state.sshHosts,
			stopped.authority.target.hostId,
		);
		if (configuredAuthority === undefined) return false;
		try {
			const trusted = await prepareTrustedSshTarget(
				state.sshHosts,
				stopped.authority.target.hostId,
			);
			if (
				remoteStopAuthorityIdentity(trusted) !==
				remoteStopAuthorityIdentity(stopped.authority.target)
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return removeManagedAgentDurably(
		stopped.registration.id,
		stopped.registration.sessionId,
		(agent, projects, sshHosts) =>
			isLegacyAgentWriterTarget(agent) &&
			managedChainStoppedPayloadMatchesAgent(stopped, agent, projects) &&
			(stopped.authority.source === "local" ||
				configuredSshStopAuthorityIdentity(
					sshHosts,
					stopped.authority.target.hostId,
				) === configuredAuthority),
	);
}

function bindingAuthorizesStoppedFence(
	binding: ManagedAgentStopTarget["binding"],
	stoppedFence: HmuxManagedStopFenceV1,
	registeredFence?: HmuxManagedStopFenceV1,
): boolean {
	if (!binding.stopFence) return registeredFence === undefined;
	if (sameHmuxManagedGeneration(binding.stopFence, stoppedFence)) return true;
	return (
		registeredFence !== undefined &&
		sameHmuxManagedGeneration(binding.stopFence, registeredFence)
	);
}

function managedStoppedPayloadAppliesToAgent(
	payload: ManagedAgentStoppedSyncPayload,
	agent: Agent,
	projects: readonly Project[],
): boolean {
	const binding = bindingForAgent(agent, projects);
	const stoppedFence = managedStopReceiptGeneration(payload.receipt);
	return (
		sameAgentRemovalTarget(agent, payload.registration) &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.sessionId === payload.receipt.sessionId &&
		binding.workspaceId === payload.receipt.workspaceId &&
		bindingAuthorizesStoppedFence(
			binding,
			stoppedFence,
			payload.registration.runtimeBinding.stopFence,
		)
	);
}

function managedChainStoppedPayloadMatchesAgent(
	payload: ManagedAgentChainStoppedSyncPayload,
	agent: Agent,
	projects: readonly Project[],
): boolean {
	const binding = bindingForAgent(agent, projects);
	const registeredBinding = payload.registration.runtimeBinding;
	return (
		binding?.runtime === "hmux_managed_v1" &&
		binding.sessionId === agent.sessionId &&
		binding.source === registeredBinding.source &&
		binding.source === payload.authority.source &&
		binding.hostId === registeredBinding.hostId &&
		binding.backendProfileId === registeredBinding.backendProfileId &&
		sameAgentRemovalTarget(agent, {
			...payload.registration,
			sessionId: agent.sessionId,
			runtimeBinding: agent.runtimeBinding,
		}) &&
		binding.createIdempotencyKey !== undefined &&
		managedCreateChainStopIncludesIdentity(payload.receipt, {
			idempotencyKey: binding.createIdempotencyKey,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		})
	);
}

async function managedChainStoppedAuthorityApplies(
	payload: ManagedAgentChainStoppedSyncPayload,
	agent: Agent,
	projects: readonly Project[],
	sshHosts: readonly SshHostConfig[],
): Promise<boolean> {
	if (!managedChainStoppedPayloadMatchesAgent(payload, agent, projects)) {
		return false;
	}
	if (payload.authority.source === "local") return true;
	const binding = bindingForAgent(agent, projects);
	if (binding?.runtime !== "hmux_managed_v1") return false;
	try {
		const currentTarget = await prepareTrustedSshTarget(
			sshHosts,
			binding.hostId,
		);
		return (
			remoteStopAuthorityIdentity(currentTarget) ===
			remoteStopAuthorityIdentity(payload.authority.target)
		);
	} catch {
		return false;
	}
}

/** Tests a live projection against the Host stop receipt that owns cleanup. */
export async function managedAgentStopReceiptAppliesToAgent(
	target: ManagedAgentStopTarget,
	receipt: ManagedAgentStopReceipt,
	agent: Agent,
	projects: readonly Project[],
	sshHosts: readonly SshHostConfig[],
): Promise<boolean> {
	if ("chain" in receipt) {
		return await managedChainStoppedAuthorityApplies(
			managedAgentChainStoppedSyncPayload(target, receipt),
			agent,
			projects,
			sshHosts,
		);
	}
	return managedStoppedPayloadAppliesToAgent(
		managedAgentStoppedSyncPayload(target, receipt),
		agent,
		projects,
	);
}

export async function finalizeManagedAgentRemoval(
	target: ManagedAgentStopTarget,
	receipt: ManagedAgentStopReceipt,
): Promise<void> {
	const current = useStore
		.getState()
		.agents.find((agent) => agent.id === target.agent.id);
	if (current) requireLegacyAgentWriterTarget(current);
	if ("chain" in receipt) {
		const payload = managedAgentChainStoppedSyncPayload(target, receipt);
		for (const legacy of legacyManagedAgentChainStoppedSyncPayloads(
			target,
			receipt,
		)) {
			await emit(LEGACY_MANAGED_AGENT_CHAIN_STOPPED_EVENT, legacy);
		}
		await emit(MANAGED_AGENT_CHAIN_STOPPED_EVENT, payload);
		if (!(await applyManagedAgentChainStoppedSync(payload))) {
			throw new PaneCommandError(
				"pane_changed",
				"managed agent binding changed after provider stop",
			);
		}
		return;
	}
	const payload = managedAgentStoppedSyncPayload(target, receipt);
	// Broadcast before local mutation. If the event bridge is unavailable, the
	// durable binding stays resolvable so a retry can receive already_exited and
	// finish cleanup instead of stranding other WebViews.
	await emit(MANAGED_AGENT_STOPPED_EVENT, payload);
	if (!(await applyManagedAgentStoppedSync(payload))) {
		throw new PaneCommandError(
			"pane_changed",
			"managed agent binding changed after provider stop",
		);
	}
}

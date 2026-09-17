import {
	type ManagedCreateAdvanceResolution,
	parseManagedCreateAdvanceResolution,
} from "@/lib/hmux/managed/managedCreateResolution";
import {
	isManagedRehostTargetReceiptV1,
	isManagedStopReceiptV2,
	type ManagedRehostTargetReceiptV1,
	type ManagedStopReceiptV2,
} from "@/lib/hmux/managed/managedRehostTargetReceipt";
import { hasOnlyKeys } from "@/lib/payloadGuards";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import type { SshHostConfig } from "@/types";

const REMOTE_HMUX_BROKER_SCHEMA_VERSION = 1 as const;

export interface RemoteHmuxHostTrustV1 {
	schemaVersion: typeof REMOTE_HMUX_BROKER_SCHEMA_VERSION;
	hostId: string;
	hostKeyFingerprints: readonly string[];
}

/** Hmux consumes the same pinned SSH authority as every other remote adapter. */
export type RemoteHmuxCatalogTargetV1 = TrustedSshTargetV1;

interface RemoteHmuxProtocolVersionV1 {
	major: number;
	minor: number;
}

interface RemoteHmuxRetirementPolicyV1 {
	kind: "after_graceful_last_client_departure_v1";
	gracePeriodMs: number;
}

export interface RemoteHmuxCatalogSessionV1 {
	sessionId: string;
	sessionName?: string;
	workspaceId: string;
	sessionClass: "managed" | "standalone";
	lifecycle: "ready" | "exited";
	providerId: string;
	runnerPrincipal: string;
	runnerInstance: string;
	channelEpoch: string;
	hostInstanceId: string;
	terminalEpoch: string;
	supportedProtocol: {
		minimum: RemoteHmuxProtocolVersionV1;
		maximum: RemoteHmuxProtocolVersionV1;
	};
	capabilities: string[];
	retirementPolicy?: RemoteHmuxRetirementPolicyV1;
	launchProgram?: string;
	hostLiveness?: "live" | "absent" | "unknown";
	/** Build selected by the remote gateway's current installation pointer. */
	gatewayBuildId?: string;
}

export interface RemoteHmuxCatalogReceiptV1 {
	schemaVersion: typeof REMOTE_HMUX_BROKER_SCHEMA_VERSION;
	hostId: string;
	sessions: RemoteHmuxCatalogSessionV1[];
}

interface RemoteHmuxCommandInterceptV1 {
	command: string;
	providerId: string;
}

export interface RemoteHmuxStandaloneCreateRequestV1 {
	target: RemoteHmuxCatalogTargetV1;
	requestId: string;
	targetSessionId: string;
	launchOwnerProof: string;
	sessionName: string;
	bridgeNonce: string;
	cwd?: string;
	initialRows: number;
	initialColumns: number;
	commandIntercepts: RemoteHmuxCommandInterceptV1[];
}

export interface RemoteHmuxStandaloneCreateReceiptV1 {
	requestId: string;
	bridgeNonce: string;
	session: RemoteHmuxCatalogSessionV1;
}

export interface RemoteManagedLaunchOptions {
	model?: string;
	effort?: string;
	permissionOverride?: "require_approvals" | "auto_edit" | "bypass_approvals";
	setupCommand?: string;
}

export interface RemoteHmuxManagedCreateRequestV1 {
	launchOptions?: RemoteManagedLaunchOptions;
	target: RemoteHmuxCatalogTargetV1;
	idempotencyKey: string;
	sessionId: string;
	workspaceId: string;
	providerId: string;
	conversationId?: string;
	permissionMode: "default" | "bypass_approvals";
	bridgeNonce: string;
	cwd: string;
	/** Deprecated transport field for backend rolling compatibility. */
	command: string;
	initialPrompt?: string;
	initialRows: number;
	initialColumns: number;
	terminalEnvironment: Record<string, string | null>;
	credentialId?: string;
	credentialProfileDirectory?: string;
}

export interface RemoteHmuxManagedCreateReceiptV1 {
	idempotencyKey: string;
	bridgeNonce: string;
	outcome: "created" | "reused";
	initialPromptAccepted?: boolean;
	session: RemoteHmuxCatalogSessionV1 & {
		sessionClass: "managed";
	};
}

export type RemoteHmuxManagedCreateAdvanceResolutionV1 =
	ManagedCreateAdvanceResolution<RemoteHmuxManagedCreateReceiptV1>;

export interface RemoteHmuxManagedRehostRequestV1 {
	target: RemoteHmuxCatalogTargetV1;
	operationId: string;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	sourceFence: {
		runnerPrincipal: string;
		runnerInstance: string;
		channelEpoch: string;
		hostInstanceId: string;
		terminalEpoch: string;
	};
	providerId: string;
	conversationId: string | null;
	freshSourceGuard?: { runtimeRevision: string; outputSequence: string };
	expectedTargetBuildId?: string;
	permissionMode: "default" | "bypass_approvals";
	cwd: string;
	initialRows: number;
	initialColumns: number;
	terminalEnvironment: Record<string, string | null>;
	targetCredentialId?: string;
	targetCredentialProfileDirectory?: string;
	bridgeNonce: string;
}

export interface RemoteHmuxManagedRehostReconcileRequestV1 {
	target: RemoteHmuxCatalogTargetV1;
	operationId: string;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	bridgeNonce: string;
}

export interface RemoteHmuxManagedRehostReceiptV1 {
	operationId: string;
	bridgeNonce: string;
	conversationId: string | null;
	launchReference?: string;
	replayed: boolean;
	sourceStopReceipt: {
		stopId: string;
		sessionId: string;
		workspaceId: string;
		runnerPrincipal: string;
		runnerInstance: string;
		channelEpoch: string;
		hostInstanceId: string;
		terminalEpoch: string;
		outcome: "stopped" | "already_exited";
		exitReason: string;
	};
	replacement: ManagedRehostTargetReceiptV1;
}

export interface RemoteHmuxManagedStopRequestV1 {
	target: RemoteHmuxCatalogTargetV1;
	stopId: string;
	sessionId: string;
	workspaceId: string;
	expectedFence: {
		runnerPrincipal: string;
		runnerInstance: string;
		channelEpoch: string;
		hostInstanceId: string;
		terminalEpoch: string;
	};
}

export interface RemoteHmuxManagedCreateChainStopRequestV2 {
	target: RemoteHmuxCatalogTargetV1;
	idempotencyKey: string;
	sessionId: string;
	workspaceId: string;
}

export type RemoteHmuxManagedStopReceiptV1 = ManagedStopReceiptV2;

const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const SHA256_HOST_KEY = /^SHA256:[A-Za-z0-9+/_=-]{16,128}$/;
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

function safeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && SAFE_OPAQUE_ID.test(value);
}

function decimalU64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		DECIMAL_U64.test(value) &&
		BigInt(value) <= MAX_U64
	);
}

function protocolVersion(value: unknown): value is RemoteHmuxProtocolVersionV1 {
	if (!value || typeof value !== "object") return false;
	const version = value as Record<string, unknown>;
	return (
		Number.isInteger(version.major) &&
		(version.major as number) >= 0 &&
		(version.major as number) <= 65_535 &&
		Number.isInteger(version.minor) &&
		(version.minor as number) >= 0 &&
		(version.minor as number) <= 65_535 &&
		hasOnlyKeys(version, ["major", "minor"])
	);
}

function supportedProtocol(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const range = value as Record<string, unknown>;
	return (
		protocolVersion(range.minimum) &&
		protocolVersion(range.maximum) &&
		hasOnlyKeys(range, ["minimum", "maximum"])
	);
}

function retirementPolicy(
	value: unknown,
): value is RemoteHmuxRetirementPolicyV1 {
	if (!value || typeof value !== "object") return false;
	const policy = value as Record<string, unknown>;
	return (
		policy.kind === "after_graceful_last_client_departure_v1" &&
		Number.isInteger(policy.gracePeriodMs) &&
		(policy.gracePeriodMs as number) >= 1_000 &&
		(policy.gracePeriodMs as number) <= 300_000 &&
		hasOnlyKeys(policy, ["kind", "gracePeriodMs"])
	);
}

function isRemoteHmuxCatalogSessionV1(
	value: unknown,
): value is RemoteHmuxCatalogSessionV1 {
	if (!value || typeof value !== "object") return false;
	const session = value as Record<string, unknown>;
	return (
		safeOpaqueId(session.sessionId) &&
		(session.sessionName === undefined ||
			(typeof session.sessionName === "string" &&
				session.sessionName.length > 0 &&
				session.sessionName.length <= 256)) &&
		safeOpaqueId(session.workspaceId) &&
		(session.sessionClass === "managed" ||
			session.sessionClass === "standalone") &&
		(session.lifecycle === "ready" || session.lifecycle === "exited") &&
		safeOpaqueId(session.providerId) &&
		safeOpaqueId(session.runnerPrincipal) &&
		safeOpaqueId(session.runnerInstance) &&
		decimalU64(session.channelEpoch) &&
		safeOpaqueId(session.hostInstanceId) &&
		safeOpaqueId(session.terminalEpoch) &&
		supportedProtocol(session.supportedProtocol) &&
		Array.isArray(session.capabilities) &&
		session.capabilities.length <= 256 &&
		session.capabilities.every(safeOpaqueId) &&
		(session.retirementPolicy === undefined ||
			retirementPolicy(session.retirementPolicy)) &&
		(session.launchProgram === undefined ||
			(typeof session.launchProgram === "string" &&
				session.launchProgram.length > 0 &&
				session.launchProgram.length <= 256)) &&
		(session.hostLiveness === undefined ||
			session.hostLiveness === "live" ||
			session.hostLiveness === "absent" ||
			session.hostLiveness === "unknown") &&
		(session.gatewayBuildId === undefined ||
			safeOpaqueId(session.gatewayBuildId)) &&
		hasOnlyKeys(session, [
			"sessionId",
			"sessionName",
			"workspaceId",
			"sessionClass",
			"lifecycle",
			"providerId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
			"supportedProtocol",
			"capabilities",
			"retirementPolicy",
			"launchProgram",
			"hostLiveness",
			"gatewayBuildId",
		])
	);
}

export function isRemoteHmuxHostTrustV1(
	value: unknown,
	expectedHostId?: string,
): value is RemoteHmuxHostTrustV1 {
	if (!value || typeof value !== "object") return false;
	const trust = value as Record<string, unknown>;
	return (
		trust.schemaVersion === REMOTE_HMUX_BROKER_SCHEMA_VERSION &&
		safeOpaqueId(trust.hostId) &&
		(expectedHostId === undefined || trust.hostId === expectedHostId) &&
		Array.isArray(trust.hostKeyFingerprints) &&
		trust.hostKeyFingerprints.length > 0 &&
		trust.hostKeyFingerprints.length <= 32 &&
		trust.hostKeyFingerprints.every(
			(value) => typeof value === "string" && SHA256_HOST_KEY.test(value),
		) &&
		hasOnlyKeys(trust, ["schemaVersion", "hostId", "hostKeyFingerprints"])
	);
}

/** Resolves a target only from the registered host collection and separately
 * enrolled trust. Missing pins fail before any SSH connection can begin. */
export function planRemoteHmuxCatalogTarget(
	hosts: readonly SshHostConfig[],
	hostId: string,
	trust: RemoteHmuxHostTrustV1,
): RemoteHmuxCatalogTargetV1 {
	const host = hosts.find((candidate) => candidate.id === hostId);
	if (!host) throw new Error("remote_hmux_host_not_registered");
	if (!isRemoteHmuxHostTrustV1(trust, hostId)) {
		throw new Error("remote_hmux_host_untrusted");
	}
	const secretId = sshHostSecretId(host);
	if (host.auth === "password" && !secretId) {
		throw new Error("remote_hmux_password_unavailable");
	}
	if (host.auth === "key" && !host.keyPath) {
		throw new Error("remote_hmux_key_unavailable");
	}
	if (
		host.host.trim().length === 0 ||
		host.user.trim().length === 0 ||
		!Number.isInteger(host.port) ||
		host.port < 1 ||
		host.port > 65_535
	) {
		throw new Error("remote_hmux_target_invalid");
	}
	return {
		schemaVersion: REMOTE_HMUX_BROKER_SCHEMA_VERSION,
		hostId,
		host: host.host,
		port: host.port,
		user: host.user,
		auth: host.auth,
		...(secretId ? { secretId } : {}),
		...(host.keyPath ? { keyPath: host.keyPath } : {}),
		hostKeyFingerprints: [...new Set(trust.hostKeyFingerprints)],
	};
}

export function isRemoteHmuxCatalogReceiptV1(
	value: unknown,
	expectedHostId?: string,
): value is RemoteHmuxCatalogReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.schemaVersion === REMOTE_HMUX_BROKER_SCHEMA_VERSION &&
		safeOpaqueId(receipt.hostId) &&
		(expectedHostId === undefined || receipt.hostId === expectedHostId) &&
		Array.isArray(receipt.sessions) &&
		receipt.sessions.length <= 1_024 &&
		receipt.sessions.every(isRemoteHmuxCatalogSessionV1) &&
		hasOnlyKeys(receipt, ["schemaVersion", "hostId", "sessions"])
	);
}

/** 상자 하나를 이 앱이 들고 있는 빌드로 맞춘 결과. */
export interface RemoteHmuxProvisionReceiptV1 {
	schemaVersion: number;
	hostId: string;
	/** 무엇으로 맞췄나. 화면이 "최신" 을 이 빌드의 이름으로 말할 수 있게 한다. */
	buildId: string;
	targetTriple: string;
	/**
	 * `alreadyCurrent` 는 성공이다 — 바이트를 하나도 안 올렸다는 뜻이지, 아무
	 * 일도 못 했다는 뜻이 아니다. 셋을 하나로 접으면 잘 되어 있는 상자가 화면에
	 * 빨갛게 뜬다.
	 */
	outcome: "alreadyCurrent" | "activated" | "installed";
}

export function isRemoteHmuxProvisionReceiptV1(
	value: unknown,
	expectedHostId?: string,
): value is RemoteHmuxProvisionReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.schemaVersion === REMOTE_HMUX_BROKER_SCHEMA_VERSION &&
		safeOpaqueId(receipt.hostId) &&
		(expectedHostId === undefined || receipt.hostId === expectedHostId) &&
		safeOpaqueId(receipt.buildId) &&
		safeOpaqueId(receipt.targetTriple) &&
		(receipt.outcome === "alreadyCurrent" ||
			receipt.outcome === "activated" ||
			receipt.outcome === "installed") &&
		hasOnlyKeys(receipt, [
			"schemaVersion",
			"hostId",
			"buildId",
			"targetTriple",
			"outcome",
		])
	);
}

export function isRemoteHmuxStandaloneCreateReceiptV1(
	value: unknown,
	expected: {
		requestId: string;
		bridgeNonce: string;
		targetSessionId: string;
	},
): value is RemoteHmuxStandaloneCreateReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.requestId === expected.requestId &&
		receipt.bridgeNonce === expected.bridgeNonce &&
		isRemoteHmuxCatalogSessionV1(receipt.session) &&
		receipt.session.sessionId === expected.targetSessionId &&
		receipt.session.sessionClass === "standalone" &&
		receipt.session.lifecycle === "ready" &&
		hasOnlyKeys(receipt, ["requestId", "bridgeNonce", "session"])
	);
}

function parseRemoteHmuxManagedCreateReceiptV1(
	value: unknown,
	expected: {
		idempotencyKey: string;
		bridgeNonce: string;
		sessionId: string;
		workspaceId: string;
		providerId: string;
	},
	state: "current" | "advanced" = "current",
): RemoteHmuxManagedCreateReceiptV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const receipt = value as Record<string, unknown>;
	const session = parseRemoteManagedCreateSession(receipt.session);
	if (!session) return undefined;
	const sourceIdentity =
		receipt.idempotencyKey === expected.idempotencyKey &&
		session.sessionId === expected.sessionId;
	const successorIdentity =
		receipt.idempotencyKey !== expected.idempotencyKey &&
		session.sessionId !== expected.sessionId;
	if (
		!(
			safeOpaqueId(receipt.idempotencyKey) &&
			(state === "advanced" ? successorIdentity : sourceIdentity) &&
			receipt.bridgeNonce === expected.bridgeNonce &&
			(receipt.outcome === "created" || receipt.outcome === "reused") &&
			(receipt.initialPromptAccepted === undefined ||
				typeof receipt.initialPromptAccepted === "boolean") &&
			(state === "advanced"
				? session.sessionId !== expected.sessionId
				: session.sessionId === expected.sessionId) &&
			session.workspaceId === expected.workspaceId &&
			session.providerId === expected.providerId &&
			session.lifecycle === "ready"
		)
	) {
		return undefined;
	}
	return {
		idempotencyKey: receipt.idempotencyKey,
		bridgeNonce: receipt.bridgeNonce,
		outcome: receipt.outcome,
		...(receipt.initialPromptAccepted === true
			? { initialPromptAccepted: true }
			: {}),
		session,
	};
}

function parseRemoteManagedCreateSession(
	value: unknown,
): (RemoteHmuxCatalogSessionV1 & { sessionClass: "managed" }) | undefined {
	if (!value || typeof value !== "object") return undefined;
	const session = value as Record<string, unknown>;
	if (
		!safeOpaqueId(session.sessionId) ||
		!safeOpaqueId(session.workspaceId) ||
		session.sessionClass !== "managed" ||
		session.lifecycle !== "ready" ||
		!safeOpaqueId(session.providerId) ||
		!safeOpaqueId(session.runnerPrincipal) ||
		!safeOpaqueId(session.runnerInstance) ||
		!decimalU64(session.channelEpoch) ||
		!safeOpaqueId(session.hostInstanceId) ||
		!safeOpaqueId(session.terminalEpoch)
	) {
		return undefined;
	}
	return {
		sessionId: session.sessionId,
		workspaceId: session.workspaceId,
		sessionClass: "managed",
		lifecycle: "ready",
		providerId: session.providerId,
		runnerPrincipal: session.runnerPrincipal,
		runnerInstance: session.runnerInstance,
		channelEpoch: session.channelEpoch,
		hostInstanceId: session.hostInstanceId,
		terminalEpoch: session.terminalEpoch,
		supportedProtocol: supportedProtocol(session.supportedProtocol)
			? (session.supportedProtocol as RemoteHmuxCatalogSessionV1["supportedProtocol"])
			: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
		capabilities: Array.isArray(session.capabilities)
			? session.capabilities.filter(safeOpaqueId)
			: [],
	};
}

export function parseRemoteHmuxManagedCreateAdvanceResolutionV1(
	value: unknown,
	expected: {
		idempotencyKey: string;
		bridgeNonce: string;
		sessionId: string;
		workspaceId: string;
		providerId: string;
	},
): RemoteHmuxManagedCreateAdvanceResolutionV1 | undefined {
	return parseManagedCreateAdvanceResolution(value, (candidate, state) =>
		parseRemoteHmuxManagedCreateReceiptV1(candidate, expected, state),
	);
}

export function isRemoteHmuxManagedRehostReceiptV1(
	value: unknown,
	expected: {
		operationId: string;
		bridgeNonce: string;
		sourceSessionId: string;
		sourceWorkspaceId: string;
	},
): value is RemoteHmuxManagedRehostReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	const stop = receipt.sourceStopReceipt;
	if (!stop || typeof stop !== "object") return false;
	const source = stop as Record<string, unknown>;
	if (
		!isManagedRehostTargetReceiptV1(receipt.replacement, {
			sourceSessionId: expected.sourceSessionId,
			workspaceId: expected.sourceWorkspaceId,
		})
	)
		return false;
	return (
		receipt.operationId === expected.operationId &&
		receipt.bridgeNonce === expected.bridgeNonce &&
		// Local journal receipts tolerate additive diagnostics. This remote broker
		// boundary stays closed so an undeclared capability or secret cannot cross.
		hasOnlyKeys(receipt.replacement as unknown as Record<string, unknown>, [
			"idempotencyKey",
			"sessionId",
			"workspaceId",
			"providerId",
			"permissionMode",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
		]) &&
		(receipt.conversationId === null || safeOpaqueId(receipt.conversationId)) &&
		(receipt.launchReference === undefined ||
			safeOpaqueId(receipt.launchReference)) &&
		typeof receipt.replayed === "boolean" &&
		source.stopId === `managed_rehost_stop_${expected.operationId}` &&
		source.sessionId === expected.sourceSessionId &&
		source.workspaceId === expected.sourceWorkspaceId &&
		safeOpaqueId(source.runnerPrincipal) &&
		safeOpaqueId(source.runnerInstance) &&
		decimalU64(source.channelEpoch) &&
		safeOpaqueId(source.hostInstanceId) &&
		safeOpaqueId(source.terminalEpoch) &&
		(source.outcome === "stopped" || source.outcome === "already_exited") &&
		typeof source.exitReason === "string" &&
		source.exitReason.length <= 4096 &&
		hasOnlyKeys(source, [
			"stopId",
			"sessionId",
			"workspaceId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
			"outcome",
			"exitReason",
		]) &&
		hasOnlyKeys(receipt, [
			"operationId",
			"bridgeNonce",
			"conversationId",
			"launchReference",
			"replayed",
			"sourceStopReceipt",
			"replacement",
		])
	);
}

export function isRemoteHmuxManagedStopReceiptV1(
	value: unknown,
	expected: {
		stopId: string;
		sessionId: string;
		workspaceId: string;
		runnerPrincipal?: string;
		runnerInstance?: string;
		channelEpoch?: string;
		hostInstanceId?: string;
		terminalEpoch?: string;
	},
): value is RemoteHmuxManagedStopReceiptV1 {
	return isManagedStopReceiptV2(value, expected);
}

export function selectRemoteHmuxSession(
	receipt: RemoteHmuxCatalogReceiptV1,
	expected: {
		hostId: string;
		sessionId: string;
		workspaceId: string;
		sessionClass?: RemoteHmuxCatalogSessionV1["sessionClass"];
	},
): RemoteHmuxCatalogSessionV1 {
	if (!isRemoteHmuxCatalogReceiptV1(receipt, expected.hostId)) {
		throw new Error("remote_hmux_catalog_receipt_invalid");
	}
	const matches = receipt.sessions.filter(
		(session) =>
			session.sessionId === expected.sessionId &&
			session.workspaceId === expected.workspaceId,
	);
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? "remote_hmux_session_not_found"
				: "remote_hmux_session_ambiguous",
		);
	}
	const session = matches[0];
	if (session.lifecycle !== "ready") {
		throw new Error("remote_hmux_session_exited");
	}
	if (
		expected.sessionClass !== undefined &&
		session.sessionClass !== expected.sessionClass
	) {
		throw new Error("remote_hmux_session_class_mismatch");
	}
	return session;
}

const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const identifierEncoder = new TextEncoder();

export interface ManagedRehostTargetReceiptV1 {
	idempotencyKey: string;
	sessionId: string;
	workspaceId: string;
	providerId: string;
	permissionMode: "default" | "bypass_approvals";
	runnerPrincipal: string;
	runnerInstance: string;
	channelEpoch: string;
	hostInstanceId: string;
	terminalEpoch: string;
}

export interface ManagedStopReceiptV2 {
	schema: "hmux-managed-stop-v1";
	schemaVersion: 2;
	stopId: string;
	sessionId: string;
	workspaceId: string;
	runnerPrincipal: string;
	runnerInstance: string;
	channelEpoch: number;
	hostInstanceId: string;
	terminalEpoch: string;
	outcome: "stopped" | "already_exited";
	exitReason: string;
}

const SOURCE_STOP_RECEIPT_KEYS = new Set([
	"schema",
	"schemaVersion",
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
]);

function safeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && SAFE_OPAQUE_ID.test(value);
}

function validIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		identifierEncoder.encode(value).byteLength <= 256 &&
		!CONTROL_CHARACTER.test(value)
	);
}

function validStopReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		identifierEncoder.encode(value).byteLength <= 4_096 &&
		!CONTROL_CHARACTER.test(value)
	);
}

function decimalU64(value: unknown): value is string {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		return false;
	}
	try {
		return BigInt(value) <= 18_446_744_073_709_551_615n;
	} catch {
		return false;
	}
}

export function isManagedRehostTargetReceiptV1(
	value: unknown,
	expected?: {
		sourceSessionId?: string;
		workspaceId?: string;
		providerId?: string;
	},
): value is ManagedRehostTargetReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	return (
		safeOpaqueId(target.idempotencyKey) &&
		safeOpaqueId(target.sessionId) &&
		safeOpaqueId(target.workspaceId) &&
		safeOpaqueId(target.providerId) &&
		(target.permissionMode === "default" ||
			target.permissionMode === "bypass_approvals") &&
		safeOpaqueId(target.runnerPrincipal) &&
		safeOpaqueId(target.runnerInstance) &&
		decimalU64(target.channelEpoch) &&
		safeOpaqueId(target.hostInstanceId) &&
		safeOpaqueId(target.terminalEpoch) &&
		(expected?.sourceSessionId === undefined ||
			target.sessionId !== expected.sourceSessionId) &&
		(expected?.workspaceId === undefined ||
			target.workspaceId === expected.workspaceId) &&
		(expected?.providerId === undefined ||
			target.providerId === expected.providerId)
	);
}

export function isManagedStopReceiptV2(
	value: unknown,
	expected: {
		stopId?: string;
		sessionId: string;
		workspaceId: string;
		runnerPrincipal?: string;
		runnerInstance?: string;
		channelEpoch?: string;
		hostInstanceId?: string;
		terminalEpoch?: string;
	},
): value is ManagedStopReceiptV2 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.schema === "hmux-managed-stop-v1" &&
		receipt.schemaVersion === 2 &&
		validIdentifier(receipt.stopId) &&
		(expected.stopId === undefined || receipt.stopId === expected.stopId) &&
		validIdentifier(receipt.sessionId) &&
		receipt.sessionId === expected.sessionId &&
		validIdentifier(receipt.workspaceId) &&
		receipt.workspaceId === expected.workspaceId &&
		validIdentifier(receipt.runnerPrincipal) &&
		(expected.runnerPrincipal === undefined ||
			receipt.runnerPrincipal === expected.runnerPrincipal) &&
		validIdentifier(receipt.runnerInstance) &&
		(expected.runnerInstance === undefined ||
			receipt.runnerInstance === expected.runnerInstance) &&
		Number.isSafeInteger(receipt.channelEpoch) &&
		(receipt.channelEpoch as number) >= 0 &&
		(expected.channelEpoch === undefined ||
			receipt.channelEpoch?.toString() === expected.channelEpoch) &&
		validIdentifier(receipt.hostInstanceId) &&
		(expected.hostInstanceId === undefined ||
			receipt.hostInstanceId === expected.hostInstanceId) &&
		validIdentifier(receipt.terminalEpoch) &&
		(expected.terminalEpoch === undefined ||
			receipt.terminalEpoch === expected.terminalEpoch) &&
		(receipt.outcome === "stopped" || receipt.outcome === "already_exited") &&
		validStopReason(receipt.exitReason) &&
		Object.keys(receipt).every((key) => SOURCE_STOP_RECEIPT_KEYS.has(key))
	);
}

export function isManagedRehostSourceStopReceiptV1(
	value: unknown,
	expected: {
		operationId: string;
		sessionId: string;
		workspaceId: string;
	},
): value is ManagedStopReceiptV2 {
	return isManagedStopReceiptV2(value, {
		stopId: `managed_rehost_stop_${expected.operationId}`,
		sessionId: expected.sessionId,
		workspaceId: expected.workspaceId,
	});
}

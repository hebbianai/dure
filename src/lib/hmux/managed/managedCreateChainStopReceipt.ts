import {
	isManagedStopReceiptV2,
	type ManagedStopReceiptV2,
} from "./managedRehostTargetReceipt";

const CONTROL_CHARACTER = /\p{Cc}/u;
const identifierEncoder = new TextEncoder();
const IDENTITY_KEYS = new Set([
	"schema",
	"schemaVersion",
	"idempotencyKey",
	"sessionId",
	"workspaceId",
]);
const RECEIPT_V1_KEYS = new Set([
	"schema",
	"schemaVersion",
	"root",
	"effective",
	"stopReceipt",
]);
const ORDERED_RECEIPT_KEYS = new Set([
	"schema",
	"schemaVersion",
	"chain",
	"stopReceipt",
]);
const MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES = 128;

export interface ManagedCreateReconcileIdentityV1 {
	schema: "hmux-managed-create-reconcile-v1";
	schemaVersion: 1;
	idempotencyKey: string;
	sessionId: string;
	workspaceId: string;
}

export interface ManagedCreateChainStopReceiptV1 {
	schema: "hmux-managed-create-chain-stop-v1";
	schemaVersion: 1;
	root: ManagedCreateReconcileIdentityV1;
	effective: ManagedCreateReconcileIdentityV1;
	stopReceipt?: ManagedStopReceiptV2;
}

export interface ManagedCreateChainStopReceiptV2 {
	schema: "hmux-managed-create-chain-stop-v2";
	schemaVersion: 2;
	chain: [
		ManagedCreateReconcileIdentityV1,
		...ManagedCreateReconcileIdentityV1[],
	];
	stopReceipt?: ManagedStopReceiptV2;
}

/**
 * A short-lived WebView event projection used the ordered fields with the v1
 * tag. It was never a supported runtime wire shape, but an already-open
 * WebView can still emit it while frontend generations roll across windows.
 */
export interface LegacyOrderedManagedCreateChainStopEventReceiptV1 {
	schema: "hmux-managed-create-chain-stop-v1";
	schemaVersion: 1;
	chain: [
		ManagedCreateReconcileIdentityV1,
		...ManagedCreateReconcileIdentityV1[],
	];
	stopReceipt?: ManagedStopReceiptV2;
}

function isIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		identifierEncoder.encode(value).byteLength <= 256 &&
		!CONTROL_CHARACTER.test(value)
	);
}

function isReconcileIdentity(
	value: unknown,
	expected?: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): value is ManagedCreateReconcileIdentityV1 {
	if (!value || typeof value !== "object") return false;
	const identity = value as Record<string, unknown>;
	return (
		identity.schema === "hmux-managed-create-reconcile-v1" &&
		identity.schemaVersion === 1 &&
		isIdentifier(identity.idempotencyKey) &&
		isIdentifier(identity.sessionId) &&
		isIdentifier(identity.workspaceId) &&
		(expected === undefined ||
			(identity.idempotencyKey === expected.idempotencyKey &&
				identity.sessionId === expected.sessionId &&
				identity.workspaceId === expected.workspaceId)) &&
		Object.keys(identity).every((key) => IDENTITY_KEYS.has(key))
	);
}

export function isManagedCreateChainStopReceiptV1(
	value: unknown,
	expectedRoot?: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): value is ManagedCreateChainStopReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schema !== "hmux-managed-create-chain-stop-v1" ||
		receipt.schemaVersion !== 1 ||
		!isReconcileIdentity(receipt.root, expectedRoot) ||
		!isReconcileIdentity(receipt.effective) ||
		(receipt.effective as ManagedCreateReconcileIdentityV1).workspaceId !==
			(receipt.root as ManagedCreateReconcileIdentityV1).workspaceId ||
		!Object.keys(receipt).every((key) => RECEIPT_V1_KEYS.has(key))
	) {
		return false;
	}
	if (!("stopReceipt" in receipt)) return true;
	const effective = receipt.effective as ManagedCreateReconcileIdentityV1;
	return isManagedStopReceiptV2(receipt.stopReceipt, {
		sessionId: effective.sessionId,
		workspaceId: effective.workspaceId,
	});
}

export function isManagedCreateChainStopReceiptV2(
	value: unknown,
	expectedIdentity?: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): value is ManagedCreateChainStopReceiptV2 {
	return isOrderedManagedCreateChainStopReceipt(
		value,
		"hmux-managed-create-chain-stop-v2",
		2,
		expectedIdentity,
	);
}

export function isLegacyOrderedManagedCreateChainStopEventReceiptV1(
	value: unknown,
	expectedIdentity?: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): value is LegacyOrderedManagedCreateChainStopEventReceiptV1 {
	return isOrderedManagedCreateChainStopReceipt(
		value,
		"hmux-managed-create-chain-stop-v1",
		1,
		expectedIdentity,
	);
}

function isOrderedManagedCreateChainStopReceipt(
	value: unknown,
	schema:
		| ManagedCreateChainStopReceiptV2["schema"]
		| LegacyOrderedManagedCreateChainStopEventReceiptV1["schema"],
	schemaVersion: 1 | 2,
	expectedIdentity?: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): value is
	| ManagedCreateChainStopReceiptV2
	| LegacyOrderedManagedCreateChainStopEventReceiptV1 {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schema !== schema ||
		receipt.schemaVersion !== schemaVersion ||
		!Array.isArray(receipt.chain) ||
		receipt.chain.length === 0 ||
		receipt.chain.length > MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES ||
		!Object.keys(receipt).every((key) => ORDERED_RECEIPT_KEYS.has(key))
	) {
		return false;
	}
	const chain = receipt.chain;
	if (
		!chain.every((identity) => isReconcileIdentity(identity)) ||
		(expectedIdentity !== undefined &&
			!chain.some((identity) =>
				isReconcileIdentity(identity, expectedIdentity),
			))
	) {
		return false;
	}
	const root = chain[0] as ManagedCreateReconcileIdentityV1;
	const identities = new Set<string>();
	for (const identity of chain as ManagedCreateReconcileIdentityV1[]) {
		if (identity.workspaceId !== root.workspaceId) return false;
		const key = `${identity.idempotencyKey}\0${identity.sessionId}`;
		if (identities.has(key)) return false;
		identities.add(key);
	}
	if (!("stopReceipt" in receipt)) return true;
	const effective = chain[chain.length - 1] as ManagedCreateReconcileIdentityV1;
	return isManagedStopReceiptV2(receipt.stopReceipt, {
		sessionId: effective.sessionId,
		workspaceId: effective.workspaceId,
	});
}

export function managedCreateChainStopLegacyV1Projection(
	receipt: ManagedCreateChainStopReceiptV2,
	root: ManagedCreateReconcileIdentityV1,
): ManagedCreateChainStopReceiptV1 {
	return {
		schema: "hmux-managed-create-chain-stop-v1",
		schemaVersion: 1,
		root,
		effective: managedCreateChainStopEffective(receipt),
		...(receipt.stopReceipt ? { stopReceipt: receipt.stopReceipt } : {}),
	};
}

export function managedCreateChainStopLegacyOrderedV1EventProjection(
	receipt: ManagedCreateChainStopReceiptV2,
): LegacyOrderedManagedCreateChainStopEventReceiptV1 {
	return {
		schema: "hmux-managed-create-chain-stop-v1",
		schemaVersion: 1,
		chain: [...receipt.chain],
		...(receipt.stopReceipt ? { stopReceipt: receipt.stopReceipt } : {}),
	};
}

export function managedCreateChainStopEffective(
	receipt: ManagedCreateChainStopReceiptV2,
): ManagedCreateReconcileIdentityV1 {
	return receipt.chain[receipt.chain.length - 1];
}

export function managedCreateChainStopIncludesIdentity(
	receipt:
		| ManagedCreateChainStopReceiptV2
		| LegacyOrderedManagedCreateChainStopEventReceiptV1,
	expected: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
	},
): boolean {
	return receipt.chain.some(
		(identity) =>
			identity.idempotencyKey === expected.idempotencyKey &&
			identity.sessionId === expected.sessionId &&
			identity.workspaceId === expected.workspaceId,
	);
}

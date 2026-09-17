import { hasOnlyKeys, nonEmptyString } from "@/lib/payloadGuards";
import {
	isTerminalPaneBindingV1,
	type HmuxManagedPaneBindingV1,
	type HmuxStandalonePaneBindingV1,
	remoteHmuxStandaloneBinding,
	type RemoteHmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION = 1 as const;

export {
	remoteHmuxStandaloneBinding,
	type RemoteHmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";

export type RemoteHmuxSourcePaneBindingV1 =
	| HmuxStandalonePaneBindingV1
	| HmuxManagedPaneBindingV1;

export interface PreparingRemoteHmuxPaneTransitionV1 {
	schemaVersion: typeof REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION;
	phase: "preparing";
	sourceBinding: RemoteHmuxSourcePaneBindingV1;
	targetHostId: string;
	createIdempotencyKey: string;
}

export interface AttachedRemoteHmuxPaneTransitionV1 {
	schemaVersion: typeof REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION;
	phase: "attached";
	sourceBinding: RemoteHmuxSourcePaneBindingV1;
	targetBinding: RemoteHmuxStandalonePaneBindingV1;
	createIdempotencyKey: string;
}

export interface ReconnectingRemoteHmuxPaneTransitionV1 {
	schemaVersion: typeof REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION;
	phase: "reconnecting";
	sourceBinding: RemoteHmuxSourcePaneBindingV1;
	targetBinding: RemoteHmuxStandalonePaneBindingV1;
	createIdempotencyKey: string;
}

export type RemoteHmuxPaneTransitionV1 =
	| PreparingRemoteHmuxPaneTransitionV1
	| AttachedRemoteHmuxPaneTransitionV1
	| ReconnectingRemoteHmuxPaneTransitionV1;

export interface RemoteHmuxAttachReceiptV1 {
	createIdempotencyKey: string;
	targetBinding: RemoteHmuxStandalonePaneBindingV1;
}

function isLocalSourceBinding(
	value: unknown,
): value is RemoteHmuxSourcePaneBindingV1 {
	return (
		isTerminalPaneBindingV1(value) &&
		(value.runtime === "hmux_standalone_v1" ||
			value.runtime === "hmux_managed_v1") &&
		value.source === "local" &&
		value.hostId === "local"
	);
}

export function isRemoteHmuxStandalonePaneBindingV1(
	value: unknown,
): value is RemoteHmuxStandalonePaneBindingV1 {
	return (
		isTerminalPaneBindingV1(value) &&
		value.runtime === "hmux_standalone_v1" &&
		value.source === "ssh" &&
		value.hostId !== "local"
	);
}

export function normalizeRemoteHmuxStandalonePaneBindingV1(
	value: unknown,
): RemoteHmuxStandalonePaneBindingV1 | undefined {
	if (isRemoteHmuxStandalonePaneBindingV1(value)) return value;
	if (!value || typeof value !== "object") return undefined;
	const binding = value as Record<string, unknown>;
	if (
		binding.schemaVersion !== 1 ||
		binding.runtime !== "hmux_standalone_v1" ||
		binding.source !== "ssh" ||
		!nonEmptyString(binding.hostId) ||
		binding.hostId === "local" ||
		!nonEmptyString(binding.sessionId) ||
		!nonEmptyString(binding.workspaceId) ||
		!nonEmptyString(binding.commandBridgeNonce)
	) {
		return undefined;
	}
	return remoteHmuxStandaloneBinding(
		binding.sessionId,
		binding.workspaceId,
		binding.hostId,
		binding.commandBridgeNonce,
	);
}

export function beginRemoteHmuxPaneTransition(
	sourceBinding: RemoteHmuxSourcePaneBindingV1,
	targetHostId: string,
	createIdempotencyKey: string,
): PreparingRemoteHmuxPaneTransitionV1 {
	if (
		!isLocalSourceBinding(sourceBinding) ||
		!nonEmptyString(targetHostId) ||
		targetHostId === "local" ||
		!nonEmptyString(createIdempotencyKey)
	) {
		throw new Error("remote Hmux transition requires a stable local source");
	}
	return {
		schemaVersion: REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION,
		phase: "preparing",
		sourceBinding,
		targetHostId,
		createIdempotencyKey,
	};
}

/**
 * Commit the presentation handoff only after the broker returns an exact
 * create-or-reuse receipt for the in-flight operation.
 */
export function acceptRemoteHmuxAttachReceipt(
	transition: PreparingRemoteHmuxPaneTransitionV1,
	receipt: RemoteHmuxAttachReceiptV1,
): AttachedRemoteHmuxPaneTransitionV1 | undefined {
	if (
		receipt.createIdempotencyKey !== transition.createIdempotencyKey ||
		!isRemoteHmuxStandalonePaneBindingV1(receipt.targetBinding) ||
		receipt.targetBinding.hostId !== transition.targetHostId
	) {
		return undefined;
	}
	return {
		schemaVersion: REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION,
		phase: "attached",
		sourceBinding: transition.sourceBinding,
		targetBinding: receipt.targetBinding,
		createIdempotencyKey: transition.createIdempotencyKey,
	};
}

export function markRemoteHmuxTransportDisconnected(
	transition: AttachedRemoteHmuxPaneTransitionV1,
): ReconnectingRemoteHmuxPaneTransitionV1 {
	return { ...transition, phase: "reconnecting" };
}

export function markRemoteHmuxTransportReattached(
	transition: ReconnectingRemoteHmuxPaneTransitionV1,
): AttachedRemoteHmuxPaneTransitionV1 {
	return { ...transition, phase: "attached" };
}

export function activeRemoteHmuxPaneBinding(
	transition: RemoteHmuxPaneTransitionV1,
): RemoteHmuxSourcePaneBindingV1 | RemoteHmuxStandalonePaneBindingV1 {
	return transition.phase === "preparing"
		? transition.sourceBinding
		: transition.targetBinding;
}

export function cancelPreparingRemoteHmuxTransition(
	transition: PreparingRemoteHmuxPaneTransitionV1,
): RemoteHmuxSourcePaneBindingV1 {
	return transition.sourceBinding;
}

export function completeRemoteHmuxExit(
	transition:
		| AttachedRemoteHmuxPaneTransitionV1
		| ReconnectingRemoteHmuxPaneTransitionV1,
): RemoteHmuxSourcePaneBindingV1 {
	return transition.sourceBinding;
}

export function isRemoteHmuxPaneTransitionV1(
	value: unknown,
): value is RemoteHmuxPaneTransitionV1 {
	if (!value || typeof value !== "object") return false;
	const transition = value as Record<string, unknown>;
	if (
		transition.schemaVersion !==
			REMOTE_HMUX_PANE_TRANSITION_SCHEMA_VERSION ||
		!isLocalSourceBinding(transition.sourceBinding) ||
		!nonEmptyString(transition.createIdempotencyKey)
	) {
		return false;
	}
	if (transition.phase === "preparing") {
		return (
			nonEmptyString(transition.targetHostId) &&
			transition.targetHostId !== "local" &&
			hasOnlyKeys(transition, [
				"schemaVersion",
				"phase",
				"sourceBinding",
				"targetHostId",
				"createIdempotencyKey",
			])
		);
	}
	if (
		transition.phase !== "attached" &&
		transition.phase !== "reconnecting"
	) {
		return false;
	}
	return (
		isRemoteHmuxStandalonePaneBindingV1(transition.targetBinding) &&
		hasOnlyKeys(transition, [
			"schemaVersion",
			"phase",
			"sourceBinding",
			"targetBinding",
			"createIdempotencyKey",
		])
	);
}

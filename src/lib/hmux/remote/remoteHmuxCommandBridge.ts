import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { RemoteHmuxCatalogSessionV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import { hasOnlyKeys } from "@/lib/payloadGuards";
import type {
	RemoteHmuxStandalonePaneBindingV1,
	TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const OSC_PREFIX = "dure-hmux-command-bridge-v1;";
const SAFE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_OSC_PAYLOAD = 8_192;

export interface RemoteHmuxManagedStartedMarkerV1 {
	schemaVersion: 1;
	event: "managed_started";
	bridgeNonce: string;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	target: {
		sessionId: string;
		workspaceId: string;
		sessionClass: "managed";
		lifecycle: "ready";
		providerId: "claude" | "codex";
		runnerPrincipal: string;
		runnerInstance: string;
		channelEpoch: string;
		hostInstanceId: string;
		terminalEpoch: string;
	};
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function safeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function decimalU64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		DECIMAL_U64.test(value) &&
		BigInt(value) <= MAX_U64
	);
}

function decodeBase64Url(value: string): string | undefined {
	if (
		value.length === 0 ||
		value.length > MAX_OSC_PAYLOAD ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) {
		return undefined;
	}
	try {
		const padded = value
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(value.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (character) =>
			character.charCodeAt(0),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

export function parseRemoteHmuxCommandBridgeOsc(
	data: string,
): RemoteHmuxManagedStartedMarkerV1 | undefined {
	if (!data.startsWith(OSC_PREFIX)) return undefined;
	const decoded = decodeBase64Url(data.slice(OSC_PREFIX.length));
	if (!decoded || decoded.length > MAX_OSC_PAYLOAD) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	const marker = recordOf(parsed);
	const target = recordOf(marker?.target);
	if (
		!marker ||
		!target ||
		marker.schemaVersion !== 1 ||
		marker.event !== "managed_started" ||
		!safeId(marker.bridgeNonce) ||
		!safeId(marker.sourceSessionId) ||
		!safeId(marker.sourceWorkspaceId) ||
		!safeId(target.sessionId) ||
		!safeId(target.workspaceId) ||
		target.sessionClass !== "managed" ||
		target.lifecycle !== "ready" ||
		(target.providerId !== "claude" && target.providerId !== "codex") ||
		!safeId(target.runnerPrincipal) ||
		!safeId(target.runnerInstance) ||
		!decimalU64(target.channelEpoch) ||
		!safeId(target.hostInstanceId) ||
		!safeId(target.terminalEpoch) ||
		!hasOnlyKeys(marker, [
			"schemaVersion",
			"event",
			"bridgeNonce",
			"sourceSessionId",
			"sourceWorkspaceId",
			"target",
		]) ||
		!hasOnlyKeys(target, [
			"sessionId",
			"workspaceId",
			"sessionClass",
			"lifecycle",
			"providerId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
		])
	) {
		return undefined;
	}
	return parsed as RemoteHmuxManagedStartedMarkerV1;
}

export function handleRemoteHmuxCommandBridgeOsc(
	data: string,
	binding: TerminalPaneBindingV1 | undefined,
	onManagedStarted: (marker: RemoteHmuxManagedStartedMarkerV1) => void,
): boolean {
	if (
		binding?.runtime !== "hmux_standalone_v1" ||
		binding.source !== "ssh"
	) {
		return false;
	}
	const marker = parseRemoteHmuxCommandBridgeOsc(data);
	if (!marker) return data.startsWith(OSC_PREFIX);
	onManagedStarted(marker);
	return true;
}

export function remoteHmuxBridgeMarkerMatchesSource(
	marker: RemoteHmuxManagedStartedMarkerV1,
	binding: RemoteHmuxStandalonePaneBindingV1,
): boolean {
	return (
		marker.bridgeNonce === binding.commandBridgeNonce &&
		marker.sourceSessionId === binding.sessionId &&
		marker.sourceWorkspaceId === binding.workspaceId
	);
}

export function remoteHmuxBridgeMarkerMatchesCatalog(
	marker: RemoteHmuxManagedStartedMarkerV1,
	session: RemoteHmuxCatalogSessionV1,
): boolean {
	const target = marker.target;
	return (
		target.sessionId === session.sessionId &&
		target.workspaceId === session.workspaceId &&
		target.sessionClass === session.sessionClass &&
		target.lifecycle === session.lifecycle &&
		target.providerId === session.providerId &&
		sameHmuxManagedGeneration(target, session)
	);
}

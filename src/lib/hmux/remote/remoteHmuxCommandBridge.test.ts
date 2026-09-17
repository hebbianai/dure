import { describe, expect, it, vi } from "vitest";
import {
	handleRemoteHmuxCommandBridgeOsc,
	parseRemoteHmuxCommandBridgeOsc,
	remoteHmuxBridgeMarkerMatchesCatalog,
	remoteHmuxBridgeMarkerMatchesSource,
} from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const marker = {
	schemaVersion: 1,
	event: "managed_started",
	bridgeNonce: "bridge_nonce",
	sourceSessionId: "standalone_source",
	sourceWorkspaceId: "workspace_source",
	target: {
		sessionId: "managed_target",
		workspaceId: "workspace_target",
		sessionClass: "managed",
		lifecycle: "ready",
		providerId: "codex",
		runnerPrincipal: "user",
		runnerInstance: "runner",
		channelEpoch: "1",
		hostInstanceId: "host",
		terminalEpoch: "terminal",
	},
} as const;

function encode(value: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `dure-hmux-command-bridge-v1;${btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")}`;
}

describe("remote Hmux command bridge marker", () => {
	it("parses a bounded exact marker and binds it to source and catalog fences", () => {
		const parsed = parseRemoteHmuxCommandBridgeOsc(encode(marker));
		expect(parsed).toEqual(marker);
		expect(
			remoteHmuxBridgeMarkerMatchesSource(
				parsed!,
				remoteHmuxStandaloneBinding(
					"standalone_source",
					"workspace_source",
					"host-rts",
					"bridge_nonce",
				),
			),
		).toBe(true);
		expect(
			remoteHmuxBridgeMarkerMatchesCatalog(parsed!, {
				...marker.target,
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities: [],
			}),
		).toBe(true);
	});

	it("consumes a valid marker only for its remote standalone transport", () => {
		const onManagedStarted = vi.fn();
		const binding = remoteHmuxStandaloneBinding(
			"standalone_source",
			"workspace_source",
			"host-rts",
			"bridge_nonce",
		);

		expect(
			handleRemoteHmuxCommandBridgeOsc(
				encode(marker),
				binding,
				onManagedStarted,
			),
		).toBe(true);
		expect(onManagedStarted).toHaveBeenCalledExactlyOnceWith(marker);
		expect(
			handleRemoteHmuxCommandBridgeOsc(
				encode(marker),
				undefined,
				onManagedStarted,
			),
		).toBe(false);
	});

	it("rejects unknown keys, unsupported providers, and malformed payloads", () => {
		expect(
			parseRemoteHmuxCommandBridgeOsc(
				encode({ ...marker, credential: "must-not-cross" }),
			),
		).toBeUndefined();
		expect(
			parseRemoteHmuxCommandBridgeOsc(
				encode({
					...marker,
					target: { ...marker.target, providerId: "unknown" },
				}),
			),
		).toBeUndefined();
		expect(
			parseRemoteHmuxCommandBridgeOsc(
				"dure-hmux-command-bridge-v1;not_base64!",
			),
		).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	managedAgentRecoveryEntry,
	managedAgentRecoveryHasDeadInput,
	shouldOfferDisconnectedConversationSelection,
} from "@/lib/sessions/managed/managedAgentRecoveryEntry";

describe("managedAgentRecoveryEntry", () => {
	it.each([
		[
			"stale transport",
			"working",
			{
				lifecycle: "unavailable",
				health: "stale_transport",
			},
			"unavailable",
		],
		[
			"exited summary",
			"exited",
			{ lifecycle: "exited", health: "exited" },
			"exited",
		],
		["unknown exited posture", "exited", undefined, "unknown"],
	] as const)(
		"shows recovery for %s",
		(_label, activity, metadata, posture) => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity,
					metadata,
				}),
			).toEqual({ visible: true, posture });
		},
	);

	it("keeps a healthy managed pane hidden", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "working",
				metadata: {
					lifecycle: "ready",
					health: "current_healthy",
					inputAllowed: true,
				},
			}),
		).toEqual({ visible: false, posture: "unknown" });
	});

	it.each([
		["same live epoch", { state: "live", terminalEpoch: "terminal-1" }, false],
		[
			"different live epoch",
			{ state: "live", terminalEpoch: "terminal-2" },
			true,
		],
		["missing epoch", { state: "live" }, true],
		["no attachment", undefined, true],
		["disconnected", { state: "error", terminalEpoch: "terminal-1" }, true],
		[
			"reconnecting",
			{ state: "recovering", terminalEpoch: "terminal-1" },
			true,
		],
	] as const)(
		"uses exact attachment health for a failed census: %s",
		(_label, paneHealth, visible) => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata: {
						lifecycle: "unavailable",
						health: "stale_transport",
						inputAllowed: false,
						terminalEpoch: "terminal-1",
					},
					paneHealth,
				}).visible,
			).toBe(visible);
		},
	);

	it.each([undefined, ""])(
		"does not infer an exact generation from missing metadata epoch %s",
		(terminalEpoch) => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata: {
						lifecycle: "unavailable",
						health: "stale_transport",
						terminalEpoch,
					},
					paneHealth: { state: "live", terminalEpoch: "terminal-1" },
				}).visible,
			).toBe(true);
		},
	);

	it("does not hide confirmed Host death behind its last live frame", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "working",
				metadata: {
					lifecycle: "unavailable",
					health: "stale_transport",
					hostProcessAlive: false,
					terminalEpoch: "terminal-1",
				},
				paneHealth: { state: "live", terminalEpoch: "terminal-1" },
			}).visible,
		).toBe(true);
	});

	it.each(["exited", "incompatible_protocol"] as const)(
		"does not hide confirmed %s behind a live frame",
		(health) => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata: {
						lifecycle: health === "exited" ? "exited" : "unavailable",
						health,
						inputAllowed: false,
						terminalEpoch: "terminal-1",
					},
					paneHealth: { state: "live", terminalEpoch: "terminal-1" },
				}).visible,
			).toBe(true);
		},
	);

	it.each(["unprobed", "generation_changed"] as const)(
		"does not turn %s uncertainty into recovery or a dead-input shell escape",
		(health) => {
			const metadata = {
				lifecycle: "unavailable" as const,
				health,
				inputAllowed: false,
			};
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata,
				}),
			).toEqual({ visible: false, posture: "unknown" });
			expect(managedAgentRecoveryHasDeadInput(metadata)).toBe(false);
		},
	);

	it("marks only a transport-unavailable Host as a dead-input shell escape", () => {
		expect(
			managedAgentRecoveryHasDeadInput({
				lifecycle: "ready",
				health: "stale_transport",
			}),
		).toBe(true);
		expect(
			managedAgentRecoveryHasDeadInput({
				lifecycle: "unavailable",
				health: "current_healthy",
			}),
		).toBe(true);
		expect(
			managedAgentRecoveryHasDeadInput({
				lifecycle: "ready",
				health: "incompatible_protocol",
			}),
		).toBe(true);
		expect(
			managedAgentRecoveryHasDeadInput({
				lifecycle: "ready",
				health: "current_healthy",
			}),
		).toBe(false);
	});

	it("keeps the replacement gap out of the recovery inspector", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "exited",
				metadata: {
					lifecycle: "unavailable",
					health: "stale_transport",
					inputAllowed: false,
				},
				credentialSwitchTransition: true,
			}),
		).toEqual({ visible: false, posture: "unknown" });
	});

	it("lets a pane treat a confirmed provider exit as a normal ended session", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "exited",
				metadata: { lifecycle: "exited", health: "exited" },
				inspectConfirmedExit: false,
			}),
		).toEqual({ visible: false, posture: "unknown" });
	});

	it("keeps an unconfirmed exit in recovery inspection", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "exited",
				inspectConfirmedExit: false,
				inspectUnknownExit: true,
			}),
		).toEqual({ visible: true, posture: "unknown" });
	});

	it("lets an authoritative unknown exit bypass recovery inspection", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: true,
				activity: "exited",
				inspectUnknownExit: false,
			}),
		).toEqual({ visible: false, posture: "unknown" });
	});

	it("does not expose recovery without an exact managed binding", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: false,
				activity: "exited",
			}),
		).toEqual({ visible: false, posture: "unknown" });
	});

	it("offers exact conversation selection for a structured disconnected identity failure", () => {
		const failure = Object.assign(
			new Error(
				"conversation_identity_source_mismatch: managed session identity changed",
			),
			{ code: "invalid_request" },
		);

		expect(
			shouldOfferDisconnectedConversationSelection("exited", failure),
		).toBe(true);
		expect(
			shouldOfferDisconnectedConversationSelection("unavailable", failure),
		).toBe(true);
		expect(
			shouldOfferDisconnectedConversationSelection("unknown", failure),
		).toBe(false);
		expect(
			shouldOfferDisconnectedConversationSelection(
				"exited",
				new Error("backend unavailable"),
			),
		).toBe(false);
	});
});

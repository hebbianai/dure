import { describe, expect, it } from "vitest";
import {
	managedAgentRecoveryEntry,
	managedAgentRecoveryHasDeadInput,
	shouldOfferDisconnectedConversationSelection,
} from "@/lib/sessions/managed/managedAgentRecoveryEntry";

const HIDDEN = { visible: false, posture: "unknown" } as const;
const RECONNECTING = { visible: true, posture: "reconnecting" } as const;
const UNAVAILABLE = { visible: true, posture: "unavailable" } as const;

/** The projection a hub restart or a failed census produces for a Host that
 * is still running: the backend derives every one of these fields from its
 * own failed handshake. */
const transportFailure = {
	lifecycle: "unavailable",
	health: "stale_transport",
	inputAllowed: false,
} as const;

describe("managedAgentRecoveryEntry", () => {
	it.each([
		["stale transport", "working", transportFailure, "reconnecting"],
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
		).toEqual(HIDDEN);
	});

	// Hub restart / failed census: the Host is alive and may still be
	// streaming, but the census could not reach it. hostProcessAlive is
	// undefined (no claim) or true; a dead Host is the only false.
	describe("hub restart with the Host alive", () => {
		it.each([
			["unknown liveness, live pane", undefined, { state: "live" }, HIDDEN],
			["asserted alive, live pane", true, { state: "live" }, HIDDEN],
			["unknown liveness, unobserved pane", undefined, undefined, RECONNECTING],
			["asserted alive, unobserved pane", true, undefined, RECONNECTING],
			[
				"unknown liveness, connecting pane",
				undefined,
				{ state: "connecting" },
				RECONNECTING,
			],
			[
				"unknown liveness, recovering pane",
				undefined,
				{ state: "recovering" },
				RECONNECTING,
			],
			["unknown liveness, stale pane", undefined, { state: "stale" }, RECONNECTING],
			[
				"unknown liveness, disconnected pane",
				undefined,
				{ state: "error" },
				RECONNECTING,
			],
		] as const)(
			"never offers replacement for %s",
			(_label, hostProcessAlive, paneHealth, expected) => {
				for (const activity of ["connecting", "working", "waiting"] as const) {
					expect(
						managedAgentRecoveryEntry({
							hasAgent: true,
							hasBinding: true,
							activity,
							metadata: { ...transportFailure, hostProcessAlive },
							paneHealth,
						}),
					).toEqual(expected);
				}
			},
		);

		it.each([
			["lifecycle only", { lifecycle: "unavailable", health: "current_healthy" }],
			["health only", { lifecycle: "ready", health: "stale_transport" }],
			["without inputAllowed", { lifecycle: "unavailable", health: "stale_transport" }],
		] as const)(
			"treats a transport failure projected as %s the same way",
			(_label, metadata) => {
				expect(
					managedAgentRecoveryEntry({
						hasAgent: true,
						hasBinding: true,
						activity: "working",
						metadata,
					}),
				).toEqual(RECONNECTING);
				expect(
					managedAgentRecoveryEntry({
						hasAgent: true,
						hasBinding: true,
						activity: "working",
						metadata,
						paneHealth: { state: "live" },
					}),
				).toEqual(HIDDEN);
			},
		);

		it("clears as soon as the next projection is live again", () => {
			const base = { hasAgent: true, hasBinding: true, activity: "working" } as const;
			expect(
				managedAgentRecoveryEntry({ ...base, metadata: transportFailure }),
			).toEqual(RECONNECTING);
			expect(
				managedAgentRecoveryEntry({
					...base,
					metadata: {
						lifecycle: "ready",
						health: "current_healthy",
						inputAllowed: true,
					},
				}),
			).toEqual(HIDDEN);
		});

		it("lets an exit the pane observed outrank the failed census", () => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "exited",
					metadata: transportFailure,
				}),
			).toEqual({ visible: true, posture: "unknown" });
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "exited",
					metadata: transportFailure,
					inspectUnknownExit: false,
				}),
			).toEqual(HIDDEN);
		});
	});

	describe("confirmed exits", () => {
		it.each([
			["unobserved pane", undefined],
			["disconnected pane", { state: "error" }],
			["reconnecting pane", { state: "recovering" }],
		] as const)(
			"offers replacement for a confirmed-dead Host with a %s",
			(_label, paneHealth) => {
				expect(
					managedAgentRecoveryEntry({
						hasAgent: true,
						hasBinding: true,
						activity: "working",
						metadata: { ...transportFailure, hostProcessAlive: false },
						paneHealth,
					}),
				).toEqual(UNAVAILABLE);
			},
		);

		it("waits for the live attachment to drop before replacing a confirmed-dead Host", () => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata: { ...transportFailure, hostProcessAlive: false },
					paneHealth: { state: "live" },
				}),
			).toEqual(RECONNECTING);
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
						},
						paneHealth: { state: "live" },
					}),
				).toEqual({
					visible: true,
					posture: health === "exited" ? "exited" : "unavailable",
				});
			},
		);

		it("keeps a reachable Host that bridges no live input as unavailable", () => {
			expect(
				managedAgentRecoveryEntry({
					hasAgent: true,
					hasBinding: true,
					activity: "working",
					metadata: {
						lifecycle: "ready",
						health: "compatible_old_healthy",
						inputAllowed: false,
					},
					paneHealth: { state: "live" },
				}),
			).toEqual(UNAVAILABLE);
		});
	});

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
			).toEqual(HIDDEN);
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
				metadata: transportFailure,
				credentialSwitchTransition: true,
			}),
		).toEqual(HIDDEN);
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
		).toEqual(HIDDEN);
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
		).toEqual(HIDDEN);
	});

	it("does not expose recovery without an exact managed binding", () => {
		expect(
			managedAgentRecoveryEntry({
				hasAgent: true,
				hasBinding: false,
				activity: "exited",
			}),
		).toEqual(HIDDEN);
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
			shouldOfferDisconnectedConversationSelection("reconnecting", failure),
		).toBe(false);
		expect(
			shouldOfferDisconnectedConversationSelection(
				"exited",
				new Error("backend unavailable"),
			),
		).toBe(false);
	});
});

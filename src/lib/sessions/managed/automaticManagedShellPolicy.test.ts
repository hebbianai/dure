import { describe, expect, it } from "vitest";
import {
	assessAutomaticManagedShell,
	type AutomaticManagedShellSnapshot,
} from "@/lib/sessions/managed/automaticManagedShellPolicy";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const session: HmuxSessionSummary = {
	sessionId: "source-session",
	workspaceId: "workspace-1",
	sessionClass: "standalone",
	lifecycle: "ready",
	manifestLifecycle: "ready",
	health: "current_healthy",
	inputAllowed: true,
	detachOnly: false,
	terminalEpoch: "epoch-1",
	outputSeq: "1",
	capabilities: [],
	retirementPolicy: {
		kind: "after_graceful_last_client_departure_v1",
		gracePeriodMs: 2_000,
	},
};

function snapshot(
	patch: Partial<AutomaticManagedShellSnapshot> = {},
): AutomaticManagedShellSnapshot {
	return {
		desktopId: "desktop-1",
		panelId: "term:source-session",
		source: hmuxStandaloneBinding("source-session", "workspace-1"),
		session,
		sourceConsumerCount: 1,
		agentDetected: false,
		desktopVisible: false,
		migrationPending: false,
		...patch,
	};
}

describe("automatic managed shell policy", () => {
	it("accepts only an offscreen, healthy, Dure-owned single consumer", () => {
		const result = assessAutomaticManagedShell(snapshot());
		expect(result).toMatchObject({
			eligible: true,
			sourceTerminalEpoch: "epoch-1",
		});
	});

	it.each([
		["shared source", { sourceConsumerCount: 2 }],
		["visible desktop", { desktopVisible: true }],
		["detected agent", { agentDetected: true }],
		["pending migration", { migrationPending: true }],
	])("refuses %s", (_name, patch) => {
		expect(assessAutomaticManagedShell(snapshot(patch)).eligible).toBe(false);
	});

	it("refuses an imported standalone without Dure retirement provenance", () => {
		expect(
			assessAutomaticManagedShell(
				snapshot({ session: { ...session, retirementPolicy: undefined } }),
			),
		).toEqual({ eligible: false, reason: "source_not_dure_owned" });
	});

	it("binds eligibility to the exact Host generation", () => {
		const first = assessAutomaticManagedShell(snapshot());
		const second = assessAutomaticManagedShell(
			snapshot({ session: { ...session, terminalEpoch: "epoch-2" } }),
		);
		expect(first.eligible && second.eligible && first.identity).not.toBe(
			second.eligible && second.identity,
		);
	});
});

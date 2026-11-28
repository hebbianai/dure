import { describe, expect, it } from "vitest";
import {
	renderHomeScreen,
	type CensusActions,
	type CensusModel,
} from "./censusView";
import type { HubProbeSession } from "./ipc";
import { t } from "./i18n";

const actions: CensusActions = {
	open: () => {},
	selectDesktop: () => {},
	pair: () => {},
	settings: () => {},
	refresh: () => {},
	hold: () => {},
};
const session: HubProbeSession = {
	session_id: "working-pane",
	session_name: "Implement mobile Home",
	workspace_id: "qa",
	session_class: "standalone",
	lifecycle: "ready",
	provider_id: "codex",
	runner_principal: "qa",
	runner_instance: "i",
	channel_epoch: "e",
	host_instance_id: "h",
	terminal_epoch: "t",
	capabilities: [],
	ready: true,
	box_id: "this-laptop",
	box_label: "QA Mac",
};
function draw(
	displayState?: NonNullable<HubProbeSession["presentation"]>["displayState"],
	reachable = true,
	opening?: string,
) {
	const model: CensusModel = {
		census: [],
		hubs: [
			{
				hubId: "qa",
				hubLabel: "QA Mac",
				reachable,
				sessions: [{ ...session, presentation: { displayState } }],
			},
		],
		layout: {
			desktop_order: ["Dure"],
			placements: {
				[session.session_id]: { desktop: "Dure", project: "Dure", order: 0 },
			},
		},
		failures: [],
		busy: false,
		emptyMessage: "",
		opening,
	};
	return renderHomeScreen(model, actions).querySelector(".session-row__lead")!;
}

const badge = (lead: Element) =>
	lead.querySelector<HTMLElement>(".session-row__badge");

describe("Home live activity", () => {
	it("shows work as the green breathing badge from catalog updates without an attach action", () => {
		expect(badge(draw("waiting"))).toBeNull();
		const working = draw("working");
		const mark = badge(working);
		expect(mark?.dataset.agentTone).toBe("live");
		expect(mark?.dataset.agentMotion).toBe("breathe");
		expect(mark?.getAttribute("aria-label")).toBe(t("common.working"));
		// The provider's mark keeps the slot; the state rides on its corner.
		expect(working.querySelector(".dure-loader")).toBeNull();
		expect(working.querySelector(".session-row__provider")).not.toBeNull();
		expect(badge(draw("waiting"))).toBeNull();
	});
	it.each([
		["input", "attention", "agents.status.awaitingInput"],
		["blocked", "attention", "agents.status.approvalRequired"],
		["error", "danger", "agents.status.error"],
		["connecting", "neutral", "common.connecting"],
		["exited", "neutral", "common.exited"],
		["unknown", "neutral", "common.unknown"],
	] as const)(
		"reads the desktop's %s state for the badge, not the lifecycle",
		(state, tone, label) => {
			const mark = badge(draw(state));
			expect(mark?.dataset.agentTone).toBe(tone);
			expect(mark?.dataset.agentMotion).not.toBe("breathe");
			expect(mark?.getAttribute("aria-label")).toBe(t(label));
		},
	);
	it("rests a ready session the desktop says nothing about", () => {
		expect(badge(draw(undefined))).toBeNull();
	});
	it("stops claiming cached work after the computer goes offline", () => {
		expect(badge(draw("working", false))).toBeNull();
	});
	it.each(["working", "waiting"] as const)(
		"preserves local opening feedback for a %s pane",
		(state) => {
			const lead = draw(state, true, session.session_id);
			expect(lead.querySelectorAll(".dure-loader")).toHaveLength(1);
			expect(
				lead.querySelector(".dure-loader")?.getAttribute("aria-label"),
			).toBe(t("연결 중…"));
		},
	);
});

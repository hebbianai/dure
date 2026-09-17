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

describe("Home live activity", () => {
	it("starts and stops the working indicator from catalog updates without an attach action", () => {
		expect(draw("waiting").querySelector(".dure-loader")).toBeNull();
		const working = draw("working");
		expect(
			working.querySelector(".dure-loader")?.getAttribute("aria-label"),
		).toBe(t("common.working"));
		expect(working.querySelector(".session-row__provider")).toBeNull();
		expect(draw("waiting").querySelector(".dure-loader")).toBeNull();
	});
	it.each([
		undefined,
		"unknown",
		"connecting",
		"input",
		"blocked",
		"error",
		"exited",
	] as const)(
		"does not infer work from a ready session whose activity is %s",
		(state) => {
			expect(draw(state).querySelector(".dure-loader")).toBeNull();
		},
	);
	it("stops claiming cached work after the computer goes offline", () => {
		expect(draw("working", false).querySelector(".dure-loader")).toBeNull();
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

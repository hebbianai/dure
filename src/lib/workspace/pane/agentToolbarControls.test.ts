import { describe, expect, it } from "vitest";
import {
	AGENT_TOOLBAR_CONTROLS,
	agentToolbarControlOffered,
	agentToolbarControlVisible,
	hiddenAgentToolbarControlDescriptors,
	withAgentToolbarControlHidden,
	withAgentToolbarControlRestored,
} from "@/lib/workspace/pane/agentToolbarControls";

describe("agent toolbar control visibility", () => {
	it("basic mode keeps essential controls and folds pro-tier ones", () => {
		const prefs = { interfaceMode: "basic" as const };
		// The one View control is how a Basic user moves an existing terminal
		// agent into Chat (#554, reversing the 2026-08-31 Pro-only call).
		expect(agentToolbarControlVisible("view-switch", prefs)).toBe(true);
		expect(agentToolbarControlVisible("diff-window", prefs)).toBe(true);
		expect(agentToolbarControlVisible("conversation-history", prefs)).toBe(
			true,
		);
		expect(agentToolbarControlVisible("launch-model", prefs)).toBe(false);
		expect(agentToolbarControlVisible("launch-permissions", prefs)).toBe(false);
		expect(agentToolbarControlVisible("account", prefs)).toBe(true);
	});

	it("pro mode shows everything not explicitly hidden", () => {
		const prefs = { interfaceMode: "pro" as const };
		for (const control of AGENT_TOOLBAR_CONTROLS) {
			expect(agentToolbarControlVisible(control.id, prefs)).toBe(true);
		}
		expect(
			agentToolbarControlVisible("launch-effort", {
				interfaceMode: "pro",
				hiddenToolbarControls: ["launch-effort"],
			}),
		).toBe(false);
	});

	it("keeps Permissions Pro-only while credential attention overrides hiding", () => {
		const prefs = {
			interfaceMode: "basic" as const,
			hiddenToolbarControls: ["launch-permissions", "account"],
		};
		expect(
			agentToolbarControlVisible("launch-permissions", prefs, {
				mustShow: true,
			}),
		).toBe(false);
		expect(
			agentToolbarControlVisible(
				"launch-permissions",
				{ ...prefs, interfaceMode: "pro" },
				{ mustShow: true },
			),
		).toBe(true);
		expect(
			agentToolbarControlVisible("account", prefs, { mustShow: true }),
		).toBe(true);
		expect(agentToolbarControlVisible("account", prefs)).toBe(false);
	});

	it("restoring an explicitly hidden account control returns it in Basic", () => {
		const hiddenToolbarControls = ["account"];
		expect(
			agentToolbarControlVisible("account", {
				interfaceMode: "basic",
				hiddenToolbarControls,
			}),
		).toBe(false);
		expect(
			agentToolbarControlVisible("account", {
				interfaceMode: "basic",
				hiddenToolbarControls: withAgentToolbarControlRestored(
					hiddenToolbarControls,
					"account",
				),
			}),
		).toBe(true);
	});

	it("hide is idempotent and restore deletes the override", () => {
		const once = withAgentToolbarControlHidden(undefined, "diff-window");
		expect(once).toEqual(["diff-window"]);
		expect(withAgentToolbarControlHidden(once, "diff-window")).toEqual([
			"diff-window",
		]);
		expect(withAgentToolbarControlRestored(once, "diff-window")).toEqual([]);
	});

	it("restore listing keeps catalog order and drops unknown ids", () => {
		const listed = hiddenAgentToolbarControlDescriptors({
			hiddenToolbarControls: ["launch-model", "not-a-control", "view-switch"],
		});
		expect(listed.map((control) => control.id)).toEqual([
			"view-switch",
			"launch-model",
		]);
	});
});

describe("agent toolbar surfaces", () => {
	it("offers every control in the pane", () => {
		for (const control of AGENT_TOOLBAR_CONTROLS) {
			expect(agentToolbarControlOffered(control.id, "pane")).toBe(true);
		}
	});

	it("names the large window's routed controls and why the others are absent", () => {
		const offered = AGENT_TOOLBAR_CONTROLS.filter((control) =>
			agentToolbarControlOffered(control.id, "large_window"),
		).map((control) => control.id);
		// The View control, project move, the launch pills (#624) and the
		// account run in the source pane over the bridge; the diff and
		// source-control windows need no pane at all.
		expect(offered.sort()).toEqual([
			"account",
			"diff-window",
			"launch-effort",
			"launch-model",
			"launch-permissions",
			"project-move",
			"source-control-window",
			"view-switch",
		]);
		for (const control of AGENT_TOOLBAR_CONTROLS) {
			if (control.largeWindow.offered) continue;
			expect(control.largeWindow.reason.length, control.id).toBeGreaterThan(0);
		}
	});

	it("lets no attention signal show a control its surface does not offer", () => {
		expect(
			agentToolbarControlVisible(
				"conversation-history",
				{ interfaceMode: "pro", surface: "large_window" },
				{ mustShow: true },
			),
		).toBe(false);
		expect(
			agentToolbarControlVisible(
				"view-switch",
				{
					interfaceMode: "basic",
					surface: "large_window",
					hiddenToolbarControls: ["view-switch"],
				},
				{ mustShow: true },
			),
		).toBe(true);
	});
});

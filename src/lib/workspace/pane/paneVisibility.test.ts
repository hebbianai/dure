import { describe, expect, it, vi } from "vitest";
import {
	excludeHiddenAgentPanes,
	hidePanePreservingLayout,
	retargetMovedHiddenPanes,
	restorePanePreservingLayout,
} from "@/lib/workspace/pane/paneVisibility";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";

describe("pane visibility", () => {
	it("keeps hidden agents out of the live Spaces rows", () => {
		const spaces = [
			{ key: "agent:a", agentId: "a" },
			{ key: "agent:b", agentId: "b" },
			{ key: "term:1" },
		];

		expect(excludeHiddenAgentPanes(spaces, { a: {} })).toEqual([
			spaces[1],
			spaces[2],
		]);
	});

	it("returns false without mutating when the panel no longer exists", () => {
		const getPanel = vi.fn(() => undefined);
		const api = { getPanel };

		expect(hidePanePreservingLayout(api, "missing")).toBe(false);
		expect(restorePanePreservingLayout(api, "missing")).toBe(false);
		expect(getPanel).toHaveBeenCalledTimes(2);
	});

	it("clears the restore record after revealing an existing agent pane", () => {
		const setVisible = vi.fn();
		const setActive = vi.fn();
		useHiddenPanes.setState({
			hidden: { a: { desktopId: "desktop", paneId: "agent:a", at: 1 } },
		});
		const api = {
			getPanel: vi.fn(() => ({
				id: "agent:a",
				params: { agentRef: { agentId: "a" } },
				group: { api: { setVisible } },
				api: { setActive, component: "agent" },
			})),
		};

		expect(restorePanePreservingLayout(api as never, "agent:a")).toBe(true);
		expect(setVisible).toHaveBeenCalledWith(true);
		expect(setActive).toHaveBeenCalledOnce();
		expect(useHiddenPanes.getState().hidden.a).toBeUndefined();
	});

	it("retargets only successfully moved hidden agent panes", () => {
		useHiddenPanes.setState({
			hidden: {
				a: {
					paneId: "agent:a",
					desktopId: "source",
					at: 1,
					anchor: { referencePanelId: "x", direction: "right" },
				},
				kept: { desktopId: "source", paneId: "agent:kept", at: 2 },
			},
		});
		const receipt = {
			movedPanelIds: ["agent:a", "term:1", "agent:visible"],
			updates: {
				source: { panels: {} },
				target: {
					panels: {
						"agent:a": { contentComponent: "agent" },
						"term:1": { contentComponent: "terminal" },
						"agent:visible": { contentComponent: "agent" },
					},
				},
			},
		};

		expect(
			retargetMovedHiddenPanes(receipt, "target", receipt.updates.target),
		).toBe(receipt);
		expect(useHiddenPanes.getState().hidden).toMatchObject({
			a: { desktopId: "target" },
			kept: { desktopId: "source", at: 2 },
		});
		expect(useHiddenPanes.getState().hidden.a?.anchor).toBeUndefined();

		useHiddenPanes.setState({ hidden: {} });
	});
});

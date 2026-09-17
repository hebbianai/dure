import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDockview: vi.fn(),
	hidePanePreservingLayout: vi.fn(),
	markPaneHidden: vi.fn(),
	paneHideAnchor: vi.fn(),
	removePanelsWithoutSessionTeardown: vi.fn(),
}));

vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	getDockview: mocks.getDockview,
}));
vi.mock("@/lib/workspace/pane/paneCloseCoordinator", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/pane/paneCloseCoordinator")>()),
	removePanelsWithoutSessionTeardown: mocks.removePanelsWithoutSessionTeardown,
}));
vi.mock("@/lib/workspace/pane/hiddenFilePanesStore", () => ({
	markFilePaneHidden: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/hiddenPanesStore", () => ({
	markPaneHidden: mocks.markPaneHidden,
}));
vi.mock("@/lib/workspace/pane/paneHideAnchor", () => ({
	paneHideAnchor: mocks.paneHideAnchor,
}));
vi.mock("@/lib/workspace/pane/paneVisibility", () => ({
	hidePanePreservingLayout: mocks.hidePanePreservingLayout,
}));

import { hidePaneWithRecord } from "@/lib/workspace/pane/paneHideActions";
import { markFilePaneHidden } from "@/lib/workspace/pane/hiddenFilePanesStore";

describe("hidePaneWithRecord", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.paneHideAnchor.mockReturnValue({
			referencePanelId: "agent:neighbor",
			direction: "right",
		});
	});

	it("records a preserved grid pane only after Dockview hides it", () => {
		const api = {};
		mocks.getDockview.mockReturnValue(api);
		mocks.hidePanePreservingLayout.mockReturnValue(true);

		hidePaneWithRecord({
			desktopId: "desk",
			panelId: "agent:a",
			agentId: "a",
		});

		expect(mocks.hidePanePreservingLayout).toHaveBeenCalledWith(api, "agent:a");
		expect(mocks.markPaneHidden).toHaveBeenCalledWith("a", "desk", "agent:a", {
			referencePanelId: "agent:neighbor",
			direction: "right",
		});
		expect(mocks.hidePanePreservingLayout.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.markPaneHidden.mock.invocationCallOrder[0],
		);
		expect(mocks.removePanelsWithoutSessionTeardown).not.toHaveBeenCalled();
	});

	it("records a fallback pane only after removing its panel", () => {
		mocks.getDockview.mockReturnValue(undefined);

		hidePaneWithRecord({
			desktopId: "desk",
			panelId: "agent:a",
			agentId: "a",
		});

		expect(mocks.removePanelsWithoutSessionTeardown).toHaveBeenCalledWith([
			"agent:a",
		]);
		expect(
			mocks.removePanelsWithoutSessionTeardown.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.markPaneHidden.mock.invocationCallOrder[0]);
	});

	it("records a file view by its exact pane ID without persisting a runtime connection", () => {
		mocks.getDockview.mockReturnValue({});
		mocks.hidePanePreservingLayout.mockReturnValue(true);
		hidePaneWithRecord({
			desktopId: "desk",
			panelId: "pane-file",
			file: { path: "/a", source: "ssh", hostId: "host", sessionId: "transient" },
		});
		expect(markFilePaneHidden).toHaveBeenCalledExactlyOnceWith("pane-file", {
			desktopId: "desk",
			file: { path: "/a", source: "ssh", hostId: "host" },
			anchor: { referencePanelId: "agent:neighbor", direction: "right" },
		});
		expect(mocks.hidePanePreservingLayout.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(markFilePaneHidden).mock.invocationCallOrder[0],
		);
		expect(mocks.markPaneHidden).not.toHaveBeenCalled();
		expect(mocks.removePanelsWithoutSessionTeardown).not.toHaveBeenCalled();
	});
});

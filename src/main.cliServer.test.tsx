// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createRoot: vi.fn(() => ({ render: vi.fn() })),
	startCliServer: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/lib/platform/reactDomClient", () => ({
	default: { createRoot: mocks.createRoot },
}));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./components/AppErrorBoundary", () => ({
	AppErrorBoundary: ({ children }: { children: unknown }) => children,
	RenderFailure: () => null,
}));
vi.mock("@/lib/persistence/persistStorage", () => ({
	removeRetiredInteractionInboxProjection: vi.fn(),
}));
vi.mock("@/lib/platform/staleModuleReload", () => ({
	autoReloadForStaleModule: vi.fn(),
}));
vi.mock("@/lib/workspace/performance/windowPerformanceReporter", () => ({
	installWindowPerformanceReporter: vi.fn(() => Promise.resolve(vi.fn())),
}));
vi.mock("@/lib/workspace/window/agentSessionWindowSource", () => ({
	agentSessionSourceFromSearch: vi.fn(() => ({
		windowLabel: "main",
		paneOwnerId: undefined,
	})),
}));
vi.mock("./qa", () => ({ installQa: vi.fn() }));
vi.mock("./qa/hmuxWindowFocusRoots", () => ({
	HmuxWindowFocusQaRoot: () => null,
}));
vi.mock("./qa/designModeProbe", () => ({
	maybeRunDesignModeProbe: vi.fn(),
}));
vi.mock("@/lib/cli/cliServer", () => ({
	startCliServer: mocks.startCliServer,
}));

describe("WebView entry services", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		document.body.innerHTML = '<div id="root"></div>';
	});

	it.each([
		["the normal app", "/"],
		["the bare Hmux QA controller", "/?qaWindowSmokeController=1"],
	])("starts one CLI receipt authority for %s", async (_surface, url) => {
		window.history.replaceState(null, "", url);

		await import("./main");

		expect(mocks.startCliServer).toHaveBeenCalledOnce();
	});
});

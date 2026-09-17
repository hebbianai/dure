import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prepareRequest: undefined as
		| undefined
		| ((request: {
				workspaceId: string;
				sessionId: string;
				sourcePaneOwnerId?: string;
				generation: string;
				expiresAtMs: number;
		  }) => unknown),
	retiredRequest: undefined as
		| undefined
		| ((request: {
				workspaceId: string;
				sessionId: string;
				sourcePaneOwnerId?: string;
				generation: string;
		  }) => void),
}));

vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: () => undefined,
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", () => ({
	navigateToPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneVisibility", () => ({
	restorePanePreservingLayout: vi.fn(),
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({
			activeSpaceId: "desktop-a",
			spaces: [{ id: "desktop-a" }],
			layouts: {
				"desktop-a": {
					panels: { "pane-a": { params: {} } },
				},
			},
		}),
	},
}));
vi.mock("./largeViewReturnHandoff", () => ({
	subscribeLargeViewReturnLifecycleRequests: (handlers: {
		prepare: typeof mocks.prepareRequest;
		retired: typeof mocks.retiredRequest;
	}) => {
		mocks.prepareRequest = handlers.prepare;
		mocks.retiredRequest = handlers.retired;
		return vi.fn();
	},
}));

import { bindLargeViewReturnSource } from "./largeViewReturnSourceRuntime";

describe("bound large-view return source", () => {
	beforeEach(() => {
		mocks.prepareRequest = undefined;
		mocks.retiredRequest = undefined;
	});

	it("captures every retry generation without concealing twice", async () => {
		const prepare = vi.fn(() => true);
		const conceal = vi.fn();
		const reveal = vi.fn();
		const retired = vi.fn();
		const source = bindLargeViewReturnSource({
			workspaceId: "workspace-a",
			sessionId: "session-a",
			sourcePaneOwnerId: "desktop-a:pane-a",
			legacyEligible: () => true,
			prepare,
			retired,
			conceal,
			reveal,
		});
		expect(mocks.prepareRequest).toBeTypeOf("function");

		const first = await mocks.prepareRequest?.({
			workspaceId: "workspace-a",
			sessionId: "session-a",
			sourcePaneOwnerId: "desktop-a:pane-a",
			generation: "return-1",
			expiresAtMs: Date.now() + 1_000,
		});
		const second = await mocks.prepareRequest?.({
			workspaceId: "workspace-a",
			sessionId: "session-a",
			sourcePaneOwnerId: "desktop-a:pane-a",
			generation: "return-2",
			expiresAtMs: Date.now() + 1_000,
		});

		expect(prepare.mock.calls).toEqual([["return-1"], ["return-2"]]);
		expect(conceal).toHaveBeenCalledOnce();
		expect(source.currentGeneration()).toBe("return-2");
		mocks.retiredRequest?.({
			workspaceId: "workspace-a",
			sessionId: "session-a",
			sourcePaneOwnerId: "desktop-a:pane-a",
			generation: "return-2",
		});
		expect(retired).toHaveBeenCalledWith("return-2");
		expect(first).toBeTypeOf("function");
		expect(second).toBeTypeOf("function");
		(second as () => void)();
		expect(reveal).toHaveBeenCalledOnce();
		source.dispose();
	});
});

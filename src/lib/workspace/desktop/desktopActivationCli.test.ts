// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(async () => true),
	complete: vi.fn(async () => undefined),
	route: vi.fn(async () => ({ kind: "here" as const })),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: mocks.claim,
	completeCliRequest: mocks.complete,
}));
vi.mock("@/lib/cli/cliSpaceOwnerRouting", () => ({
	routeCliRequestToSpaceOwner: mocks.route,
}));

import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { handleSpaceActivationCliRequest } from "@/lib/workspace/desktop/desktopActivationCli";
import { useStore } from "@/store";

describe("dure space show", () => {
	beforeEach(() => {
		useStore.setState({
			spaces: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
			activeSpaceId: "one",
		});
		useWindowSidebarStore.getState().setTab("work");
	});

	afterEach(() => {
		useWindowSidebarStore.getState().setTab("spaces");
	});

	it.each(["one", "two"])(
		"shows Space %s in front of the Work view, the active one included",
		async (spaceId) => {
			await handleSpaceActivationCliRequest({ spaceId }, "req-1");
			expect(useStore.getState().activeSpaceId).toBe(spaceId);
			expect(useWindowSidebarStore.getState().tab).toBe("spaces");
			expect(mocks.complete).toHaveBeenCalledWith(
				"req-1",
				expect.objectContaining({ ok: true }),
				"space.activate",
			);
		},
	);
});

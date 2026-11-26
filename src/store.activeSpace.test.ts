// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

describe("setActiveSpace intent", () => {
	beforeEach(() => {
		useStore.setState((state) => ({
			spaces: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
			activeSpaceId: "one",
			uiPrefs: { ...state.uiPrefs, tabOrder: "manual" },
		}));
		useWindowSidebarStore.getState().setTab("files");
		useWindowSidebarStore.getState().setTab("work");
	});

	afterEach(() => {
		useWindowSidebarStore.getState().setTab("spaces");
	});

	it("brings the Spaces deck forward on a reveal, back to the tab it was shown with", () => {
		useStore.getState().setActiveSpace("two", "reveal");
		expect(useStore.getState().activeSpaceId).toBe("two");
		expect(useWindowSidebarStore.getState().tab).toBe("files");
	});

	it("reveals the Space already active, without rewriting the store", () => {
		const before = useStore.getState();
		useStore.getState().setActiveSpace("one", "reveal");
		expect(useStore.getState()).toBe(before);
		expect(useWindowSidebarStore.getState().tab).toBe("files");
	});

	it("leaves the Work view in front on a mount", () => {
		useStore.getState().setActiveSpace("two", "mount");
		expect(useStore.getState().activeSpaceId).toBe("two");
		expect(useWindowSidebarStore.getState().tab).toBe("work");
	});

	it("still records a visit for recent tab order", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, tabOrder: "recent" },
			spaceVisits: {},
		}));
		useStore.getState().setActiveSpace("one", "reveal");
		expect(useStore.getState().spaceVisits.one).toBeTypeOf("number");
	});

	it("treats a new Space made active as a reveal, and an inactive one as nothing", () => {
		useStore.getState().addSpace({ activate: false });
		expect(useWindowSidebarStore.getState().tab).toBe("work");
		const id = useStore.getState().addSpace();
		expect(useStore.getState().activeSpaceId).toBe(id);
		expect(useWindowSidebarStore.getState().tab).toBe("files");
	});
});

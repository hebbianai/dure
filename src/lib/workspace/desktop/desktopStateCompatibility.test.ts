import { describe, expect, it } from "vitest";
import { createStore } from "zustand";
import {
	projectDesktopCompatibilityUpdate,
	withDesktopStateCompatibility,
} from "./desktopStateCompatibility";

interface TestState {
	spaces: Array<{ id: string; name: string; originSpaceId?: string }>;
	activeSpaceId: string;
	spaceVisits: Record<string, number>;
	desktops: TestState["spaces"];
	activeDesktopId: string;
	desktopVisits: Record<string, number>;
	setActiveSpace(id: string): void;
}

function store() {
	const initialSpaces = [{ id: "space-a", name: "A" }];
	const visits = { "space-a": 1 };
	return createStore<TestState>(
		withDesktopStateCompatibility((set) => ({
			spaces: initialSpaces,
			activeSpaceId: "space-a",
			spaceVisits: visits,
			desktops: initialSpaces,
			activeDesktopId: "space-a",
			desktopVisits: visits,
			setActiveSpace: (id) => set({ activeSpaceId: id }),
		})),
	);
}

describe("deprecated Desktop state facade", () => {
	it("projects canonical mutations with the same identity objects", () => {
		const state = store();
		const spaces = [
			{ id: "space-a", name: "A" },
			{ id: "space-b", name: "B" },
		];
		state.setState({ spaces, activeSpaceId: "space-b" });
		expect(state.getState().desktops).toBe(spaces);
		expect(state.getState().activeDesktopId).toBe("space-b");
	});

	it("normalizes deprecated writes into the single Space authority", () => {
		const state = store();
		state.setState({
			desktops: [
				{ id: "space-a", name: "A" },
				{
					id: "space-popout",
					name: "Popout",
					originDesktopId: "space-a",
				},
			],
			activeDesktopId: "space-popout",
		} as Partial<TestState>);

		const current = state.getState();
		expect(current.spaces[1]).toEqual({
			id: "space-popout",
			name: "Popout",
			originSpaceId: "space-a",
		});
		expect(current.desktops).toBe(current.spaces);
		expect(current.activeSpaceId).toBe("space-popout");
		expect(current.activeDesktopId).toBe("space-popout");
	});

	it("preserves no-op state identity", () => {
		const state = store();
		const before = state.getState();
		expect(projectDesktopCompatibilityUpdate(before, before)).toBe(before);
	});
});

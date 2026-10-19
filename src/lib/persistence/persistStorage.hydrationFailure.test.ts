import { describe, expect, it } from "vitest";
import { createStore } from "zustand";
import { persist } from "zustand/middleware";
import {
	DurableWriteCoordinator,
	type ExclusiveLockAuthority,
} from "@/lib/persistence/durableWriteCoordinator";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";

type TestState = {
	spaces: Array<{ id: string; name: string }>;
	// The app store's empty-over-non-empty guard reads `layouts` from every
	// `agent-ide` value, so the fixture carries it like the real slice does.
	layouts: Record<string, unknown>;
	installedAgents: string[];
	setInstalledAgents: (installedAgents: string[]) => void;
};

class MemoryStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

const immediateAuthority: ExclusiveLockAuthority = {
	request: (_name, operation) => Promise.resolve().then(operation),
};

const SAVED = JSON.stringify({
	version: 1,
	state: {
		spaces: [{ id: "space-a", name: "Saved" }, { id: "space-b", name: "Other" }],
		layouts: {},
	},
});

function createHydratingStore(
	storage: MemoryStorage,
	migrate: (value: unknown, fromVersion: number) => unknown,
) {
	const durable = createReferenceAwareLocalStorage<Pick<TestState, "spaces" | "layouts">>({
		coordinator: new DurableWriteCoordinator(immediateAuthority),
		storage,
	});
	const store = createStore<TestState>()(
		persist(
			(set) => ({
				spaces: [{ id: "default", name: "Space 1" }],
				layouts: {},
				installedAgents: [],
				setInstalledAgents: (installedAgents) => set({ installedAgents }),
			}),
			{
				name: "agent-ide",
				version: 2,
				storage: durable,
				partialize: (state) => ({ spaces: state.spaces, layouts: state.layouts }),
				migrate: migrate as never,
				onRehydrateStorage: () => (_state, error) => {
					if (error) durable.quarantineHydrationFailure("agent-ide", error);
				},
			},
		),
	);
	return { store, durable };
}

describe("durable hydration failure", () => {
	it("keeps saved spaces when migration throws and the app keeps writing", async () => {
		const storage = new MemoryStorage();
		storage.values.set("agent-ide", SAVED);
		const { store, durable } = createHydratingStore(storage, () => {
			throw new TypeError("Cannot read properties of null (reading 'id')");
		});

		// The store could not adopt the saved state, so it still holds defaults.
		expect(store.getState().spaces).toEqual([{ id: "default", name: "Space 1" }]);
		// A runtime-only update at startup must not write those defaults over it.
		store.getState().setInstalledAgents(["claude"]);
		store.setState({ spaces: [{ id: "new", name: "New" }] });
		await durable.flush();

		expect(storage.values.get("agent-ide")).toBe(SAVED);
		expect(storage.values.get("agent-ide:hydration-failed-backup")).toBe(SAVED);
	});

	it("still persists normally after a successful hydration", async () => {
		const storage = new MemoryStorage();
		storage.values.set("agent-ide", SAVED);
		const { store, durable } = createHydratingStore(storage, (value) => value);

		expect(store.getState().spaces.map((space) => space.id)).toEqual(["space-a", "space-b"]);
		store.setState({ spaces: [{ id: "space-a", name: "Renamed" }] });
		await durable.flush();

		expect(JSON.parse(storage.values.get("agent-ide") ?? "null").state.spaces).toEqual([
			{ id: "space-a", name: "Renamed" },
		]);
		expect(storage.values.has("agent-ide:hydration-failed-backup")).toBe(false);
	});
});

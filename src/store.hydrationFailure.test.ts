// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DURABLE_APP_STORE_NAME,
	PERSIST_VERSION,
} from "@/lib/persistence/durableAppStoreName";

vi.mock("@/lib/ipc/telemetry", () => ({ track: vi.fn() }));

afterEach(() => {
	vi.doUnmock("@/lib/persistence/persistedAppState");
	vi.resetModules();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("app store hydration failure", () => {
	it("keeps the saved app state when the store cannot adopt it", async () => {
		const saved = JSON.stringify({
			version: PERSIST_VERSION - 1,
			state: {
				spaces: [{ id: "desk-saved", name: "Saved" }],
				layouts: { "desk-saved": { panes: [] } },
			},
		});
		localStorage.setItem(DURABLE_APP_STORE_NAME, saved);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.resetModules();
		vi.doMock("@/lib/persistence/persistedAppState", async (importOriginal) => ({
			...(await importOriginal<typeof import("@/lib/persistence/persistedAppState")>()),
			migratePersistedState: () => {
				throw new TypeError("unreadable saved state");
			},
		}));

		const { durableAppStorage, useStore } = await import("@/store");
		useStore.getState().addSpace({ name: "Unsaved" });
		await durableAppStorage.flush();

		expect(localStorage.getItem(DURABLE_APP_STORE_NAME)).toBe(saved);
		expect(
			localStorage.getItem(`${DURABLE_APP_STORE_NAME}:hydration-failed-backup`),
		).toBe(saved);
	});
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listenWhenReady: vi.fn(async () => () => undefined),
}));

vi.mock("@/lib/platform/tauriBridge", () => ({
	listenWhenReady: mocks.listenWhenReady,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { startWindowSync } from "@/lib/workspace/window/windows";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";

describe("window durable-store synchronization", () => {
	it("keeps Window as the queueMicrotask receiver for storage events", async () => {
		const nativeSchedule = window.queueMicrotask.bind(window);
		const schedule = vi
			.spyOn(window, "queueMicrotask")
			.mockImplementation(function (this: Window, operation: VoidFunction) {
				if (this !== window) {
					throw new TypeError(
						"Can only call Window.queueMicrotask on instances of Window",
					);
				}
				nativeSchedule(operation);
			});
		const reconcile = vi
			.spyOn(durableAppStorage, "reconcile")
			.mockResolvedValue(undefined);
		const rehydrate = vi
			.spyOn(useStore.persist, "rehydrate")
			.mockResolvedValue(undefined);
		const errors: unknown[] = [];
		const captureError = (event: ErrorEvent) => {
			errors.push(event.error);
			event.preventDefault();
		};
		window.addEventListener("error", captureError);
		const stop = startWindowSync();

		try {
			await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
			schedule.mockClear();
			reconcile.mockClear();
			rehydrate.mockClear();
			window.dispatchEvent(
				new StorageEvent("storage", { key: DURABLE_APP_STORE_NAME }),
			);
			window.dispatchEvent(
				new StorageEvent("storage", { key: DURABLE_APP_STORE_NAME }),
			);

			await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
			expect(errors).toEqual([]);
			await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
			expect(reconcile).toHaveBeenCalledOnce();
		} finally {
			stop();
			window.removeEventListener("error", captureError);
			schedule.mockRestore();
			reconcile.mockRestore();
			rehydrate.mockRestore();
		}
	});
});

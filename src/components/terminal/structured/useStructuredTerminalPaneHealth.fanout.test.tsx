// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { useStore } from "@/store";
import { useStructuredTerminalPaneHealth } from "./useStructuredTerminalPaneHealth";

const paneHealthId = "desktop-a:term:target";

afterEach(() => clearHmuxPaneHealth(paneHealthId));

describe("structured terminal pane health fan-out", () => {
	it("keeps exact frame progress out of unrelated global store subscribers", () => {
		const unrelatedObservers = Array.from({ length: 14 }, () => vi.fn());
		const stopObservers = unrelatedObservers.map((observer) =>
			useStore.subscribe(observer),
		);
		const { result } = renderHook(() =>
			useStructuredTerminalPaneHealth(paneHealthId),
		);
		let unrelatedNotificationCount = 0;

		try {
			act(() => {
				result.current({
					kind: "frame_received",
					terminalEpoch: "epoch-a",
					sequence: "42",
				});
				result.current({
					kind: "frame_presented",
					terminalEpoch: "epoch-a",
					sequence: "42",
				});
			});
			unrelatedNotificationCount = unrelatedObservers.reduce(
				(total, observer) => total + observer.mock.calls.length,
				0,
			);
		} finally {
			for (const stop of stopObservers) stop();
		}

		expect(unrelatedNotificationCount).toBe(0);
	});
});

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
	getTerminalExecutionLocation,
	hasTerminalExecutionLocationObservation,
	publishTerminalExecutionLocation,
	subscribeTerminalExecutionLocations,
	useTerminalExecutionLocation,
	useTerminalExecutionLocationObservation,
} from "@/lib/terminal/terminalExecutionLocationStore";

describe("terminal execution location store", () => {
	it("distinguishes a default local fallback from an observed local fact", () => {
		const sessionId = "location-store-observed-local";
		const listener = vi.fn();
		const unsubscribe = subscribeTerminalExecutionLocations(listener);

		expect(getTerminalExecutionLocation(sessionId)).toEqual({ kind: "local" });
		expect(hasTerminalExecutionLocationObservation(sessionId)).toBe(false);
		publishTerminalExecutionLocation(sessionId, { kind: "local" });
		publishTerminalExecutionLocation(sessionId, { kind: "local" });
		expect(hasTerminalExecutionLocationObservation(sessionId)).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("rerenders when the local fallback becomes an observed local fact", () => {
		const sessionId = "location-store-local-observation-hook";
		const { result } = renderHook(() =>
			useTerminalExecutionLocationObservation(sessionId),
		);

		expect(result.current).toBe(false);
		act(() =>
			publishTerminalExecutionLocation(sessionId, {
				kind: "local",
			}),
		);
		expect(result.current).toBe(true);
	});

	it("publishes per-session SSH transitions and returns to local", () => {
		const sessionId = "location-store-transition";
		const globalListener = vi.fn();
		const unsubscribe = subscribeTerminalExecutionLocations(globalListener);
		const { result } = renderHook(() => useTerminalExecutionLocation(sessionId));

		act(() =>
			publishTerminalExecutionLocation(sessionId, {
				kind: "ssh",
				target: "rts@example.test",
			}),
		);
		expect(result.current).toEqual({
			kind: "ssh",
			target: "rts@example.test",
		});
		expect(globalListener).toHaveBeenCalledTimes(1);

		act(() =>
			publishTerminalExecutionLocation(sessionId, {
				kind: "local",
			}),
		);
		expect(result.current).toEqual({ kind: "local" });
		expect(getTerminalExecutionLocation(sessionId)).toEqual({ kind: "local" });
		unsubscribe();
	});

	it("does not notify for an equivalent observation", () => {
		const sessionId = "location-store-equivalent";
		const listener = vi.fn();
		const unsubscribe = subscribeTerminalExecutionLocations(listener);
		publishTerminalExecutionLocation(sessionId, {
			kind: "ssh",
			target: "host",
		});
		publishTerminalExecutionLocation(sessionId, {
			kind: "ssh",
			target: "host",
		});
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("holds an explicit unknown state until hmux publishes a structured fact", () => {
		const sessionId = "location-store-unknown";
		const listener = vi.fn();
		const unsubscribe = subscribeTerminalExecutionLocations(listener);

		publishTerminalExecutionLocation(sessionId, { kind: "unknown" });
		publishTerminalExecutionLocation(sessionId, { kind: "unknown" });
		expect(getTerminalExecutionLocation(sessionId)).toEqual({ kind: "unknown" });
		expect(hasTerminalExecutionLocationObservation(sessionId)).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);

		publishTerminalExecutionLocation(sessionId, {
			kind: "ssh",
			target: "rts@211.181.122.124",
		});
		expect(getTerminalExecutionLocation(sessionId)).toEqual({
			kind: "ssh",
			target: "rts@211.181.122.124",
		});
		expect(listener).toHaveBeenCalledTimes(2);
		unsubscribe();
	});
});

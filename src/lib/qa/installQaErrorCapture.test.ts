import { describe, expect, it, vi } from "vitest";
import { installQaErrorCapture } from "@/lib/qa/installQaErrorCapture";

describe("installQaErrorCapture", () => {
	it("forwards browser and console failures to the QA logger", () => {
		const listeners = new Map<string, EventListener>();
		const target = {
			addEventListener(
				type: string,
				listener: EventListenerOrEventListenerObject,
			) {
				listeners.set(type, listener as EventListener);
			},
		} as Pick<EventTarget, "addEventListener">;
		const originalConsoleError = vi.fn();
		const consoleTarget = { error: originalConsoleError };
		const log = vi.fn();
		const recordRuntimeError = vi.fn();

		installQaErrorCapture(target, consoleTarget, log, recordRuntimeError);
		const windowError = new Error("boom");
		listeners.get("error")?.({
			message: "boom",
			filename: "qa.ts",
			lineno: 12,
			colno: 34,
			error: windowError,
		} as ErrorEvent);
		const rejection = new Error("rejected");
		listeners.get("unhandledrejection")?.({
			reason: rejection,
		} as PromiseRejectionEvent);
		consoleTarget.error("bad", 7);

		expect(log).toHaveBeenCalledWith("window.onerror", "boom", "qa.ts:12:34");
		expect(log).toHaveBeenCalledWith(
			"unhandledrejection",
			"Error: rejected",
			rejection.stack,
		);
		expect(log).toHaveBeenCalledWith("console.error", "bad", "7");
		expect(originalConsoleError).toHaveBeenCalledWith("bad", 7);
		expect(recordRuntimeError).toHaveBeenNthCalledWith(1, {
			kind: "window_error",
			message: "boom",
			filename: "qa.ts",
			line: 12,
			column: 34,
			stack: windowError.stack,
		});
		expect(recordRuntimeError).toHaveBeenNthCalledWith(2, {
			kind: "unhandled_rejection",
			message: "Error: rejected",
			stack: rejection.stack,
		});
		expect(recordRuntimeError).toHaveBeenCalledTimes(2);
	});

	it("captures a ResizeObserver browser error even without a nested Error", () => {
		const listeners = new Map<string, EventListener>();
		const target = {
			addEventListener(
				type: string,
				listener: EventListenerOrEventListenerObject,
			) {
				listeners.set(type, listener as EventListener);
			},
		} as Pick<EventTarget, "addEventListener">;
		const recordRuntimeError = vi.fn();

		installQaErrorCapture(
			target,
			{ error: vi.fn() },
			vi.fn(),
			recordRuntimeError,
		);
		listeners.get("error")?.({
			message: "ResizeObserver loop completed with undelivered notifications.",
			filename: "",
			lineno: 0,
			colno: 0,
		} as ErrorEvent);

		expect(recordRuntimeError).toHaveBeenCalledWith({
			kind: "window_error",
			message: "ResizeObserver loop completed with undelivered notifications.",
			filename: "",
			line: 0,
			column: 0,
			stack: undefined,
		});
	});

	it("does not classify console.error as a runtime error", () => {
		const target = {
			addEventListener: vi.fn(),
		} as unknown as Pick<EventTarget, "addEventListener">;
		const originalConsoleError = vi.fn();
		const consoleTarget = { error: originalConsoleError };
		const log = vi.fn();
		const recordRuntimeError = vi.fn();

		installQaErrorCapture(target, consoleTarget, log, recordRuntimeError);
		consoleTarget.error("expected diagnostic");

		expect(log).toHaveBeenCalledWith("console.error", "expected diagnostic");
		expect(originalConsoleError).toHaveBeenCalledWith("expected diagnostic");
		expect(recordRuntimeError).not.toHaveBeenCalled();
	});

	it("records only classified fatal console errors and warnings", () => {
		const target = {
			addEventListener: vi.fn(),
		} as unknown as Pick<EventTarget, "addEventListener">;
		const originalConsoleError = vi.fn();
		const originalConsoleWarn = vi.fn();
		const consoleTarget = {
			error: originalConsoleError,
			warn: originalConsoleWarn,
		};
		const log = vi.fn();
		const recordRuntimeError = vi.fn();

		installQaErrorCapture(target, consoleTarget, log, recordRuntimeError);
		consoleTarget.warn(
			"[TAURI] Couldn't find callback id 1125547665. This might happen after reload.",
		);
		consoleTarget.error(
			"There are too many active WebGL contexts on this page, the oldest context will be lost.",
		);
		consoleTarget.warn("ordinary scheduling diagnostic");
		consoleTarget.error("expected application error");

		expect(recordRuntimeError).toHaveBeenCalledTimes(2);
		expect(recordRuntimeError).toHaveBeenNthCalledWith(1, {
			kind: "fatal_console",
			message:
				"[tauri_callback_missing] [TAURI] Couldn't find callback id 1125547665. This might happen after reload.",
			stack: undefined,
		});
		expect(recordRuntimeError).toHaveBeenNthCalledWith(2, {
			kind: "fatal_console",
			message:
				"[webgl_context_exhausted] There are too many active WebGL contexts on this page, the oldest context will be lost.",
			stack: undefined,
		});
		expect(originalConsoleWarn).toHaveBeenCalledTimes(2);
		expect(originalConsoleError).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(
			"console.warn",
			"ordinary scheduling diagnostic",
		);
	});
});

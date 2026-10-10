// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyWebviewDiagnostic,
	installWebviewDiagnostics,
} from "./webviewDiagnostics";

const sensitive =
	"https://user:password@example.invalid/private?token=secret /Users/private conversation";
afterEach(() => vi.useRealTimers());

describe("redacted WebView diagnostics", () => {
	it("retains known failure codes without persisting arguments, stacks, URLs or property getters", () => {
		const getter = vi.fn(() => sensitive);
		const cycle: Record<string, unknown> = {};
		cycle.code = cycle;
		const objects = [
			cycle,
			{
				get message() {
					return getter();
				},
			},
			{ toString: getter },
		];
		for (const value of [
			sensitive,
			...objects,
			new Proxy(
				{},
				{
					getOwnPropertyDescriptor: () => {
						getter();
						throw new Error("private");
					},
				},
			),
		]) {
			expect(classifyWebviewDiagnostic("warn", "console", [value])).toEqual({
				level: "warn",
				source: "console",
				code: "redacted",
			});
		}
		expect(getter).toHaveBeenCalledTimes(1); // Only the proxy descriptor trap.
		expect(
			classifyWebviewDiagnostic("error", "console", [
				"[boundary:app]",
				new Error(`client_space_window_changed: ${sensitive}`),
			]),
		).toEqual({
			level: "error",
			source: "render_boundary",
			code: "client_space_window_changed",
		});
		expect(
			classifyWebviewDiagnostic("error", "console", [
				"[main] entry import failed",
				sensitive,
			]).source,
		).toBe("entry_import");
	});

	it("preserves console behavior and captures global errors and rejections with bounded batches", async () => {
		vi.useFakeTimers();
		const target = new EventTarget() as Window;
		const original = vi.fn();
		const consoleTarget = { warn: original, error: original };
		const persist = vi.fn().mockResolvedValue(undefined);
		const stop = installWebviewDiagnostics(target, consoleTarget, persist);
		consoleTarget.warn(sensitive, { token: "secret" });
		consoleTarget.error("client_space_window_changed");
		target.dispatchEvent(
			new ErrorEvent("error", {
				error: new Error(sensitive),
				filename: sensitive,
			}),
		);
		const rejection = new Event("unhandledrejection");
		Object.defineProperty(rejection, "reason", { value: sensitive });
		target.dispatchEvent(rejection);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(
			persist.mock.calls[0][0].map((e: { source: string }) => e.source),
		).toEqual(["console", "console", "window_error", "unhandled_rejection"]);
		expect(JSON.stringify(persist.mock.calls)).not.toContain("secret");
		expect(original.mock.calls[0]).toEqual([sensitive, { token: "secret" }]);
		stop();
		expect(consoleTarget.warn).toBe(original);
		target.dispatchEvent(new ErrorEvent("error"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("bounds storms, pending queues, and concurrent native requests", async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const persist = vi.fn(
			(_events: unknown[]) =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const consoleTarget = { warn: vi.fn(), error: vi.fn() };
		const stop = installWebviewDiagnostics(window, consoleTarget, persist);
		for (let i = 0; i < 10_000; i++) consoleTarget.warn(sensitive);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0]).toHaveLength(1);
		expect((persist.mock.calls[0] as unknown[][])[0]).toHaveLength(16);
		for (let i = 0; i < 10_000; i++) consoleTarget.warn(sensitive);
		finish();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(persist).toHaveBeenCalledTimes(2);
		stop();
		finish();
	});

	it("flushes a final bounded batch on page hide without duplicate in-flight sends", async () => {
		vi.useFakeTimers();
		const persist = vi.fn().mockResolvedValue(undefined);
		const consoleTarget = { warn: vi.fn(), error: vi.fn() };
		const stop = installWebviewDiagnostics(window, consoleTarget, persist);
		consoleTarget.error("[main] entry import failed");
		window.dispatchEvent(new Event("pagehide"));
		window.dispatchEvent(new Event("pagehide"));
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0][0][0].source).toBe("entry_import");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(persist).toHaveBeenCalledTimes(1);
		stop();
	});

	it("does not retry a failing or unsupported sink, including synchronous failures", async () => {
		vi.useFakeTimers();
		const persist = vi.fn(() => {
			throw new Error(sensitive);
		});
		const consoleTarget = { warn: vi.fn(), error: vi.fn() };
		const stop = installWebviewDiagnostics(window, consoleTarget, persist);
		consoleTarget.error(sensitive);
		await vi.advanceTimersByTimeAsync(1_000);
		for (let i = 0; i < 100; i++) consoleTarget.error(sensitive);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(persist).toHaveBeenCalledTimes(1);
		stop();
	});
});

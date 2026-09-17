// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	registerTerminalDocumentResizeSurface,
	terminalDocumentResizePhase,
} from "./terminalDocumentResizeTransaction";
import { bindTerminalNativeWindowResize } from "./terminalNativeWindowResize";

describe("terminal native window resize", () => {
	it("coalesces one native live-resize gesture into one final commit", async () => {
		let listener!: (phase: "begin" | "end") => void;
		const commit = vi.fn();
		const registration = registerTerminalDocumentResizeSurface(document, {
			surfaceKey: "session-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit,
		});
		const dispose = bindTerminalNativeWindowResize(
			document,
			"session-a",
			async (next) => {
				listener = next;
				return vi.fn<() => void>();
			},
		);
		await Promise.resolve();

		listener("begin");
		listener("begin");
		for (let index = 0; index < 3; index += 1) {
			expect(registration.noteGeometryChanged()).toBeUndefined();
		}
		expect(commit).not.toHaveBeenCalled();

		listener("end");
		await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(terminalDocumentResizePhase(document)).toBe("idle");
		listener("end");
		expect(commit).toHaveBeenCalledOnce();
		dispose();
		registration.dispose();
	});

	it("retires a late subscription and settles an active generation on dispose", async () => {
		let listener!: (phase: "begin" | "end") => void;
		let resolveSubscription!: (stop: () => void) => void;
		const stop = vi.fn<() => void>();
		const dispose = bindTerminalNativeWindowResize(
			document,
			"session-a",
			(next) => {
				listener = next;
				return new Promise((resolve) => {
					resolveSubscription = resolve;
				});
			},
		);
		listener("begin");
		expect(terminalDocumentResizePhase(document)).toBe("dragging");

		dispose();
		await vi.waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		resolveSubscription(stop);
		await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
	});

	it("settles a generation announced before native subscription failure", async () => {
		const dispose = bindTerminalNativeWindowResize(
			document,
			"session-a",
			async (listener) => {
				listener("begin");
				throw new Error("native installation failed");
			},
		);
		expect(terminalDocumentResizePhase(document)).toBe("dragging");

		await vi.waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		dispose();
	});
});

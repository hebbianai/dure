import { describe, expect, it } from "vitest";
import { classifyQaFatalConsoleMessage } from "./qaFatalConsoleClassifier";

describe("classifyQaFatalConsoleMessage", () => {
	it.each([
		[
			"webgl_context_exhausted",
			"There are too many active WebGL contexts on this page, the oldest context will be lost.",
		],
		["webgl_context_lost", "webgl context not restored; firing onContextLoss"],
		[
			"webgl_context_lost",
			"WebGL: INVALID_OPERATION: loseContext: context already lost",
		],
		[
			"tauri_callback_missing",
			"[TAURI] Couldn't find callback id 2314097496. This might happen after a reload.",
		],
		[
			"xterm_task_queue_deadline",
			"task queue exceeded allotted deadline by 74ms",
		],
	] as const)("classifies %s", (signature, message) => {
		expect(classifyQaFatalConsoleMessage([message])).toEqual({
			signature,
			message,
		});
	});

	it("leaves ordinary application diagnostics nonfatal", () => {
		expect(
			classifyQaFatalConsoleMessage(["expected diagnostic", 7]),
		).toBeUndefined();
		expect(
			classifyQaFatalConsoleMessage([
				"WebGL renderer initialized and context remains healthy",
			]),
		).toBeUndefined();
		expect(
			classifyQaFatalConsoleMessage(["task queue completed within deadline"]),
		).toBeUndefined();
	});

	it("retains an Error stack for structured evidence", () => {
		const error = new Error("task queue exceeded allotted deadline by 60ms");

		expect(classifyQaFatalConsoleMessage([error])).toEqual({
			signature: "xterm_task_queue_deadline",
			message: String(error),
			stack: error.stack,
		});
	});
});

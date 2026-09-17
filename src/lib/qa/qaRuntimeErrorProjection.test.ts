import { describe, expect, it } from "vitest";
import type { QaRuntimeErrorSnapshot } from "./qaRuntimeErrorLedger";
import {
	projectQaStatusRuntimeErrors,
	qaRuntimeErrorMessage,
} from "./qaRuntimeErrorProjection";

const empty: QaRuntimeErrorSnapshot = {
	cursor: { sequence: 3 },
	total: 0,
	dropped: 0,
	errors: [],
};

describe("QA runtime error projection", () => {
	it("preserves a complete run with zero uncaught errors", () => {
		expect(
			projectQaStatusRuntimeErrors(
				{ state: "complete", phase: "complete" },
				empty,
			),
		).toEqual({
			state: "complete",
			phase: "complete",
			runtimeErrors: empty,
		});
	});

	it("fails a complete run when WebKit reports a ResizeObserver loop", () => {
		const runtimeErrors: QaRuntimeErrorSnapshot = {
			cursor: { sequence: 4 },
			total: 1,
			dropped: 0,
			errors: [
				{
					sequence: 4,
					kind: "window_error",
					message:
						"ResizeObserver loop completed with undelivered notifications.",
				},
			],
		};
		const projected = projectQaStatusRuntimeErrors(
			{ state: "complete", phase: "complete" },
			runtimeErrors,
		);

		expect(projected).toEqual(
			expect.objectContaining({
				state: "failed",
				error:
					"uncaught window_error: ResizeObserver loop completed with undelivered notifications.",
				runtimeErrors,
			}),
		);
	});

	it("fails closed when the ring overflowed before details were retained", () => {
		const runtimeErrors = { ...empty, total: 2, dropped: 2 };
		expect(qaRuntimeErrorMessage(runtimeErrors)).toBe(
			"uncaught runtime errors were dropped before reporting",
		);
	});

	it("labels classified console failures without calling them uncaught", () => {
		expect(
			qaRuntimeErrorMessage({
				cursor: { sequence: 1 },
				total: 1,
				dropped: 0,
				errors: [
					{
						sequence: 1,
						kind: "fatal_console",
						message: "[webgl_context_lost] context lost",
					},
				],
			}),
		).toBe("fatal fatal_console: [webgl_context_lost] context lost");
	});
});

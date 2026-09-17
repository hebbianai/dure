import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	InputRefusalReason,
	InputRefusedSchema,
	ResizeFailedSchema,
	ResizeFailureReason,
	ResizeRefusalReason,
	ResizeRefusedSchema,
} from "@/contracts/terminalStateProtocol";
import {
	observeTerminalResizeGeometry,
	terminalIntentReceiptFailure,
	terminalResizeReceiptIsRetryable,
	terminalResizeRetryAfterFailure,
} from "./terminalIntentReceiptPolicy";

describe("terminal intent receipt policy", () => {
	it("formats stable enum names instead of numeric resize reasons", () => {
		const outcome = {
			case: "refused",
			value: create(ResizeRefusedSchema, {
				reason: ResizeRefusalReason.INVALID_TERMINAL_DIMENSIONS,
			}),
		} as const;

		expect(terminalIntentReceiptFailure("resize", outcome)?.message).toBe(
			"terminal resize refused: invalid_terminal_dimensions",
		);
	});

	it("surfaces the Host failure class behind a catch-all input refusal", () => {
		expect(
			terminalIntentReceiptFailure("input", {
				case: "refused",
				value: create(InputRefusedSchema, {
					reason: InputRefusalReason.RESOURCE_LIMIT,
					detail: "replay_engine_failure_neg1_encode_key",
				}),
			})?.message,
		).toBe(
			"terminal input refused: resource_limit (replay_engine_failure_neg1_encode_key)",
		);
		expect(
			terminalIntentReceiptFailure("input", {
				case: "refused",
				value: create(InputRefusedSchema, {
					reason: InputRefusalReason.HOST_EXITING,
				}),
			})?.message,
		).toBe("terminal input refused: host_exiting");
	});

	it("retries only typed resource pressure", () => {
		expect(
			terminalResizeReceiptIsRetryable({
				case: "refused",
				value: create(ResizeRefusedSchema, {
					reason: ResizeRefusalReason.RESOURCE_LIMIT,
				}),
			}),
		).toBe(true);
		expect(
			terminalResizeReceiptIsRetryable({
				case: "failed",
				value: create(ResizeFailedSchema, {
					reason: ResizeFailureReason.RESOURCE_LIMIT,
				}),
			}),
		).toBe(true);
		expect(
			terminalResizeReceiptIsRetryable({
				case: "refused",
				value: create(ResizeRefusedSchema, {
					reason: ResizeRefusalReason.INVALID_TERMINAL_DIMENSIONS,
				}),
			}),
		).toBe(false);
	});

	it("bounds retries for one unchanged measured geometry", () => {
		const geometry = { columns: 100, rows: 20 };
		const resourcePressure = {
			case: "refused",
			value: create(ResizeRefusedSchema, {
				reason: ResizeRefusalReason.RESOURCE_LIMIT,
			}),
		} as const;
		let state: ReturnType<typeof observeTerminalResizeGeometry> | undefined =
			observeTerminalResizeGeometry(undefined, geometry);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const result = terminalResizeRetryAfterFailure(
				state,
				geometry,
				resourcePressure,
			);
			expect(result.retry).toBe(true);
			state = result.state;
		}
		const exhausted = terminalResizeRetryAfterFailure(
			state,
			geometry,
			resourcePressure,
		);
		expect(exhausted).toEqual({ state: undefined, retry: false });
	});
});

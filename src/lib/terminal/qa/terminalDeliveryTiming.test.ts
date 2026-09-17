import { describe, expect, it, vi } from "vitest";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { decodeTerminalStateRecord } from "../protocol/terminalStateProtocol";
import type { StructuredTerminalCarrierRecord } from "../structuredTerminalRecord";
import {
	projectTerminalDeliveryTiming,
	readTimedTerminalRecord,
} from "./terminalDeliveryTiming";

const encoded = viewportFrameRecord();
const frame: StructuredTerminalCarrierRecord = {
	kind: "terminal",
	decoded: decodeTerminalStateRecord(encoded),
	encodedByteLength: encoded.byteLength,
};

describe("sampled terminal delivery timing", () => {
	it("separates callback continuation waits, multipart gaps, decode work, and replica work", async () => {
		let clock = 0;
		let part = 0;
		const result = await readTimedTerminalRecord({
			pull: async (resolved) => {
				part += 1;
				clock = part === 1 ? 100 : 200;
				resolved();
				// Work queued after carrier resolution, before the await continuation.
				clock = part === 1 ? 130 : 220;
				return encoded.buffer as ArrayBuffer;
			},
			decode: () => {
				clock += part === 1 ? 7 : 11;
				return part === 2 ? frame : undefined;
			},
			sampleSequence: () => 3,
			now: () => clock,
		});
		expect(result.kind).toBe("terminal");
		if (result.kind !== "terminal" || !result.deliveryTiming)
			throw new Error("missing timing");
		expect(
			projectTerminalDeliveryTiming(
				{
					...result.deliveryTiming,
					replicaApplyStartedAt: 240,
					replicaAppliedAt: 253,
				},
				3,
				50,
			),
		).toEqual({
			carrierFirstResolvedMs: 50,
			carrierLastResolvedMs: 150,
			carrierDecodeStartedMs: 170,
			carrierDecodedMs: 181,
			carrierDecodeWorkMs: 18,
			carrierPartCount: 2,
			carrierBytes: encoded.byteLength * 2,
			replicaApplyStartedMs: 190,
			replicaAppliedMs: 203,
		});
		expect(
			projectTerminalDeliveryTiming(
				{
					...result.deliveryTiming,
					replicaApplyStartedAt: 240,
					replicaAppliedAt: 253,
				},
				4,
				50,
			),
		).toBeUndefined();
	});

	it("does not read a clock or decorate unsampled records", async () => {
		const now = vi.fn(() => 1);
		const result = await readTimedTerminalRecord({
			pull: async (resolved) => {
				resolved();
				return encoded.buffer as ArrayBuffer;
			},
			decode: () => frame,
			sampleSequence: () => undefined,
			now,
		});
		expect(result).toBe(frame);
		expect(now).not.toHaveBeenCalled();
	});

	it.each([
		[undefined, 3],
		[2, 3],
		[3, undefined],
	])(
		"omits a multipart span that changes sampling from %s to %s",
		async (first, last) => {
			let part = 0;
			const result = await readTimedTerminalRecord({
				pull: async (resolved) => {
					part += 1;
					resolved();
					return encoded.buffer as ArrayBuffer;
				},
				decode: () => (part === 2 ? frame : undefined),
				sampleSequence: () => (part === 1 ? first : last),
				now: () => part,
			});
			expect(result).toBe(frame);
		},
	);

	it("preserves pull failures without a retry or a diagnostic record", async () => {
		const cause = new Error("attachment retired");
		const pull = vi.fn(async () => {
			throw cause;
		});
		const decode = vi.fn();
		await expect(
			readTimedTerminalRecord({
				pull,
				decode,
				sampleSequence: () => 3,
				now: () => 0,
			}),
		).rejects.toBe(cause);
		expect(pull).toHaveBeenCalledOnce();
		expect(decode).not.toHaveBeenCalled();
	});
});

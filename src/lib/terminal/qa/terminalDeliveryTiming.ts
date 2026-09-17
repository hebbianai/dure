import type { StructuredTerminalCarrierRecord } from "../structuredTerminalRecord";
import type {
	TerminalDeliveryTiming,
	TerminalReplicaTiming,
} from "../terminalDeliveryTimingFacts";

/** Decorates the existing pull only in a perf build. No raw payload is retained
 * after decoding; an incomplete or differently sampled multipart span is omitted. */
export async function readTimedTerminalRecord(options: {
	pull(onResolved: () => void): Promise<ArrayBuffer>;
	decode(raw: ArrayBuffer): StructuredTerminalCarrierRecord | undefined;
	sampleSequence(): number | undefined;
	now(): number;
}): Promise<StructuredTerminalCarrierRecord> {
	let span: TerminalDeliveryTiming | undefined;
	let complete = true;
	for (;;) {
		let sequence: number | undefined;
		let resolvedAt: number | undefined;
		const raw = await options.pull(() => {
			sequence = options.sampleSequence();
			if (sequence !== undefined) resolvedAt = options.now();
		});
		const sampledSequence = sequence;
		const carrierResolvedAt = resolvedAt;
		const measuring =
			complete &&
			sampledSequence !== undefined &&
			carrierResolvedAt !== undefined &&
			(span === undefined || span.sampleSequence === sampledSequence);
		const decodeStartedAt = measuring ? options.now() : 0;
		const decoded = options.decode(raw);
		if (measuring) {
			const decodedAt = options.now();
			span = {
				sampleSequence: sampledSequence,
				firstCarrierResolvedAt:
					span?.firstCarrierResolvedAt ?? carrierResolvedAt,
				lastCarrierResolvedAt: carrierResolvedAt,
				decodeStartedAt,
				decodedAt,
				decodeWorkMs: (span?.decodeWorkMs ?? 0) + decodedAt - decodeStartedAt,
				partCount: (span?.partCount ?? 0) + 1,
				encodedBytes: (span?.encodedBytes ?? 0) + raw.byteLength,
			};
		} else {
			complete = false;
		}
		if (decoded) {
			return complete && span && decoded.kind === "terminal"
				? { ...decoded, deliveryTiming: span }
				: decoded;
		}
	}
}

/** Called only after the existing exact input/attachment/epoch join succeeds. */
export function projectTerminalDeliveryTiming(
	timing: TerminalReplicaTiming,
	sequence: number,
	startedAt: number,
) {
	if (timing.sampleSequence !== sequence) return undefined;
	return {
		carrierFirstResolvedMs: timing.firstCarrierResolvedAt - startedAt,
		carrierLastResolvedMs: timing.lastCarrierResolvedAt - startedAt,
		carrierDecodeStartedMs: timing.decodeStartedAt - startedAt,
		carrierDecodedMs: timing.decodedAt - startedAt,
		carrierDecodeWorkMs: timing.decodeWorkMs,
		carrierPartCount: timing.partCount,
		carrierBytes: timing.encodedBytes,
		replicaApplyStartedMs: timing.replicaApplyStartedAt - startedAt,
		replicaAppliedMs: timing.replicaAppliedAt - startedAt,
	};
}

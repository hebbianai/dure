/** WebView-clock observations, not native receipt timestamps. */
export interface TerminalDeliveryTiming {
	readonly sampleSequence: number;
	readonly firstCarrierResolvedAt: number;
	readonly lastCarrierResolvedAt: number;
	readonly decodeStartedAt: number;
	readonly decodedAt: number;
	readonly decodeWorkMs: number;
	readonly partCount: number;
	readonly encodedBytes: number;
}

export interface TerminalReplicaTiming extends TerminalDeliveryTiming {
	readonly replicaApplyStartedAt: number;
	readonly replicaAppliedAt: number;
}

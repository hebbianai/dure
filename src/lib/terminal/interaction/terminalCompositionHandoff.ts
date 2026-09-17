export interface TerminalCompositionHandoffFence {
	readonly attachmentToken: string;
	readonly baselineProjectionRevision: bigint;
	readonly baselineThroughOutputSeq: bigint;
	readonly inputBaselineOutputSequence?: bigint;
	readonly writtenToPty: boolean;
}

export interface TerminalCompositionPaintFence {
	readonly attachmentToken: string;
	readonly projectionRevision: bigint;
	readonly throughOutputSeq: bigint;
}

/** The browser owns the active composition. A prior committed syllable is
 * never part of the next native preedit value. */
export function terminalActiveCompositionText(
	compositionData: string,
	inputValue: string,
): string {
	return compositionData || inputValue;
}

export function terminalCompositionProjectionText(
	handoffs: readonly { readonly text: string }[],
	activeText: string,
): string {
	return handoffs.map((handoff) => handoff.text).join("") + activeText;
}

/** A committed local handoff retires only when the exact Host write has been
 * acknowledged and a canonical successor projection has actually painted. */
export function terminalCompositionHandoffCanRetire(
	handoff: TerminalCompositionHandoffFence,
	paint: TerminalCompositionPaintFence | null,
): boolean {
	return Boolean(
		handoff.writtenToPty &&
			paint &&
			paint.attachmentToken === handoff.attachmentToken &&
			paint.projectionRevision > handoff.baselineProjectionRevision &&
			paint.throughOutputSeq >
				(handoff.inputBaselineOutputSequence ??
					handoff.baselineThroughOutputSeq),
	);
}

/** Retire the ready prefix in order. Exact Host write baselines allow multiple
 * commits to share one coalesced output step; older Hosts conservatively
 * consume one distinct step per commit. */
export function retirePaintedTerminalCompositionHandoffs<
	Handoff extends TerminalCompositionHandoffFence,
>(
	handoffs: readonly Handoff[],
	paint: TerminalCompositionPaintFence | null,
): readonly Handoff[] {
	let retiredCount = 0;
	let consumedThroughOutputSeq: bigint | null = null;
	while (
		retiredCount < handoffs.length &&
		terminalCompositionHandoffCanRetire(handoffs[retiredCount], paint)
	) {
		const handoff = handoffs[retiredCount];
		if (!handoff || !paint) break;
		if (handoff.inputBaselineOutputSequence !== undefined) {
			const successor = handoff.inputBaselineOutputSequence + 1n;
			consumedThroughOutputSeq =
				consumedThroughOutputSeq === null ||
				successor > consumedThroughOutputSeq
					? successor
					: consumedThroughOutputSeq;
			retiredCount += 1;
			continue;
		}
		const predecessor: bigint =
			consumedThroughOutputSeq !== null &&
			consumedThroughOutputSeq > handoff.baselineThroughOutputSeq
				? consumedThroughOutputSeq
				: handoff.baselineThroughOutputSeq;
		const successor: bigint = predecessor + 1n;
		if (successor > paint.throughOutputSeq) break;
		consumedThroughOutputSeq = successor;
		retiredCount += 1;
	}
	if (retiredCount === 0) return handoffs;
	const remaining = handoffs.slice(retiredCount);
	if (!paint) return remaining;
	return remaining.map((handoff) =>
		handoff.attachmentToken === paint.attachmentToken
			? {
					...handoff,
					baselineThroughOutputSeq:
						paint.throughOutputSeq > handoff.baselineThroughOutputSeq
							? paint.throughOutputSeq
							: handoff.baselineThroughOutputSeq,
				}
			: handoff,
	);
}

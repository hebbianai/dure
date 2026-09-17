/** Converts exact complete-projection counts into the bounded native QA schema. */
export function exactProjectionMarkerEvidence(
	counts: Readonly<Record<string, number>>,
): Record<string, boolean> {
	return Object.fromEntries(
		Object.entries(counts).flatMap(([marker, count]) =>
			count === 1 ? [[marker, true]] : [],
		),
	);
}

export interface LatencyStats {
	count: number;
	median: number | null;
	p95: number | null;
	max: number | null;
}

export function summarizeLatencyStats(
	values: readonly number[],
): LatencyStats {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: sorted.length,
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted.length ? sorted[sorted.length - 1] : null,
	};
}

function percentile(
	sorted: readonly number[],
	percentage: number,
): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((percentage / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface UsageTokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface NormalizedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	activityTotal: number;
	processedTotal: number;
}

export type CacheAccounting = "disjoint" | "input-subset";

function tokenCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 로그의 서로 다른 토큰 의미를 겹치지 않는 구성으로 바꾼다.
 *
 * input-subset 형식은 input_tokens가 cached_input_tokens를 이미 포함하고,
 * disjoint 형식은 캐시 필드가 input_tokens와 별도다.
 */
export function normalizeTokenUsage(
	usage: UsageTokenCounts,
	cacheAccounting: CacheAccounting,
): NormalizedUsage {
	const rawInput = tokenCount(usage.input);
	const output = tokenCount(usage.output);
	const cacheWrite = tokenCount(usage.cacheWrite);

	if (cacheAccounting === "input-subset") {
		const cacheRead = Math.min(rawInput, tokenCount(usage.cacheRead));
		const input = rawInput - cacheRead;
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			activityTotal: input + output,
			processedTotal: input + output + cacheRead + cacheWrite,
		};
	}

	const cacheRead = tokenCount(usage.cacheRead);
	return {
		input: rawInput,
		output,
		cacheRead,
		cacheWrite,
		activityTotal: rawInput + output + cacheRead + cacheWrite,
		processedTotal: rawInput + output + cacheRead + cacheWrite,
	};
}

export function summarizeUsage(usages: NormalizedUsage[]): NormalizedUsage {
	return usages.reduce<NormalizedUsage>(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			activityTotal: total.activityTotal + usage.activityTotal,
			processedTotal: total.processedTotal + usage.processedTotal,
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			activityTotal: 0,
			processedTotal: 0,
		},
	);
}

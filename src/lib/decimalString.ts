/** Compare canonical unsigned decimal strings without losing u64 precision. */
export function compareCanonicalDecimalStrings(
	left: string,
	right: string,
): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left === right ? 0 : left < right ? -1 : 1;
}

/** 선행 0을 정규화한 뒤 비교 — canonical 보장이 없는 임의 id/seq용.
 *  (구 decimalStrings.ts를 흡수 — 루트 flat 중복 파일 정리, 2026-08-03) */
export function compareDecimalStrings(left: string, right: string): number {
	return compareCanonicalDecimalStrings(
		left.replace(/^0+/, "") || "0",
		right.replace(/^0+/, "") || "0",
	);
}

export function isCanonicalDecimalString(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

/** Return whether value is exactly previous + 1 without narrowing to a JS number. */
export function isImmediateCanonicalDecimalSuccessor(
	value: unknown,
	previous: unknown,
): boolean {
	if (
		!isCanonicalDecimalString(value) ||
		!isCanonicalDecimalString(previous)
	) {
		return false;
	}
	const digits = previous.split("");
	let carry = 1;
	for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
		const next = Number(digits[index]) + carry;
		digits[index] = String(next % 10);
		carry = next === 10 ? 1 : 0;
	}
	if (carry === 1) digits.unshift("1");
	return value === digits.join("");
}

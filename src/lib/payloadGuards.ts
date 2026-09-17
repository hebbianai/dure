/**
 * Minimal unknown-payload guards shared by boundary validators (IPC receipts,
 * persisted JSON, plugin manifests).
 *
 * Before this module, ~30 lib files each redefined these predicates; keep
 * domain-specific shapes (bounded byte lengths, id regexes, u64 decimals)
 * local to their validator — only the domain-free primitives live here.
 */

/** The value as a plain object record, or undefined (arrays and null fail). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Subset check: every observed key is allowed (missing keys are fine). */
export function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

export function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Epoch-ms style integer: zero allowed, negatives refused. */
export function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

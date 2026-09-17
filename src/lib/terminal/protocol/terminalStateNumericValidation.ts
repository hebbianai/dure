import { TerminalStateProtocolError } from "./terminalStateLimits";

const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export function validateUint32(value: unknown, message: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > UINT32_MAX
	) {
		fail(message);
	}
	return value;
}

export function validateInt32(value: unknown, message: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < -0x8000_0000 ||
		value > 0x7fff_ffff
	) {
		fail(message);
	}
	return value;
}

export function validateUint64(value: unknown, message: string): bigint {
	if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
		fail(message);
	}
	return value;
}

export function validateEnumNumber<T extends number>(
	value: unknown,
	allowed: readonly T[],
	message: string,
): T {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		!allowed.includes(value as T)
	) {
		fail(message);
	}
	return value as T;
}

function fail(message: string): never {
	throw new TerminalStateProtocolError("invalid_record", message);
}

import { asRecord } from "@/lib/payloadGuards";

export interface HmuxManagedGenerationV1 {
	runnerPrincipal: string;
	runnerInstance: string;
	channelEpoch: string;
	hostInstanceId: string;
	terminalEpoch: string;
}

const MAX_U64 = 18_446_744_073_709_551_615n;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9._:+-]{1,256}$/;
const generationFields = {
	runnerPrincipal: true,
	runnerInstance: true,
	channelEpoch: true,
	hostInstanceId: true,
	terminalEpoch: true,
} as const satisfies Record<keyof HmuxManagedGenerationV1, true>;

export const HMUX_MANAGED_GENERATION_FIELDS = Object.freeze(
	Object.keys(generationFields),
) as readonly (keyof HmuxManagedGenerationV1)[];

export interface ExactHmuxManagedSessionV1<ProviderId extends string = string>
	extends HmuxManagedGenerationV1 {
	sessionId: string;
	workspaceId: string;
	providerId: ProviderId;
}

function decimalU64(value: unknown, nonZero = false): value is string {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		return false;
	}
	return (!nonZero || value !== "0") && BigInt(value) <= MAX_U64;
}

function safeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && SAFE_OPAQUE_ID.test(value);
}

export function parseHmuxManagedGenerationV1(
	value: unknown,
): HmuxManagedGenerationV1 | undefined {
	const candidate = asRecord(value);
	if (
		!candidate ||
		!safeOpaqueId(candidate.runnerPrincipal) ||
		!safeOpaqueId(candidate.runnerInstance) ||
		!decimalU64(candidate.channelEpoch, true) ||
		!safeOpaqueId(candidate.hostInstanceId) ||
		!safeOpaqueId(candidate.terminalEpoch)
	) {
		return undefined;
	}
	return {
		runnerPrincipal: candidate.runnerPrincipal,
		runnerInstance: candidate.runnerInstance,
		channelEpoch: candidate.channelEpoch,
		hostInstanceId: candidate.hostInstanceId,
		terminalEpoch: candidate.terminalEpoch,
	};
}

export function isHmuxManagedGenerationV1(
	value: unknown,
): value is HmuxManagedGenerationV1 {
	return parseHmuxManagedGenerationV1(value) !== undefined;
}

export function hmuxManagedGeneration(
	value: HmuxManagedGenerationV1,
): HmuxManagedGenerationV1 {
	return {
		runnerPrincipal: value.runnerPrincipal,
		runnerInstance: value.runnerInstance,
		channelEpoch: value.channelEpoch,
		hostInstanceId: value.hostInstanceId,
		terminalEpoch: value.terminalEpoch,
	};
}

export function sameHmuxManagedGeneration(
	left: HmuxManagedGenerationV1 | undefined,
	right: HmuxManagedGenerationV1 | undefined,
): boolean {
	if (!left || !right) return left === right;
	return HMUX_MANAGED_GENERATION_FIELDS.every(
		(field) => left[field] === right[field],
	);
}

export function sameExactHmuxManagedSession(
	left: ExactHmuxManagedSessionV1 | undefined,
	right: ExactHmuxManagedSessionV1 | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.providerId === right.providerId &&
		sameHmuxManagedGeneration(left, right)
	);
}

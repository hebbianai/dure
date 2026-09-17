import { parseHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { parseManagedCreateAdvanceResolution } from "@/lib/hmux/managed/managedCreateResolution";
import { asRecord, nonEmptyString } from "@/lib/payloadGuards";
import type {
	HmuxExactManagedCreateReceipt,
	HmuxManagedCreateAdvanceResolution,
} from "./hmuxContracts";

const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

function decimalU64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		DECIMAL_U64.test(value) &&
		BigInt(value) <= MAX_U64
	);
}

function parseManagedCreateReceipt(
	value: unknown,
	expected: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
		credentialId?: string;
		credentialGeneration?: number;
	},
	state: "current" | "advanced",
): HmuxExactManagedCreateReceipt | undefined {
	const receipt = asRecord(value);
	const sourceIdentity =
		receipt?.idempotencyKey === expected.idempotencyKey &&
		asRecord(receipt?.session)?.sessionId === expected.sessionId;
	const successorIdentity =
		receipt?.idempotencyKey !== expected.idempotencyKey &&
		asRecord(receipt?.session)?.sessionId !== expected.sessionId;
	if (
		!receipt ||
		!nonEmptyString(receipt.idempotencyKey) ||
		(state === "advanced" ? !successorIdentity : !sourceIdentity) ||
		(receipt.outcome !== "created" && receipt.outcome !== "reused") ||
		(receipt.credentialId !== undefined &&
			!nonEmptyString(receipt.credentialId)) ||
		(receipt.credentialGeneration !== undefined &&
			(!Number.isSafeInteger(receipt.credentialGeneration) ||
				Number(receipt.credentialGeneration) < 0)) ||
		receipt.credentialId !== expected.credentialId ||
		receipt.credentialGeneration !== expected.credentialGeneration ||
		(receipt.initialPromptAccepted !== undefined &&
			typeof receipt.initialPromptAccepted !== "boolean")
	) {
		return undefined;
	}
	const session = parseManagedCreateSession(receipt.session);
	if (
		!session ||
		(state === "advanced"
			? session.sessionId === expected.sessionId
			: session.sessionId !== expected.sessionId) ||
		session.workspaceId !== expected.workspaceId ||
		session.sessionClass !== "managed" ||
		!session.stopFence ||
		session.stopFence.terminalEpoch !== session.terminalEpoch ||
		session.lifecycle !== "ready"
	) {
		return undefined;
	}
	return {
		session: {
			...session,
			sessionClass: "managed",
			stopFence: session.stopFence,
		},
		idempotencyKey: receipt.idempotencyKey,
		...(nonEmptyString(receipt.cwd) ? { cwd: receipt.cwd } : {}),
		outcome: receipt.outcome,
		...(receipt.initialPromptAccepted === true
			? { initialPromptAccepted: true }
			: {}),
		...(receipt.credentialId ? { credentialId: receipt.credentialId } : {}),
		...(receipt.credentialGeneration !== undefined
			? { credentialGeneration: receipt.credentialGeneration as number }
			: {}),
	};
}

/** Create admission needs only the exact managed generation. Presentation
 * metadata is additive and is deliberately normalized away here. */
function parseManagedCreateSession(
	value: unknown,
): HmuxExactManagedCreateReceipt["session"] | undefined {
	const session = asRecord(value);
	if (
		!session ||
		!nonEmptyString(session.sessionId) ||
		!nonEmptyString(session.workspaceId) ||
		session.sessionClass !== "managed" ||
		session.lifecycle !== "ready" ||
		!nonEmptyString(session.terminalEpoch)
	) {
		return undefined;
	}
	const stopFence = parseHmuxManagedGenerationV1(session.stopFence);
	if (!stopFence || stopFence.terminalEpoch !== session.terminalEpoch) {
		return undefined;
	}
	const capabilities = Array.isArray(session.capabilities)
		? session.capabilities.filter(nonEmptyString)
		: [];
	return {
		sessionId: session.sessionId,
		workspaceId: session.workspaceId,
		sessionClass: "managed",
		lifecycle: "ready",
		terminalEpoch: session.terminalEpoch,
		stopFence,
		outputSeq: decimalU64(session.outputSeq) ? session.outputSeq : "0",
		capabilities,
	};
}

export function parseHmuxManagedCreateAdvanceResolutionV1(
	value: unknown,
	expected: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
		credentialId?: string;
		credentialGeneration?: number;
	},
): HmuxManagedCreateAdvanceResolution | undefined {
	return parseManagedCreateAdvanceResolution(value, (candidate, state) =>
		parseManagedCreateReceipt(candidate, expected, state),
	);
}

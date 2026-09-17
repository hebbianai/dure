import {
	InputFailureReasonSchema,
	type InputReceipt,
	InputRefusalReasonSchema,
	ResizeFailureReason,
	ResizeFailureReasonSchema,
	type ResizeReceipt,
	ResizeRefusalReason,
	ResizeRefusalReasonSchema,
	WheelFailureReasonSchema,
	type WheelReceipt,
	WheelRefusalReasonSchema,
} from "@/contracts/terminalStateProtocol";
import type { TerminalIntentReceiptKind } from "./terminalIntentReceiptSequence";

type TerminalIntentReceiptOutcome =
	| InputReceipt["outcome"]
	| ResizeReceipt["outcome"]
	| WheelReceipt["outcome"];

const reasonSchemas = {
	input: {
		refused: InputRefusalReasonSchema,
		failed: InputFailureReasonSchema,
	},
	resize: {
		refused: ResizeRefusalReasonSchema,
		failed: ResizeFailureReasonSchema,
	},
	wheel: {
		refused: WheelRefusalReasonSchema,
		failed: WheelFailureReasonSchema,
	},
} as const;

function receiptReasonName(
	kind: TerminalIntentReceiptKind,
	outcomeCase: "refused" | "failed",
	reason: number,
): string {
	return (
		reasonSchemas[kind][outcomeCase].values
			.find((value) => value.number === reason)
			?.localName.toLowerCase() ?? `unknown_${reason}`
	);
}

export function terminalIntentReceiptFailure(
	kind: TerminalIntentReceiptKind,
	outcome: TerminalIntentReceiptOutcome,
): Error | undefined {
	if (
		outcome.case === "writtenToPty" ||
		outcome.case === "appliedToTerminal" ||
		outcome.case === "appliedToViewport"
	) {
		return undefined;
	}
	if (outcome.case === "refused" || outcome.case === "failed") {
		const reason = receiptReasonName(kind, outcome.case, outcome.value.reason);
		// A catch-all reason names nothing; the Host's bounded failure-class
		// token is the actual cause and must reach the operator verbatim.
		const detail =
			"detail" in outcome.value && outcome.value.detail
				? ` (${outcome.value.detail})`
				: "";
		return new Error(`terminal ${kind} ${outcome.case}: ${reason}${detail}`);
	}
	return new Error(`terminal ${kind} failed: unknown`);
}

const MAX_TRANSIENT_RESIZE_RETRIES = 3;

export interface TerminalResizeGeometry {
	readonly columns: number;
	readonly rows: number;
}

export interface TerminalResizeRetryState extends TerminalResizeGeometry {
	readonly attempts: number;
}

export function observeTerminalResizeGeometry(
	current: TerminalResizeRetryState | undefined,
	geometry: TerminalResizeGeometry,
): TerminalResizeRetryState {
	if (current?.columns === geometry.columns && current.rows === geometry.rows) {
		return current;
	}
	return { ...geometry, attempts: 0 };
}

export function terminalResizeReceiptIsRetryable(
	outcome: ResizeReceipt["outcome"],
): boolean {
	return (
		(outcome.case === "refused" &&
			outcome.value.reason === ResizeRefusalReason.RESOURCE_LIMIT) ||
		(outcome.case === "failed" &&
			outcome.value.reason === ResizeFailureReason.RESOURCE_LIMIT)
	);
}

export function terminalResizeRetryAfterFailure(
	current: TerminalResizeRetryState | undefined,
	geometry: TerminalResizeGeometry,
	outcome: ResizeReceipt["outcome"],
): {
	readonly state: TerminalResizeRetryState | undefined;
	readonly retry: boolean;
} {
	if (
		!terminalResizeReceiptIsRetryable(outcome) ||
		!current ||
		current.columns !== geometry.columns ||
		current.rows !== geometry.rows ||
		current.attempts >= MAX_TRANSIENT_RESIZE_RETRIES
	) {
		return { state: undefined, retry: false };
	}
	return {
		state: { ...current, attempts: current.attempts + 1 },
		retry: true,
	};
}

import {
	computePromptIdentity,
	type PromptIdentity,
} from "@/lib/agents/promptIdentity";
import type {
	SpawnPromptDeliveryFailureState,
	SpawnReceipt,
	SpawnReceiptStep,
	SpawnReceiptStepError,
} from "@/lib/ipc";
import type { HmuxInitialAgentPromptReceipt } from "@/lib/ipc/hmuxContracts";
import { SagaStepError } from "@/lib/sessions/launch/spawnSagaRequest";

export { computePromptIdentity, type PromptIdentity };

const LEGACY_PROMPT_DELIVERY_CONTRACT = "journal_first_v1" as const;
export const PROMPT_DELIVERY_CONTRACT = "host_atomic_v1" as const;
export const LAUNCH_PROMPT_DELIVERY_CONTRACT = "provider_launch_v1" as const;

type PromptDeliveryManualCode =
	| "prompt_request_identity_invalid"
	| "prompt_hint_unexpected"
	| "prompt_hint_missing"
	| "prompt_hint_mismatch"
	| "prompt_delivery_identity_mismatch"
	| "prompt_delivery_receipt_invalid"
	| "prompt_delivery_unverified";

type PromptDeliveryManualDecision = {
	action: "manual";
	code: string;
	message: string;
	deliveryState?: SpawnPromptDeliveryFailureState;
};

export type PromptDeliveryDecision =
	| { action: "skip" }
	| { action: "send"; intent: PromptIdentity }
	| { action: "complete" }
	| PromptDeliveryManualDecision;

export class PromptDeliveryManualError extends SagaStepError {
	constructor(
		code: string,
		message: string,
		readonly deliveryState?: SpawnPromptDeliveryFailureState,
	) {
		super("prompt_delivery", code, message);
		this.name = "PromptDeliveryManualError";
	}
}

type PromptDeliveryWriteOutcome =
	| { state: "written"; receipt: HmuxInitialAgentPromptReceipt }
	| {
			state: "failed";
			error: SpawnReceiptStepError & {
				deliveryState: SpawnPromptDeliveryFailureState;
			};
	  };

export type PromptDeliveryWrite = (
	prompt: string,
) => Promise<PromptDeliveryWriteOutcome>;

export interface PromptDeliveryJournalTools {
	prior: SpawnReceipt;
	step: <T>(
		name: string,
		run: () => Promise<{ detail?: unknown; value: T }>,
		startedDetail?: unknown,
	) => Promise<T | undefined>;
	skip: (name: string) => Promise<unknown>;
}

interface PromptDeliveryDecisionInput {
	durableRequest: Record<string, unknown> | null;
	promptStep?: SpawnReceiptStep;
	livePrompt?: PromptIdentity;
}

type IdentityProjection =
	| { state: "absent" }
	| { state: "invalid" }
	| { state: "valid"; value: PromptIdentity };

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function projectIdentity(
	promptDigest: unknown,
	promptLen: unknown,
): IdentityProjection {
	if (promptDigest === undefined && promptLen === undefined) {
		return { state: "absent" };
	}
	if (
		typeof promptDigest !== "string" ||
		!SHA256.test(promptDigest) ||
		!Number.isSafeInteger(promptLen) ||
		Number(promptLen) <= 0
	) {
		return { state: "invalid" };
	}
	return {
		state: "valid",
		value: { promptDigest, promptLen: Number(promptLen) },
	};
}

function sameIdentity(left: PromptIdentity, right: PromptIdentity): boolean {
	return (
		left.promptDigest === right.promptDigest &&
		left.promptLen === right.promptLen
	);
}

function manual(
	code: PromptDeliveryManualCode,
	message: string,
	deliveryState?: SpawnPromptDeliveryFailureState,
): PromptDeliveryManualDecision {
	return {
		action: "manual",
		code,
		message,
		...(deliveryState ? { deliveryState } : {}),
	};
}

function priorPromptFailure(
	step: SpawnReceiptStep | undefined,
): PromptDeliveryManualDecision | undefined {
	const deliveryState = promptFailureState(step);
	if (!step?.error || !deliveryState) return undefined;
	return {
		action: "manual",
		code: step.error.code,
		message: step.error.message,
		deliveryState,
	};
}

function deliveryContract(step: SpawnReceiptStep | undefined): unknown {
	if (!step?.detail || typeof step.detail !== "object") return undefined;
	return (step.detail as Record<string, unknown>).deliveryContract;
}

function promptFailureState(
	step: SpawnReceiptStep | undefined,
): SpawnPromptDeliveryFailureState | undefined {
	const error = step?.error;
	if (!error) return undefined;
	if (
		error.deliveryState === "not_written" ||
		error.deliveryState === "unknown"
	) {
		return error.deliveryState;
	}
	if (error.deliveryState !== undefined) return "unknown";
	if (error.code === "prompt_delivery_not_written") return "not_written";
	if (error.code === "prompt_delivery_unverified") return "unknown";
	return deliveryContract(step) === PROMPT_DELIVERY_CONTRACT
		? "unknown"
		: undefined;
}

function isRetryablePromptAttempt(step: SpawnReceiptStep): boolean {
	const contract = deliveryContract(step);
	if (contract === LEGACY_PROMPT_DELIVERY_CONTRACT) {
		return step.status === "running" || step.status === "failed";
	}
	return (
		(contract === PROMPT_DELIVERY_CONTRACT &&
			(step.status === "running" ||
				(step.status === "failed" &&
					promptFailureState(step) === "not_written"))) ||
		(contract === LAUNCH_PROMPT_DELIVERY_CONTRACT &&
			step.status === "running")
	);
}

/**
 * Pure resume decision over durable receipt truth and an optional live prompt
 * identity. The live value can validate the journal but never replace it; the
 * Host, not this projection, enforces one-shot delivery.
 */
export function decidePromptDelivery({
	durableRequest,
	promptStep,
	livePrompt,
}: PromptDeliveryDecisionInput): PromptDeliveryDecision {
	const durable = projectIdentity(
		durableRequest?.promptDigest,
		durableRequest?.promptLen,
	);
	if (durable.state === "invalid") {
		return manual(
			"prompt_request_identity_invalid",
			"The durable prompt identity is malformed.",
		);
	}
	if (durable.state === "absent") {
		if (livePrompt) {
			return manual(
				"prompt_hint_unexpected",
				"A live prompt cannot add content to a receipt that has no durable prompt identity.",
			);
		}
		if (promptStep?.delivery) {
			return manual(
				"prompt_delivery_receipt_invalid",
				"Prompt delivery state exists without a durable prompt identity.",
			);
		}
		return { action: "skip" };
	}

	const priorFailure = priorPromptFailure(promptStep);
	if (priorFailure?.deliveryState === "unknown") return priorFailure;

	if (livePrompt) {
		const projectedLive = projectIdentity(
			livePrompt.promptDigest,
			livePrompt.promptLen,
		);
		if (
			projectedLive.state !== "valid" ||
			!sameIdentity(durable.value, projectedLive.value)
		) {
			if (priorFailure) return priorFailure;
			return manual(
				"prompt_hint_mismatch",
				"The live prompt does not match the durable request.",
			);
		}
	}
	if (!livePrompt && priorFailure) return priorFailure;

	const delivery = promptStep?.delivery;
	if (delivery) {
		const deliveryIdentity = projectIdentity(
			delivery.promptDigest,
			delivery.promptLen,
		);
		if (
			deliveryIdentity.state !== "valid" ||
			!sameIdentity(durable.value, deliveryIdentity.value)
		) {
			return manual(
				"prompt_delivery_identity_mismatch",
				"The durable delivery intent does not match the durable request.",
			);
		}
		if (delivery.state === "written_to_pty") {
			return { action: "complete" };
		}
		if (
			delivery.state === "intent_durable" ||
			delivery.state === "unverified"
		) {
			return manual(
				"prompt_delivery_unverified",
				"Prompt input may have crossed the PTY boundary; automatic replay is refused.",
				"unknown",
			);
		}
		return manual(
			"prompt_delivery_receipt_invalid",
			"The durable prompt delivery state is unknown.",
		);
	}
	if (
		!livePrompt &&
		promptStep?.status === "running" &&
		deliveryContract(promptStep) === PROMPT_DELIVERY_CONTRACT
	) {
		return manual(
			"prompt_delivery_unverified",
			"A Host prompt attempt was interrupted before its receipt became durable.",
			"unknown",
		);
	}

	if (promptStep?.status === "ok") return { action: "complete" };
	if (
		promptStep &&
		promptStep.status !== "pending" &&
		!isRetryablePromptAttempt(promptStep)
	) {
		return manual(
			"prompt_delivery_unverified",
			"A legacy prompt attempt has no durable boundary evidence; automatic replay is refused.",
			"unknown",
		);
	}
	if (!livePrompt) {
		return manual(
			"prompt_hint_missing",
			"The durable request contains a prompt but no matching live prompt was supplied.",
		);
	}

	return { action: "send", intent: durable.value };
}

type PromptDeliveryAuthority =
	| {
			kind: "host_input";
			contract: typeof PROMPT_DELIVERY_CONTRACT;
			write: PromptDeliveryWrite;
	  }
	| {
			kind: "provider_launch";
			contract: typeof LAUNCH_PROMPT_DELIVERY_CONTRACT;
	  };

async function executePromptDeliveryWithAuthority(
	prompt: string | undefined,
	tools: PromptDeliveryJournalTools,
	authority: PromptDeliveryAuthority,
): Promise<void> {
	const promptStep = tools.prior.steps.find(
		(candidate) => candidate.step === "prompt_delivery",
	);
	const durablePrompt = projectIdentity(
		tools.prior.request?.promptDigest,
		tools.prior.request?.promptLen,
	);
	const livePrompt = prompt
		? await computePromptIdentity(prompt)
		: authority.kind === "provider_launch" && durablePrompt.state === "valid"
			? durablePrompt.value
			: undefined;
	const decision = decidePromptDelivery({
		durableRequest: tools.prior.request,
		promptStep,
		livePrompt,
	});

	if (decision.action === "skip") {
		await tools.skip("prompt_delivery");
		return;
	}

	await tools.step(
		"prompt_delivery",
		async () => {
			if (decision.action === "manual") {
				throw new PromptDeliveryManualError(
					decision.code,
					decision.message,
					decision.deliveryState,
				);
			}
			if (decision.action === "complete") {
				return {
					detail: { recoveredFromDurableReceipt: true },
					value: undefined,
				};
			}
			if (authority.kind === "provider_launch") {
				return {
					detail: {
						deliveryContract: authority.contract,
						...decision.intent,
					},
					value: undefined,
				};
			}
			if (!prompt) {
				throw new PromptDeliveryManualError(
					"prompt_hint_missing",
					"The durable request contains a prompt but no matching live prompt was supplied.",
				);
			}

			let writeOutcome: PromptDeliveryWriteOutcome;
			try {
				writeOutcome = await authority.write(prompt);
			} catch (error) {
				throw new PromptDeliveryManualError(
					"prompt_delivery_unverified",
					`Prompt input returned an ambiguous result; automatic replay is refused: ${String(error)}`,
					"unknown",
				);
			}
			if (writeOutcome.state === "failed") {
				const failure = writeOutcome.error;
				const resumedUnknownAttempt =
					promptStep?.status === "running" &&
					deliveryContract(promptStep) === PROMPT_DELIVERY_CONTRACT;
				const deliveryState = resumedUnknownAttempt
					? "unknown"
					: failure.deliveryState;
				throw new PromptDeliveryManualError(
					failure.code,
					resumedUnknownAttempt
						? `A prior Host attempt may have completed before its receipt was journaled: ${failure.message}`
						: failure.deliveryState === "not_written"
							? `Prompt input was not written; retry remains safe: ${failure.message}`
							: `Prompt input returned an ambiguous result; automatic replay is refused: ${failure.message}`,
					deliveryState,
				);
			}
			return {
				detail: {
					deliveryContract: authority.contract,
					...decision.intent,
					receipt: writeOutcome.receipt,
				},
				value: undefined,
			};
		},
		decision.action === "send"
			? { deliveryContract: authority.contract }
			: undefined,
	);
}

/** The Host owns admission and the compound PTY write. The spawn journal
 * projects its exact receipt only after that operation completes. */
export function executePromptDelivery(
	prompt: string | undefined,
	tools: PromptDeliveryJournalTools,
	write: PromptDeliveryWrite,
): Promise<void> {
	return executePromptDeliveryWithAuthority(prompt, tools, {
		kind: "host_input",
		contract: PROMPT_DELIVERY_CONTRACT,
		write,
	});
}

/** A managed-create receipt already proves launch admission. Project it from
 * the durable prompt identity without retaining or replaying the raw prompt. */
export async function executeLaunchPromptDelivery(
	prompt: string | undefined,
	tools: PromptDeliveryJournalTools,
): Promise<void> {
	return executePromptDeliveryWithAuthority(prompt, tools, {
		kind: "provider_launch",
		contract: LAUNCH_PROMPT_DELIVERY_CONTRACT,
	});
}

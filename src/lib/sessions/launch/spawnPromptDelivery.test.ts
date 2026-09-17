import { describe, expect, it } from "vitest";
import {
	computePromptIdentity,
	decidePromptDelivery,
	executeLaunchPromptDelivery,
	LAUNCH_PROMPT_DELIVERY_CONTRACT,
	PROMPT_DELIVERY_CONTRACT,
	type PromptIdentity,
} from "@/lib/sessions/launch/spawnPromptDelivery";

const prompt: PromptIdentity = {
	promptDigest:
		"sha256:bef4261f394bf71fd2b565cd76396ac9ed7953f9110c69ee49d7a82871238fbf",
	promptLen: 7,
};
const durableRequest = { ...prompt };

describe("prompt delivery decision", () => {
	it("sends only when a pending durable request matches the live prompt", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				promptStep: { step: "prompt_delivery", status: "pending" },
				livePrompt: prompt,
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("finishes an interrupted launch projection without replaying PTY input", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					detail: {
						deliveryContract: LAUNCH_PROMPT_DELIVERY_CONTRACT,
					},
				},
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("projects an accepted launch after reload without the raw prompt", async () => {
		const succeeded: unknown[] = [];
		await executeLaunchPromptDelivery(undefined, {
			prior: {
				v: 1,
				receiptId: "spawn-1",
				request: durableRequest,
				steps: [{ step: "prompt_delivery", status: "pending" }],
				state: "running",
				updatedAt: 1,
			},
			step: async (_name, run, startedDetail) => {
				expect(startedDetail).toEqual({
					deliveryContract: LAUNCH_PROMPT_DELIVERY_CONTRACT,
				});
				const result = await run();
				succeeded.push(result.detail);
				return result.value;
			},
			skip: async () => undefined,
		});

		expect(succeeded).toEqual([
			{
				deliveryContract: LAUNCH_PROMPT_DELIVERY_CONTRACT,
				...prompt,
			},
		]);
	});

	it("rejects a changed live prompt instead of replacing journal authority", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: { ...prompt, promptLen: 8 },
			}),
		).toMatchObject({ action: "manual", code: "prompt_hint_mismatch" });
	});

	it("refuses replay after a durable intent without a written receipt", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					delivery: { state: "intent_durable", ...prompt },
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "prompt_delivery_unverified",
		});
	});

	it("completes a durable written receipt without requiring prompt replay", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					delivery: { state: "written_to_pty", ...prompt },
				},
			}),
		).toEqual({ action: "complete" });
	});

	it("accepts a durable successful legacy step without requiring a live hint", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				promptStep: { step: "prompt_delivery", status: "ok" },
			}),
		).toEqual({ action: "complete" });
	});

	it("treats an old running step without boundary intent as ambiguous", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					evidence: { level: "provider_ready" },
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "prompt_delivery_unverified",
		});
	});

	it("does not let a missing hint mask a legacy ambiguous attempt", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "prompt_delivery_unverified",
		});
	});

	it("re-enters the Host one-shot operation after an interrupted append", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
				},
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("keeps a resumed Host attempt unverified when the live prompt is gone", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				promptStep: {
					step: "prompt_delivery",
					status: "running",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "prompt_delivery_unverified",
			deliveryState: "unknown",
		});
	});

	it("retries only a definite Host not-written failure", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
					error: {
						code: "hmux_agent_prompt_not_waiting",
						message: "Host refused before writing",
						deliveryState: "not_written",
					},
				},
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("still retries a legacy generic not-written journal", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
					error: {
						code: "prompt_delivery_not_written",
						message: "legacy Host refusal",
					},
				},
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("preserves the legacy journal-first retry posture", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: "journal_first_v1" },
					error: { code: "legacy_transient", message: "try again" },
				},
			}),
		).toEqual({ action: "send", intent: prompt });
	});

	it("does not replay a legacy journal-first attempt already marked unverified", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: "journal_first_v1" },
					error: {
						code: "prompt_delivery_unverified",
						message: "legacy delivery may have crossed the PTY boundary",
					},
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "prompt_delivery_unverified",
			deliveryState: "unknown",
		});
	});

	it("preserves an exact unknown Host failure on resume", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
					error: {
						code: "hmux_prompt_receipt_timeout",
						message: "receipt timed out",
						deliveryState: "unknown",
					},
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "hmux_prompt_receipt_timeout",
			deliveryState: "unknown",
		});
	});

	it.each([
		{
			name: "a missing retry hint",
			livePrompt: undefined,
			error: {
				code: "hmux_agent_prompt_not_waiting",
				message: "Host refused before writing",
				deliveryState: "not_written" as const,
			},
		},
		{
			name: "a mismatched retry hint",
			livePrompt: { ...prompt, promptLen: 8 },
			error: {
				code: "hmux_agent_prompt_not_waiting",
				message: "Host refused before writing",
				deliveryState: "not_written" as const,
			},
		},
		{
			name: "a mismatched hint after an unknown outcome",
			livePrompt: { ...prompt, promptLen: 8 },
			error: {
				code: "hmux_prompt_receipt_timeout",
				message: "receipt timed out",
				deliveryState: "unknown" as const,
			},
		},
	])(
		"preserves the prior Host failure across $name",
		({ livePrompt, error }) => {
			expect(
				decidePromptDelivery({
					durableRequest,
					livePrompt,
					promptStep: {
						step: "prompt_delivery",
						status: "failed",
						detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
						error,
					},
				}),
			).toMatchObject({
				action: "manual",
				code: error.code,
				deliveryState: error.deliveryState,
			});
		},
	);

	it("preserves an unclassified Host failure without retrying", () => {
		expect(
			decidePromptDelivery({
				durableRequest,
				livePrompt: prompt,
				promptStep: {
					step: "prompt_delivery",
					status: "failed",
					detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
					error: { code: "unexpected", message: "unknown outcome" },
				},
			}),
		).toMatchObject({
			action: "manual",
			code: "unexpected",
			deliveryState: "unknown",
		});
	});

	it("skips receipts that never contained a prompt", () => {
		expect(decidePromptDelivery({ durableRequest: {} })).toEqual({
			action: "skip",
		});
	});

	it("computes the backend-compatible UTF-8 prompt identity", async () => {
		await expect(computePromptIdentity("ship it")).resolves.toEqual(prompt);
	});
});

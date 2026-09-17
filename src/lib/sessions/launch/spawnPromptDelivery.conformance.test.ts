import { describe, expect, it, vi } from "vitest";
import type { SpawnReceipt, SpawnReceiptStep } from "@/lib/ipc";
import {
	executePromptDelivery,
	PROMPT_DELIVERY_CONTRACT,
	type PromptDeliveryJournalTools,
} from "@/lib/sessions/launch/spawnPromptDelivery";

const identity = {
	promptDigest:
		"sha256:bef4261f394bf71fd2b565cd76396ac9ed7953f9110c69ee49d7a82871238fbf",
	promptLen: 7,
};

const hostReceipt = {
	terminalEpoch: "terminal-1",
	recordId: "7",
	inputBaselineOutputSequence: "0",
	initialAgentRuntimeRevision: "3",
};

function receipt(promptStep?: SpawnReceiptStep): SpawnReceipt {
	return {
		v: 1,
		receiptId: "spawn-1",
		request: identity,
		steps: promptStep ? [promptStep] : [],
		state: "running",
		updatedAt: 1,
	};
}

function tools(
	prior: SpawnReceipt,
	record: unknown[],
): PromptDeliveryJournalTools {
	return {
		prior,
		skip: async (name) => {
			record.push({ skip: name });
		},
		step: async (_name, run, startedDetail) => {
			record.push({ started: startedDetail });
			const result = await run();
			record.push({ succeeded: result.detail });
			return result.value;
		},
	};
}

describe("host-atomic prompt delivery", () => {
	it("journals the exact Host receipt only in the successful step append", async () => {
		const record: unknown[] = [];
		await executePromptDelivery(
			"ship it",
			tools(receipt(), record),
			async () => {
				record.push("host:write");
				return { state: "written", receipt: hostReceipt };
			},
		);

		expect(record).toEqual([
			{ started: { deliveryContract: PROMPT_DELIVERY_CONTRACT } },
			"host:write",
			{
				succeeded: {
					deliveryContract: PROMPT_DELIVERY_CONTRACT,
					...identity,
					receipt: hostReceipt,
				},
			},
		]);
	});

	it("does not journal a receipt for a definite Host refusal", async () => {
		const record: unknown[] = [];
		await expect(
			executePromptDelivery("ship it", tools(receipt(), record), async () => ({
				state: "failed",
				error: {
					code: "hmux_agent_prompt_not_waiting",
					message: "provider is not waiting",
					deliveryState: "not_written",
				},
			})),
		).rejects.toMatchObject({
			code: "hmux_agent_prompt_not_waiting",
			deliveryState: "not_written",
		});
		expect(record).toEqual([
			{ started: { deliveryContract: PROMPT_DELIVERY_CONTRACT } },
		]);
	});

	it("keeps an unknown transport result unverified", async () => {
		const record: unknown[] = [];
		await expect(
			executePromptDelivery("ship it", tools(receipt(), record), async () => {
				throw new Error("connection lost");
			}),
		).rejects.toMatchObject({ code: "prompt_delivery_unverified" });
	});

	it("never replays a shipped legacy durable intent", async () => {
		const write = vi.fn();
		const prior = receipt({
			step: "prompt_delivery",
			status: "running",
			delivery: { state: "intent_durable", ...identity },
		});

		await expect(
			executePromptDelivery("ship it", tools(prior, []), write),
		).rejects.toMatchObject({ code: "prompt_delivery_unverified" });
		expect(write).not.toHaveBeenCalled();
	});

	it("re-enters the Host after a crash before the success append", async () => {
		const record: unknown[] = [];
		const prior = receipt({
			step: "prompt_delivery",
			status: "running",
			detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
		});
		await executePromptDelivery("ship it", tools(prior, record), async () => ({
			state: "written",
			receipt: hostReceipt,
		}));
		expect(record[record.length - 1]).toEqual({
			succeeded: expect.objectContaining({ receipt: hostReceipt }),
		});
	});

	it("reports a resumed refusal as ambiguous", async () => {
		const prior = receipt({
			step: "prompt_delivery",
			status: "running",
			detail: { deliveryContract: PROMPT_DELIVERY_CONTRACT },
		});
		await expect(
			executePromptDelivery("ship it", tools(prior, []), async () => ({
				state: "failed",
				error: {
					code: "hmux_agent_prompt_runtime_changed",
					message: "one-shot already consumed",
					deliveryState: "not_written",
				},
			})),
		).rejects.toMatchObject({
			code: "hmux_agent_prompt_runtime_changed",
			deliveryState: "unknown",
		});
	});

	it("preserves an exact Host code when delivery is unknown", async () => {
		await expect(
			executePromptDelivery("ship it", tools(receipt(), []), async () => ({
				state: "failed",
				error: {
					code: "hmux_prompt_receipt_timeout",
					message: "connection lost after dispatch",
					deliveryState: "unknown",
				},
			})),
		).rejects.toMatchObject({
			code: "hmux_prompt_receipt_timeout",
			deliveryState: "unknown",
		});
	});
});

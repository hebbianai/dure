import { describe, expect, it } from "vitest";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	latestTurnFailure,
	parseTurnFailureReason,
	turnFailureRecoveries,
} from "@/lib/agents/chat/turnFailureReason";

function row(
	sequence: number,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId: "turn-1",
			clientMessageId: "message-1",
			providerMessageId: null,
			body,
			createdAtMs: sequence,
		},
	};
}

const lifecycle = (
	sequence: number,
	state: "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled" | "session_ready",
	detail: string | null = null,
) => row(sequence, { type: "lifecycle", state, detail });

describe("parseTurnFailureReason", () => {
	it("accepts only the shared vocabulary", () => {
		expect(parseTurnFailureReason("usage_limit")).toBe("usage_limit");
		expect(parseTurnFailureReason("runtime_replaced")).toBe("runtime_replaced");
		expect(parseTurnFailureReason("Usage limit reached")).toBeUndefined();
		expect(parseTurnFailureReason(null)).toBeUndefined();
	});

	it("offers recoveries only for credential-class reasons", () => {
		expect(turnFailureRecoveries("usage_limit")).toEqual(["switch_account"]);
		expect(turnFailureRecoveries("rate_limit")).toEqual(["switch_account"]);
		expect(turnFailureRecoveries("authentication_failed")).toEqual([
			"sign_in",
			"switch_account",
		]);
		expect(turnFailureRecoveries("provider_error")).toEqual([]);
		expect(turnFailureRecoveries("context_window_exceeded")).toEqual([]);
	});
});

describe("latestTurnFailure", () => {
	it("returns the newest turn's classified failure", () => {
		const rows = [
			lifecycle(1, "turn_started"),
			row(2, { type: "message", role: "user", markdown: "hi" }),
			lifecycle(3, "turn_failed", "usage_limit"),
		];
		expect(latestTurnFailure(rows)).toEqual({
			reason: "usage_limit",
			recoveries: ["switch_account"],
			itemId: "item-3",
			createdAtMs: 3,
			userInput: "hi",
		});
	});

	it("ignores a failure once a later turn or user message follows it", () => {
		const failed = lifecycle(1, "turn_failed", "usage_limit");
		expect(latestTurnFailure([failed, lifecycle(2, "turn_started")])).toBeUndefined();
		expect(
			latestTurnFailure([failed, row(2, { type: "message", role: "user", markdown: "again" })]),
		).toBeUndefined();
		// Session bookkeeping after the failure does not hide it.
		expect(latestTurnFailure([failed, lifecycle(2, "session_ready")])?.reason).toBe(
			"usage_limit",
		);
	});

	it("never guesses from a failure without a shared reason", () => {
		expect(latestTurnFailure([lifecycle(1, "turn_failed", null)])).toBeUndefined();
		expect(latestTurnFailure([lifecycle(1, "turn_failed", "some prose")])).toBeUndefined();
	});
});

describe("latestTurnFailure user input", () => {
	it("keeps only the failed turn's own user message and omits it when absent", () => {
		const other = row(1, { type: "message", role: "user", markdown: "earlier turn" });
		other.item.turnId = "turn-0";
		other.item.clientMessageId = "message-0";
		expect(
			latestTurnFailure([other, lifecycle(2, "turn_started"), lifecycle(3, "turn_failed", "rate_limit")]),
		).toMatchObject({ reason: "rate_limit" });
		expect(
			latestTurnFailure([other, lifecycle(2, "turn_started"), lifecycle(3, "turn_failed", "rate_limit")])?.userInput,
		).toBeUndefined();
	});
});

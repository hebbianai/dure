import { describe, expect, it } from "vitest";
import {
	latestTurnFailure,
	parseTurnFailureReason,
	turnFailureRecoveries,
} from "@/lib/agents/chat/turnFailureReason";

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
	it("projects recovery actions and retained input from the store fact", () => {
		expect(
			latestTurnFailure({
				itemId: "failed-1",
				createdAtMs: 10,
				reason: "usage_limit",
				userInput: "finish this",
			}),
		).toEqual({
			itemId: "failed-1",
			createdAtMs: 10,
			reason: "usage_limit",
			userInput: "finish this",
			recoveries: ["switch_account"],
		});
	});
	it("does not invent input or a failure when the store has none", () => {
		expect(latestTurnFailure(null)).toBeUndefined();
		expect(latestTurnFailure(undefined)).toBeUndefined();
		expect(
			latestTurnFailure({
				itemId: "failed-1",
				createdAtMs: 10,
				reason: "provider_error",
				userInput: null,
			}),
		).toEqual({
			itemId: "failed-1",
			createdAtMs: 10,
			reason: "provider_error",
			recoveries: [],
		});
	});
});

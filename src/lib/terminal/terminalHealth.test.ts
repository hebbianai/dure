import { describe, expect, it } from "vitest";
import { observeHmuxPaneHealth } from "@/lib/terminal/terminalHealth";

describe("Hmux pane health observations", () => {
	it("retains the last complete frame while the exact attachment recovers", () => {
		const live = observeHmuxPaneHealth(
			undefined,
			{
				kind: "frame_presented",
				terminalEpoch: "terminal-1",
				sequence: "42",
			},
			1,
		);

		expect(
			observeHmuxPaneHealth(
				live,
				{ kind: "connection", state: "recovering", reason: "carrier closed" },
				2,
			),
		).toEqual({
			state: "recovering",
			reason: "carrier closed",
			terminalEpoch: "terminal-1",
			receivedSequence: "42",
			presentedSequence: "42",
			updatedAt: 2,
		});
	});

	it("adopts a complete frame as live without waiting for catalog inventory", () => {
		expect(
			observeHmuxPaneHealth(
				{
					state: "error",
					reason: "old transport",
					terminalEpoch: "terminal-1",
					updatedAt: 1,
				},
				{
					kind: "frame_received",
					terminalEpoch: "terminal-2",
					sequence: "7",
				},
				2,
			),
		).toEqual({
			state: "live",
			terminalEpoch: "terminal-2",
			receivedSequence: "7",
			presentedSequence: undefined,
			updatedAt: 2,
		});
	});

	it("clears stale frame identity for a new initial attachment", () => {
		expect(
			observeHmuxPaneHealth(
				{
					state: "live",
					terminalEpoch: "terminal-old",
					receivedSequence: "9",
					presentedSequence: "9",
					updatedAt: 1,
				},
				{ kind: "connection", state: "connecting" },
				2,
			),
		).toEqual({
			state: "connecting",
			reason: undefined,
			terminalEpoch: undefined,
			receivedSequence: undefined,
			presentedSequence: undefined,
			updatedAt: 2,
		});
	});
});

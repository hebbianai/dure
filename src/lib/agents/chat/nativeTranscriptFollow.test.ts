import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";
import {
	appendNewerTranscriptRead,
	followNativeTranscript,
	readFollowedTranscript,
} from "./nativeTranscriptFollow";

function read(
	fields: Partial<ProviderConversationActivity> = {},
): ProviderConversationActivity {
	return {
		schemaVersion: 1,
		provider: "claude",
		conversationId: "conversation-1",
		historyComplete: true,
		finalResponse: null,
		entries: [],
		...fields,
	};
}

const call = (
	callId: string,
	afterEntries: number,
	state = "running",
	input: unknown = { file_path: callId },
) => ({ callId, name: "Read", state, afterEntries, input });

describe("appendNewerTranscriptRead", () => {
	const base = read({
		entries: [
			{ role: "user", text: "Fix the bug" },
			{ role: "agent", text: "Reading the code." },
		],
		tools: [call("call-1", 2), call("call-2", 2)],
		olderCursor: 512,
		historyComplete: false,
		newerCursor: 4096,
	});

	it("joins what was appended after the newest read as one read", () => {
		const joined = appendNewerTranscriptRead(
			base,
			read({
				entries: [{ role: "agent", text: "Found it." }],
				tools: [call("call-3", 1)],
				results: [{ callId: "call-1", state: "completed" }],
				newerCursor: 6144,
			}),
		);
		expect(joined).toEqual({
			...base,
			entries: [...base.entries, { role: "agent", text: "Found it." }],
			tools: [
				call("call-1", 2, "completed"),
				call("call-2", 2),
				call("call-3", 3),
			],
			newerCursor: 6144,
		});
		// Where older records begin and whether the history is whole stay the
		// newest read's.
		expect(joined?.olderCursor).toBe(512);
		expect(joined?.historyComplete).toBe(false);
	});

	it("keeps the newest read itself when nothing was appended", () => {
		expect(appendNewerTranscriptRead(base, read({ newerCursor: 4096 }))).toBe(
			base,
		);
	});

	it("gives a call recorded again its newer state in its place", () => {
		const joined = appendNewerTranscriptRead(
			base,
			read({
				tools: [call("call-2", 0, "failed", { file_path: "b" })],
				newerCursor: 5000,
			}),
		);
		expect(joined?.tools).toEqual([
			call("call-1", 2),
			call("call-2", 2, "failed", { file_path: "b" }),
		]);
	});

	it("leaves out a malformed result on its own", () => {
		const joined = appendNewerTranscriptRead(
			base,
			read({
				results: [
					{ callId: "call-1", state: "exploded" },
					{ callId: 7, state: "completed" },
					{ callId: "call-2", state: "canceled" },
				],
				newerCursor: 5000,
			}),
		);
		expect(joined?.tools).toEqual([
			call("call-1", 2),
			call("call-2", 2, "canceled"),
		]);
	});

	it("follows the final answer the newer records leave", () => {
		const answered = read({ ...base, finalResponse: "Done." });
		expect(
			appendNewerTranscriptRead(
				answered,
				read({ entries: [{ role: "agent", text: "…" }], newerCursor: 5000 }),
			)?.finalResponse,
		).toBe("Done.");
		expect(
			appendNewerTranscriptRead(
				answered,
				read({ entries: [{ role: "user", text: "Next" }], newerCursor: 5000 }),
			)?.finalResponse,
		).toBeNull();
		expect(
			appendNewerTranscriptRead(
				answered,
				read({ finalResponse: "Fixed.", newerCursor: 5000 }),
			)?.finalResponse,
		).toBe("Fixed.");
	});

	it("leaves a read that does not reach back to the newest read to a whole read", () => {
		expect(
			appendNewerTranscriptRead(
				base,
				read({ olderCursor: 5000, newerCursor: 9000 }),
			),
		).toBeUndefined();
		expect(appendNewerTranscriptRead(base, read())).toBeUndefined();
	});
});

describe("readFollowedTranscript", () => {
	const base = read({
		entries: [{ role: "user", text: "Go" }],
		newerCursor: 100,
	});

	it("reads only what was appended after the newest read", async () => {
		const reader = vi.fn(async () =>
			read({ entries: [{ role: "agent", text: "On it." }], newerCursor: 180 }),
		);
		const next = await readFollowedTranscript(base, reader);
		expect(reader).toHaveBeenCalledExactlyOnceWith(100);
		expect(next.entries.map((entry) => entry.text)).toEqual(["Go", "On it."]);
		expect(next.newerCursor).toBe(180);
	});

	it("reads the whole transcript again when the appended read fails or cannot join", async () => {
		const whole = read({ entries: [{ role: "user", text: "Replaced" }] });
		const failing = vi.fn(async (after?: number) => {
			if (after !== undefined) throw new Error("provider transcript changed");
			return whole;
		});
		await expect(readFollowedTranscript(base, failing)).resolves.toBe(whole);
		expect(failing.mock.calls).toEqual([[100], []]);

		const gap = vi.fn(async (after?: number) =>
			after === undefined
				? whole
				: read({ olderCursor: 140, newerCursor: 900 }),
		);
		await expect(readFollowedTranscript(base, gap)).resolves.toBe(whole);
	});

	it("reads a transcript that names no newer cursor whole", async () => {
		const whole = read({ entries: [{ role: "user", text: "Pi" }] });
		const reader = vi.fn(async () => whole);
		await expect(
			readFollowedTranscript(read({ entries: [] }), reader),
		).resolves.toBe(whole);
		expect(reader).toHaveBeenCalledExactlyOnceWith();
	});
});

describe("followNativeTranscript", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function followed() {
		let report: () => void = () => {};
		const unfollow = vi.fn();
		const reads: Array<() => void> = [];
		const read = vi.fn(
			() => new Promise<void>((resolve) => reads.push(() => resolve())),
		);
		const end = followNativeTranscript({
			follow: async (onChange) => {
				report = onChange;
				return unfollow;
			},
			read,
			intervalMs: 1_000,
			now: () => Date.now(),
		});
		return {
			change: () => report(),
			finishRead: async () => {
				reads.shift()?.();
				await vi.advanceTimersByTimeAsync(0);
			},
			read,
			unfollow,
			end,
		};
	}

	it("reads once the follow begins, then at most once a second", async () => {
		const follow = followed();
		await vi.advanceTimersByTimeAsync(0);
		expect(follow.read).toHaveBeenCalledTimes(1);
		await follow.finishRead();

		follow.change();
		follow.change();
		await vi.advanceTimersByTimeAsync(999);
		expect(follow.read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(follow.read).toHaveBeenCalledTimes(2);
		await follow.finishRead();

		// A quiet second later, a change is read at once.
		await vi.advanceTimersByTimeAsync(5_000);
		follow.change();
		await vi.advanceTimersByTimeAsync(0);
		expect(follow.read).toHaveBeenCalledTimes(3);
	});

	it("reads a change made during a read after it, and never two at once", async () => {
		const follow = followed();
		await vi.advanceTimersByTimeAsync(0);
		follow.change();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(follow.read).toHaveBeenCalledTimes(1);
		await follow.finishRead();
		expect(follow.read).toHaveBeenCalledTimes(2);
	});

	it("reads nothing without changes, and nothing once ended", async () => {
		const follow = followed();
		await vi.advanceTimersByTimeAsync(0);
		await follow.finishRead();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(follow.read).toHaveBeenCalledTimes(1);

		follow.change();
		follow.end();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(follow.read).toHaveBeenCalledTimes(1);
		expect(follow.unfollow).toHaveBeenCalledTimes(1);
	});

	it("ends a follow that begins after it was ended", async () => {
		const unfollow = vi.fn();
		const read = vi.fn(async () => {});
		let begin: (end: () => void) => void = () => {};
		const end = followNativeTranscript({
			follow: () => new Promise((resolve) => (begin = resolve)),
			read,
		});
		end();
		begin(unfollow);
		await vi.advanceTimersByTimeAsync(0);
		expect(unfollow).toHaveBeenCalledTimes(1);
		expect(read).not.toHaveBeenCalled();
	});

	it("tries again to follow a transcript its provider has not written yet", async () => {
		const read = vi.fn(async () => {});
		const unfollow = vi.fn();
		const follow = vi
			.fn<(onChange: () => void) => Promise<() => void>>()
			.mockRejectedValueOnce(new Error("provider conversation was not found"))
			.mockRejectedValueOnce(new Error("provider conversation was not found"))
			.mockResolvedValue(unfollow);
		const end = followNativeTranscript({ follow, read, intervalMs: 1_000 });
		await vi.advanceTimersByTimeAsync(0);
		expect(read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(follow).toHaveBeenCalledTimes(2);
		// Each wait is twice the last.
		await vi.advanceTimersByTimeAsync(1_999);
		expect(follow).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(follow).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(1);

		end();
		expect(unfollow).toHaveBeenCalledTimes(1);
	});

	it("stops trying once ended", async () => {
		const follow = vi.fn(() => Promise.reject(new Error("not found")));
		const end = followNativeTranscript({ follow, read: async () => {} });
		await vi.advanceTimersByTimeAsync(0);
		end();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(follow).toHaveBeenCalledTimes(1);
	});
});

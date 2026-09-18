import { describe, expect, it, vi } from "vitest";
import {
	activeAgentChatTurn,
	convergeAgentChatDelta,
	convergeAgentChatHistory,
	convergeAgentChatPage,
	projectAgentChatTranscript,
	segmentAgentChatRows,
	transcriptTailFacts,
} from "@/lib/agents/chat/agentChatProjection";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";

function page(sequence = 1): AgentTimelinePageV1 {
	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			agentId: "agent-1",
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: {
				runtimeGeneration: "runtime-1",
				providerEpoch: "query-1",
			},
			timelineEpoch: "timeline-1",
			bindingRevision: 1,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		rows: [],
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		recovery: null,
		latestFailure: null,
		goal: null,
		finalCursor: { epoch: "timeline-1", sequence },
		hasMore: false,
	};
}

function row(sequence: number): AgentTimelinePageV1["rows"][number] {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId: null,
			clientMessageId: null,
			providerMessageId: `provider-message-${sequence}`,
			body: { type: "message", role: "assistant", markdown: `${sequence}` },
			createdAtMs: sequence,
		},
	};
}

describe("agent chat projection", () => {
	it("replaces the failure snapshot on deltas without deriving it from retained rows", () => {
		const current = page(1);
		current.rows = [row(1)];
		const next = page(2);
		next.rows = [row(2)];
		next.latestFailure = {
			itemId: "failed",
			createdAtMs: 2,
			reason: "usage_limit",
			userInput: "original",
		};
		const identity = {
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
		};
		const failed = convergeAgentChatDelta(current, next, identity, 1);
		expect(failed.rows).toHaveLength(1);
		expect(failed.latestFailure?.userInput).toBe("original");
		const continued = page(3);
		continued.rows = [row(3)];
		expect(
			convergeAgentChatDelta(failed, continued, identity).latestFailure,
		).toBeNull();
	});

	it("ignores an older complete snapshot and accepts a runtime replacement", () => {
		const current = page(4);
		expect(
			convergeAgentChatPage(current, page(3), {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}),
		).toBe(current);

		const replacement = page(4);
		replacement.binding.bindingRevision = 2;
		replacement.binding.runtime = {
			runtimeGeneration: "runtime-2",
			providerEpoch: "query-2",
		};
		expect(
			convergeAgentChatPage(current, replacement, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}),
		).toBe(replacement);
	});

	it("converges cursor deltas without replacing the retained tail", () => {
		const current = page(2);
		current.rows = [row(1), row(2)];
		current.hasMore = true;
		const liveOnly = page(2);
		liveOnly.liveText = [
			{
				streamId: "stream-1",
				itemId: "live-1",
				kind: "assistant",
				text: "streaming",
				turnId: null,
				clientMessageId: null,
				providerMessageId: "provider-message-live",
				updatedAtMs: 3,
			},
		];

		const live = convergeAgentChatDelta(
			current,
			liveOnly,
			{ agentId: "agent-1", interactionSessionId: "interaction-1" },
			3,
		);
		expect(live.rows).toBe(current.rows);
		expect(live.liveText).toBe(liveOnly.liveText);
		expect(live.hasMore).toBe(true);

		const appended = page(4);
		appended.rows = [row(3), row(4)];
		const next = convergeAgentChatDelta(
			live,
			appended,
			{ agentId: "agent-1", interactionSessionId: "interaction-1" },
			3,
		);
		expect(next.rows.map((entry) => entry.cursor.sequence)).toEqual([2, 3, 4]);
		expect(next.finalCursor.sequence).toBe(4);
		expect(next.hasMore).toBe(true);
	});

	it("prepends canonical history while preserving the live head cursor", () => {
		const requested = page(6);
		requested.rows = [row(5), row(6)];
		requested.hasMore = true;
		const current = {
			...requested,
			rows: [row(6)],
			liveText: [
				{
					streamId: "stream-live",
					itemId: "item-live",
					kind: "assistant" as const,
					text: "new live head",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-live",
					updatedAtMs: 7,
				},
			],
		};
		const older = page(3);
		older.rows = [row(3), row(4)];
		older.hasMore = false;

		const merged = convergeAgentChatHistory(current, requested, older, {
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
		});

		expect(merged.rows.map((entry) => entry.cursor.sequence)).toEqual([
			3, 4, 5, 6,
		]);
		expect(merged.finalCursor.sequence).toBe(6);
		expect(merged.liveText).toBe(current.liveText);
		expect(merged.hasMore).toBe(false);
	});

	it("merges shared retained rows without serializing their payloads", () => {
		const requested = page(2049);
		requested.rows = Array.from({ length: 2048 }, (_, index) => {
			const retained = row(index + 2);
			retained.item.body = {
				type: "message",
				role: "assistant",
				markdown: "x".repeat(8192),
			};
			return retained;
		});
		const current = { ...requested, rows: [...requested.rows] };
		const older = page(1);
		older.rows = [row(1)];
		const stringify = vi.spyOn(JSON, "stringify");
		let merged: AgentTimelinePageV1;
		let serializationCount: number;
		try {
			merged = convergeAgentChatHistory(current, requested, older, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			});
			serializationCount = stringify.mock.calls.length;
		} finally {
			stringify.mockRestore();
		}

		expect(serializationCount).toBe(0);
		expect(merged.rows).toHaveLength(2049);
		expect(merged.rows[0]).toBe(older.rows[0]);
		expect(
			merged.rows
				.slice(1)
				.every((entry, index) => entry === current.rows[index]),
		).toBe(true);
	});

	it("rejects conflicting overlap while deduplicating an exact retained row", () => {
		const requested = page(4);
		requested.rows = [row(3), row(4)];
		requested.hasMore = true;
		const older = page(2);
		older.rows = [row(1), row(2)];
		older.finalCursor.sequence = 1;
		const current = { ...requested, rows: [row(4)] };
		expect(
			convergeAgentChatHistory(current, requested, older, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}).rows.map((entry) => entry.cursor.sequence),
		).toEqual([1, 2, 3, 4]);

		const conflicting = { ...current, rows: [row(4)] };
		conflicting.rows[0]!.item.itemId = "conflicting-item";
		expect(() =>
			convergeAgentChatHistory(conflicting, requested, older, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}),
		).toThrow("agent_chat_history_row_conflict");

		conflicting.rows[0]!.item = {
			...row(4).item,
			body: { type: "message", role: "assistant", markdown: "changed content" },
		};
		expect(() =>
			convergeAgentChatHistory(conflicting, requested, older, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}),
		).toThrow("agent_chat_history_row_conflict");

		const wrongCredential = {
			...older,
			binding: {
				...older.binding,
				executionProfile: {
					kind: "credential_reference" as const,
					reference_id: "other-account",
					credential_generation: "credential-2",
				},
			},
		};
		expect(() =>
			convergeAgentChatHistory(current, requested, wrongCredential, {
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
			}),
		).toThrow("agent_chat_runtime_fence_conflict");
	});

	it("rejects a cursor delta that crosses authority or cannot advance", () => {
		const current = page(2);
		const replacement = page(3);
		replacement.rows = [row(3)];
		replacement.binding.runtime.runtimeGeneration = "runtime-2";
		expect(() =>
			convergeAgentChatDelta(
				current,
				replacement,
				{ agentId: "agent-1", interactionSessionId: "interaction-1" },
				128,
			),
		).toThrow("agent_chat_runtime_fence_conflict");

		const stalled = page(2);
		stalled.hasMore = true;
		expect(() =>
			convergeAgentChatDelta(
				current,
				stalled,
				{ agentId: "agent-1", interactionSessionId: "interaction-1" },
				128,
			),
		).toThrow("agent_chat_delta_cursor_invalid");
	});

	it("uses the authoritative active-turn snapshot as the interrupt fence", () => {
		const active = page(3);
		active.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		active.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "item-1",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		expect(activeAgentChatTurn(active)).toEqual({
			turnId: "turn-1",
			clientMessageId: "message-1",
		});
		active.rows.push({
			cursor: { epoch: "timeline-1", sequence: 2 },
			item: {
				itemId: "item-2",
				turnId: null,
				clientMessageId: "message-other",
				providerMessageId: null,
				body: { type: "lifecycle", state: "turn_failed", detail: null },
				createdAtMs: 2,
			},
		});
		expect(activeAgentChatTurn(active)).toEqual({
			turnId: "turn-1",
			clientMessageId: "message-1",
		});
		active.rows.push({
			cursor: { epoch: "timeline-1", sequence: 3 },
			item: {
				itemId: "item-3",
				turnId: null,
				clientMessageId: "message-1",
				providerMessageId: null,
				body: { type: "lifecycle", state: "turn_completed", detail: null },
				createdAtMs: 3,
			},
		});
		active.activeTurn = null;
		expect(activeAgentChatTurn(active)).toBeUndefined();
	});

	it("keeps the active turn authority when a bounded delta trims its start row", () => {
		const current = page(1);
		current.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		current.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		const delta = page(129);
		delta.rows = Array.from({ length: 128 }, (_, index) => row(index + 2));
		delta.activeTurn = current.activeTurn;

		const bounded = convergeAgentChatDelta(
			current,
			delta,
			{ agentId: "agent-1", interactionSessionId: "interaction-1" },
			128,
		);

		expect(bounded.rows[0]?.cursor.sequence).toBe(2);
		expect(activeAgentChatTurn(bounded)).toEqual({
			turnId: "turn-1",
			clientMessageId: "message-1",
		});
	});

	it("groups unkeyed provider output inside the one durable active turn", () => {
		const transcript = page(5);
		transcript.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "user",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "message", role: "user", markdown: "hello" },
					createdAtMs: 1_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "assistant",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					body: {
						type: "message",
						role: "assistant",
						markdown: "## Answer",
					},
					createdAtMs: 2_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 4 },
				item: {
					itemId: "evidence",
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					body: {
						type: "provider_evidence",
						namespace: "claude",
						kind: "usage",
						value: {},
					},
					createdAtMs: 2_500,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 5 },
				item: {
					itemId: "turn-complete",
					turnId: null,
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_completed", detail: null },
					createdAtMs: 4_200,
				},
			},
		];

		expect(projectAgentChatTranscript(transcript.rows)).toEqual([
			{
				kind: "turn",
				key: "timeline-1:1",
				turnId: "turn-1",
				clientMessageId: "message-1",
				rows: [
					{
						key: "timeline:timeline-1:2",
						revision: "timeline-1:2",
						timeline: transcript.rows[1],
					},
					{
						key: "timeline:timeline-1:3",
						revision: "timeline-1:3",
						timeline: transcript.rows[2],
					},
				],
				state: "completed",
				workedMs: 3200,
				assistantMarkdown: "## Answer",
			},
		]);
	});

	it("recovers a completed turn when its start was cut off by pagination", () => {
		const transcript = page(2);
		transcript.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 127 },
				item: {
					itemId: "assistant-tail",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-tail",
					body: {
						type: "message",
						role: "assistant",
						markdown: "Tail answer",
					},
					createdAtMs: 3_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 128 },
				item: {
					itemId: "turn-complete-tail",
					turnId: null,
					clientMessageId: "message-tail",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_completed", detail: null },
					createdAtMs: 4_000,
				},
			},
		];

		expect(projectAgentChatTranscript(transcript.rows)).toEqual([
			{
				kind: "turn",
				key: "timeline-1:127",
				turnId: null,
				clientMessageId: "message-tail",
				rows: [
					{
						key: "timeline:timeline-1:127",
						revision: "timeline-1:127",
						timeline: transcript.rows[0],
					},
				],
				state: "completed",
				workedMs: null,
				assistantMarkdown: "Tail answer",
			},
		]);
	});

	it("keeps one latest tool snapshot at its first turn position", () => {
		const transcript = page(5);
		transcript.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "tool-running",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool-call-1",
						name: "Read",
						state: "running",
						input: { file_path: "README.md" },
						output: null,
					},
					createdAtMs: 2,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "assistant-after-tool",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					body: { type: "message", role: "assistant", markdown: "Done" },
					createdAtMs: 3,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 4 },
				item: {
					itemId: "tool-completed",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool-call-1",
						name: "Read",
						state: "completed",
						input: null,
						output: "contents",
					},
					createdAtMs: 4,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 5 },
				item: {
					itemId: "turn-completed",
					turnId: null,
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_completed", detail: null },
					createdAtMs: 5,
				},
			},
		];

		const [turn] = projectAgentChatTranscript(transcript.rows);
		if (turn?.kind !== "turn") throw new Error("expected a turn block");
		expect(turn.state).toBe("completed");
		expect(turn.rows).toHaveLength(2);
		expect(turn.rows[0]).toMatchObject({
			key: "tool:tool-call-1",
			revision: "timeline-1:2|timeline-1:4",
			timeline: {
				item: {
					itemId: "tool-completed",
					body: {
						type: "tool",
						input: { file_path: "README.md" },
						output: "contents",
						state: "completed",
					},
				},
			},
		});
		expect(turn.rows[1]?.timeline).toBe(transcript.rows[2]);

		const partial = projectAgentChatTranscript(transcript.rows.slice(1, 4));
		expect(partial).toHaveLength(2);
		expect(partial[0]).toMatchObject({
			kind: "row",
			row: {
				key: "tool:tool-call-1",
				revision: "timeline-1:2|timeline-1:4",
				timeline: {
					item: {
						itemId: "tool-completed",
						body: {
							type: "tool",
							input: { file_path: "README.md" },
							state: "completed",
						},
					},
				},
			},
		});
	});

	it("separates matching tool snapshots across partial history boundaries", () => {
		const transcript = page(3);
		transcript.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "tool-running",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool:call:1",
						name: "Read",
						state: "running",
						input: { file_path: "README.md" },
						output: null,
					},
					createdAtMs: 1,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "history-boundary",
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					body: {
						type: "history_boundary",
						reason: "page_cut",
						requestedAfterProviderSequence: 1,
						droppedThroughProviderSequence: 1,
					},
					createdAtMs: 2,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "tool-completed",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool:call:1",
						name: "Read",
						state: "completed",
						input: null,
						output: "contents",
					},
					createdAtMs: 3,
				},
			},
		];

		const projected = projectAgentChatTranscript(transcript.rows);
		const toolKeys = projected.flatMap((block) =>
			block.kind === "row" && block.row.timeline.item.body.type === "tool"
				? [block.key]
				: [],
		);
		expect(toolKeys).toHaveLength(2);
		expect(new Set(toolKeys).size).toBe(2);
	});

	it("derives tail facts from the exact controller-authoritative turn", () => {
		const transcript = page(3);
		transcript.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "user-2",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "message", role: "user", markdown: "second" },
					createdAtMs: 2,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "tool-live",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool-call-1",
						name: "Bash",
						state: "running",
						input: null,
						output: null,
					},
					createdAtMs: 3,
				},
			},
		];
		const projected = projectAgentChatTranscript(transcript.rows);
		const facts = transcriptTailFacts(projected, {
			turnId: "turn-1",
			clientMessageId: "message-1",
		});
		expect(facts.lastUserKey).toBe("timeline:timeline-1:2");
		expect(facts.activeTurnRunningTool).toEqual({
			turnId: "turn-1",
			clientMessageId: "message-1",
			toolKey: "tool:tool-call-1",
		});
		expect(transcriptTailFacts(projected).activeTurnRunningTool).toBeNull();
	});

	it("segments consecutive tool rows into one strip without reordering", () => {
		const row = (key: string, type: "tool" | "message") => ({
			key,
			revision: key,
			timeline: {
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: key,
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					body:
						type === "tool"
							? ({
									type: "tool",
									toolCallId: key,
									name: "Read",
									state: "completed",
									input: null,
									output: null,
								} as const)
							: ({
									type: "message",
									role: "assistant",
									markdown: "hi",
								} as const),
					createdAtMs: 1,
				},
			},
		});
		const segments = segmentAgentChatRows([
			row("tool-1", "tool"),
			row("tool-2", "tool"),
			row("message-1", "message"),
			row("tool-3", "tool"),
		]);
		expect(
			segments.map((segment) =>
				segment.kind === "tools"
					? segment.rows.map((entry) => entry.key)
					: segment.key,
			),
		).toEqual([["tool-1", "tool-2"], "message-1", ["tool-3"]]);
		expect(segments.map((segment) => segment.key)).toEqual([
			"tools:tool-1",
			"message-1",
			"tools:tool-3",
		]);
	});

	function lifecycleRow(
		sequence: number,
		state:
			| "session_ready"
			| "session_failed"
			| "session_exited"
			| "turn_started"
			| "turn_completed",
		ids: { turnId?: string; clientMessageId?: string } = {},
		detail: string | null = null,
	): AgentTimelinePageV1["rows"][number] {
		return {
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId: `item-${sequence}`,
				turnId: ids.turnId ?? null,
				clientMessageId: ids.clientMessageId ?? null,
				providerMessageId: null,
				body: { type: "lifecycle", state, detail },
				createdAtMs: sequence * 1_000,
			},
		};
	}

	// Contract: a turn whose terminal lifecycle row was lost must not stay
	// projected as live once the timeline records that its runtime session is
	// gone. Row shape mirrors the 2026-08-29 production timeline
	// (claude-chat-58084d1f2f23b80a3d771ce1 seq 1387-1401) that kept a chat
	// pane on "Responding" for 29 hours.
	it("interrupts an open turn when its runtime session provably ended", () => {
		const rows = [
			lifecycleRow(1, "session_exited", {}, '{"reason":"sdk_stream_failed"}'),
			lifecycleRow(2, "turn_started", {
				turnId: "turn-1",
				clientMessageId: "message-1",
			}),
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "user-3",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: {
						type: "message" as const,
						role: "user" as const,
						markdown: "hello?",
					},
					createdAtMs: 3_000,
				},
			},
			lifecycleRow(4, "session_ready"),
			lifecycleRow(5, "session_exited", {}, '{"code":0,"signal":null}'),
		];
		const stuck = page(5);
		stuck.rows = rows;

		expect(activeAgentChatTurn(stuck)).toBeUndefined();
		const turn = projectAgentChatTranscript(rows).find(
			(block) => block.kind === "turn",
		);
		expect(turn).toMatchObject({
			turnId: "turn-1",
			state: "interrupted",
			workedMs: null,
		});
	});

	it("keeps a turn live across its own lazy runtime spawn", () => {
		const rows = [
			lifecycleRow(1, "turn_started", {
				turnId: "turn-1",
				clientMessageId: "message-1",
			}),
			lifecycleRow(2, "session_ready"),
		];
		const live = page(2);
		live.rows = rows;
		live.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};

		expect(activeAgentChatTurn(live)).toEqual({
			turnId: "turn-1",
			clientMessageId: "message-1",
		});
		expect(
			projectAgentChatTranscript(rows).find((block) => block.kind === "turn"),
		).toMatchObject({ state: "active" });

		const completed = page(3);
		completed.rows = [...rows, lifecycleRow(3, "turn_completed", {
			clientMessageId: "message-1",
		})];
		expect(activeAgentChatTurn(completed)).toBeUndefined();
	});

	it("interrupts a turn on a warm session when that session is replaced", () => {
		const rows = [
			lifecycleRow(1, "session_ready"),
			lifecycleRow(2, "turn_started", {
				turnId: "turn-1",
				clientMessageId: "message-1",
			}),
			lifecycleRow(3, "session_ready"),
		];
		const replaced = page(3);
		replaced.rows = rows;

		expect(activeAgentChatTurn(replaced)).toBeUndefined();
		expect(
			projectAgentChatTranscript(rows).find((block) => block.kind === "turn"),
		).toMatchObject({ state: "interrupted" });
	});
});

describe("turn failure reason projection", () => {
	it("carries the shared reason token on a failed turn block", () => {
		const start = row(1);
		start.item.turnId = "turn-9";
		start.item.clientMessageId = "message-9";
		start.item.body = { type: "lifecycle", state: "turn_started", detail: null };
		const failed = row(2);
		failed.item.turnId = "turn-9";
		failed.item.clientMessageId = "message-9";
		failed.item.body = {
			type: "lifecycle",
			state: "turn_failed",
			detail: "authentication_failed",
		};
		const [turn] = projectAgentChatTranscript([start, failed]);
		expect(turn).toMatchObject({
			kind: "turn",
			state: "failed",
			failureReason: "authentication_failed",
		});

		failed.item.body = { type: "lifecycle", state: "turn_failed", detail: null };
		const [plain] = projectAgentChatTranscript([start, failed]);
		expect(plain).toMatchObject({ kind: "turn", state: "failed" });
		expect(plain && "failureReason" in plain).toBe(false);
	});
});

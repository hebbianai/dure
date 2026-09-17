import { describe, expect, it } from "vitest";
import type {
	AgentChatProjectedRow,
	AgentChatTurnBlock,
} from "@/lib/agents/chat/agentChatProjection";
import { agentChatTimelineItems } from "@/lib/agents/chat/agentChatTimelineItems";

function row(sequence: number): AgentChatProjectedRow {
	return {
		key: `row:${sequence}`,
		revision: `epoch:${sequence}`,
		timeline: {
			cursor: { epoch: "epoch", sequence },
			item: {
				itemId: `item:${sequence}`,
				turnId: "turn",
				clientMessageId: "client",
				providerMessageId: null,
				createdAtMs: sequence,
				body: {
					type: "message",
					role: "assistant",
					markdown: `Answer ${sequence}`,
				},
			},
		},
	};
}

function turn(rows: AgentChatProjectedRow[]): AgentChatTurnBlock {
	return {
		kind: "turn",
		key: "turn-span",
		turnId: "turn",
		clientMessageId: "client",
		rows,
		state: "completed",
		assistantMarkdown: "Complete answer for copying",
		workedMs: 90_000,
	};
}

describe("agentChatTimelineItems", () => {
	it("windows individual messages even when one turn contains the entire history", () => {
		const source = turn(
			Array.from({ length: 1_000 }, (_, index) => row(index)),
		);
		const items = agentChatTimelineItems([source]);
		expect(items.filter((item) => item.kind === "segment")).toHaveLength(1_000);
		expect(items[items.length - 1]).toEqual({
			kind: "footer",
			key: "footer:turn-span",
			turn: source,
		});
		const keys = new Set(items.map((item) => item.key));
		expect(keys.size).toBe(items.length);
	});

	it("preserves message identity when prepend regroups a standalone row into a turn", () => {
		const retained = row(2);
		const before = agentChatTimelineItems([
			{ kind: "row", key: retained.key, row: retained },
		]);
		const after = agentChatTimelineItems([turn([row(1), retained])]);
		expect(after[1]?.key).toBe(before[0]?.key);
	});

	it("keeps consecutive tools grouped and the active turn footer absent", () => {
		const tools = [row(1), row(2)];
		for (const tool of tools) {
			tool.timeline.item.body = {
				type: "tool",
				toolCallId: tool.key,
				name: "Read",
				state: "completed",
				input: null,
				output: null,
			};
		}
		const items = agentChatTimelineItems([
			{ ...turn([...tools, row(3)]), state: "active" },
		]);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			kind: "segment",
			segment: { kind: "tools", rows: tools },
		});
	});
});

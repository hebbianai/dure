import {
	type AgentChatRowSegment,
	type AgentChatTranscriptBlock,
	type AgentChatTurnBlock,
	segmentAgentChatRows,
	segmentTranscriptBlocks,
} from "@/lib/agents/chat/agentChatProjection";

export type AgentChatTimelineItem =
	| {
			kind: "segment";
			key: string;
			segment: AgentChatRowSegment;
			turn: AgentChatTurnBlock | null;
	  }
	| { kind: "footer"; key: string; turn: AgentChatTurnBlock };

/** A turn can itself be arbitrarily long. Window its message/tool segments,
 * keeping the footer's copy action backed by the complete projected turn. */
export function agentChatTimelineItems(
	transcript: readonly AgentChatTranscriptBlock[],
): AgentChatTimelineItem[] {
	return segmentTranscriptBlocks(transcript).flatMap((entry) => {
		if (entry.kind === "tools") {
			return [{ kind: "segment", key: entry.key, segment: entry, turn: null }];
		}
		if (entry.block.kind === "row") {
			const { key, row } = entry.block;
			return [
				{
					kind: "segment",
					key,
					segment: { kind: "single", key, row },
					turn: null,
				},
			];
		}
		const turn = entry.block;
		const items: AgentChatTimelineItem[] = segmentAgentChatRows(turn.rows).map(
			(segment) => ({ kind: "segment", key: segment.key, segment, turn }),
		);
		if (turn.state !== "active") {
			items.push({ kind: "footer", key: `footer:${turn.key}`, turn });
		}
		return items;
	});
}

/**
 * The last answer of each agent home lists as recently finished, read from
 * the computer that runs it.
 *
 * The answer is the conversation's `final_response`: the computer's own
 * transcript reader marks it, and only while the agent's latest turn is
 * complete. It is asked with `limit: 0`, which carries that answer and the
 * cursor and no messages, and with the previous cursor, so a turn that has not
 * moved is answered `unchanged` without the computer reading the transcript.
 *
 * Transcripts stay out of the catalog on purpose (reading one scans a provider
 * file), so this asks only for the few agents home shows, and once per
 * finished turn: again only when the row's activity or process moves.
 */

import type { FinishedCard } from "./homeProjection";
import type { ConversationCursor, ConversationTranscriptAnswer } from "./ipc";
import { chatBlocks, type ChatInline } from "./chatMarkdown";

/** Longer first lines are cut here; the card shows one line anyway. */
const MAX_LINE_CHARS = 280;

export interface FinalResponseReader {
	/**
	 * Home lists these finished agents: read each one's answer, once per turn.
	 * An agent no longer listed is forgotten, so when it finishes again its
	 * card waits for the new answer instead of showing the last one.
	 */
	observe(cards: readonly FinishedCard[]): void;
	/** The first line of each listed agent's answer, by card key, as far as read. */
	lines(): Readonly<Record<string, string>>;
	dispose(): void;
}

interface Entry {
	/** The agent as home last listed it: a read asks for this one. */
	card: FinishedCard;
	/** That row's activity and process, which a read answers for. */
	observed: string;
	cursor?: ConversationCursor;
	line?: string;
	reading: boolean;
	/** The row moved while a read was out: read once more when it lands. */
	again: boolean;
}

/**
 * @param read asks the card's computer for its conversation's final response.
 * @param changed is told, after a read lands, that `lines()` changed.
 */
export function createFinalResponseReader(options: {
	readonly read: (
		card: FinishedCard,
		after: ConversationCursor | undefined,
	) => Promise<ConversationTranscriptAnswer>;
	readonly changed: () => void;
}): FinalResponseReader {
	const entries = new Map<string, Entry>();
	let disposed = false;

	const lines = (): Record<string, string> => {
		const known: Record<string, string> = {};
		for (const [key, entry] of entries) if (entry.line) known[key] = entry.line;
		return known;
	};

	function read(entry: Entry): void {
		const { key } = entry.card;
		entry.reading = true;
		void options.read(entry.card, entry.cursor).then(
			(answer) => {
				if (disposed || entries.get(key) !== entry) return;
				entry.reading = false;
				const before = entry.line;
				if (answer.outcome === "transcript") {
					entry.cursor = answer.cursor ?? undefined;
					entry.line = answer.final_response
						? answerLine(answer.final_response)
						: undefined;
				} else if (answer.outcome === "refused") {
					entry.cursor = undefined;
					entry.line = undefined;
				}
				if (entry.again) {
					entry.again = false;
					read(entry);
				}
				if (entry.line !== before) options.changed();
			},
			() => {
				if (disposed || entries.get(key) !== entry) return;
				// Lost on the way: the next look at home asks again.
				entry.reading = false;
				entry.again = false;
				entry.observed = "";
			},
		);
	}

	return {
		observe(cards) {
			if (disposed) return;
			const shown = new Set(cards.map((card) => card.key));
			for (const key of entries.keys()) if (!shown.has(key)) entries.delete(key);
			for (const card of cards) {
				const observed = JSON.stringify([
					card.view.activityAt,
					card.source.session.terminal_epoch,
				]);
				const entry = entries.get(card.key);
				if (!entry) {
					const created: Entry = { card, observed, reading: false, again: false };
					entries.set(card.key, created);
					read(created);
					continue;
				}
				entry.card = card;
				if (entry.observed === observed) continue;
				entry.observed = observed;
				if (entry.reading) entry.again = true;
				else read(entry);
			}
		},
		lines,
		dispose() {
			disposed = true;
			entries.clear();
		},
	};
}

/**
 * The first line of an answer as plain text: its first paragraph's first
 * line, its first list item, or its first code line, through the chat's own
 * reading of the agent's markdown, so a heading's `#` or a `**` never shows.
 */
export function answerLine(text: string): string | undefined {
	const plain = (inline: readonly ChatInline[]) =>
		inline.map((span) => span.text).join("");
	for (const block of chatBlocks(text)) {
		const source =
			block.kind === "paragraph"
				? plain(block.inline)
				: block.kind === "list"
					? block.items.map(plain).join("\n")
					: block.text;
		const line = source
			.split("\n")
			.map((candidate) => candidate.replace(/\s+/g, " ").trim())
			.find(Boolean);
		if (line) return [...line].slice(0, MAX_LINE_CHARS).join("");
	}
	return undefined;
}

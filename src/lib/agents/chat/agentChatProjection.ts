import type {
	AgentInteractionBindingV1,
	AgentTimelineActiveTurnV1,
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import { presentLifecycleRow } from "@/lib/agents/chat/lifecycleRowPresentation";
import {
	parseTurnFailureReason,
	type TurnFailureReason,
} from "@/lib/agents/chat/turnFailureReason";

export type AgentChatActiveTurnV1 = AgentTimelineActiveTurnV1;

type AgentChatTurnState =
	| "active"
	| "completed"
	| "failed"
	| "canceled"
	| "interrupted";

export interface AgentChatTurnBlock {
	kind: "turn";
	/** Presentation-span identity anchored to its first canonical timeline row.
	 * One logical turn can have another span after a terminal runtime boundary
	 * when provider history is backfilled. */
	key: string;
	turnId: string | null;
	clientMessageId: string | null;
	rows: AgentChatProjectedRow[];
	state: AgentChatTurnState;
	/** Why a failed turn failed, when its terminal row carried the shared
	 * reason token; absent for every other state. */
	failureReason?: TurnFailureReason;
	assistantMarkdown: string;
	/** Wall-clock span between the turn's durable start and terminal lifecycle
	 * rows — real backend timestamps, never invented; null while active or when
	 * the start fell outside the loaded page. */
	workedMs: number | null;
}

export interface AgentChatProjectedRow {
	key: string;
	revision: string;
	timeline: AgentTimelineRowV1;
}

export type AgentChatRowSegment =
	| { kind: "tools"; key: string; rows: AgentChatProjectedRow[] }
	| { kind: "single"; key: string; row: AgentChatProjectedRow };

/** Groups consecutive tool rows into one work segment so the transcript can
 * render them as a single strip instead of a stack of separate cards. Purely
 * presentational — row identity, order, and folding are untouched. */
export function segmentAgentChatRows(
	rows: readonly AgentChatProjectedRow[],
): AgentChatRowSegment[] {
	const segments: AgentChatRowSegment[] = [];
	for (const row of rows) {
		const last = segments[segments.length - 1];
		if (row.timeline.item.body.type !== "tool") {
			segments.push({ kind: "single", key: row.key, row });
		} else if (last?.kind === "tools") {
			last.rows.push(row);
		} else {
			segments.push({ kind: "tools", key: `tools:${row.key}`, rows: [row] });
		}
	}
	return segments;
}

interface AgentChatStandaloneRowBlock {
	kind: "row";
	key: string;
	row: AgentChatProjectedRow;
}

export type AgentChatTranscriptBlock =
	| AgentChatTurnBlock
	| AgentChatStandaloneRowBlock;

export type AgentChatBlockSegment =
	| { kind: "block"; block: AgentChatTranscriptBlock }
	| { kind: "tools"; key: string; rows: AgentChatProjectedRow[] };

/** Merges consecutive standalone tool blocks (rows that fell outside any
 * projected turn) into one burst segment, mirroring the in-turn grouping. */
export function segmentTranscriptBlocks(
	blocks: readonly AgentChatTranscriptBlock[],
): AgentChatBlockSegment[] {
	const segments: AgentChatBlockSegment[] = [];
	for (const block of blocks) {
		const last = segments[segments.length - 1];
		if (block.kind === "row" && block.row.timeline.item.body.type === "tool") {
			if (last?.kind === "tools") {
				last.rows.push(block.row);
			} else {
				segments.push({
					kind: "tools",
					key: `tools:${block.key}`,
					rows: [block.row],
				});
			}
		} else {
			segments.push({ kind: "block", block });
		}
	}
	return segments;
}

export interface AgentChatTranscriptTailFacts {
	/** Key of the newest user message row — the only undimmed prompt chip. */
	lastUserKey: string | null;
	/** Exact turn + tool target inside the controller-authoritative active turn. */
	activeTurnRunningTool: {
		turnId: string;
		clientMessageId: string;
		toolKey: string;
	} | null;
	/** When the newest user message landed — the live turn's elapsed-time
	 * base, same durable timestamp workedMs uses after completion. */
	lastUserAtMs: number | null;
}

export function transcriptTailFacts(
	blocks: readonly AgentChatTranscriptBlock[],
	activeTurn?: AgentChatActiveTurnV1,
): AgentChatTranscriptTailFacts {
	let lastUserKey: string | null = null;
	let lastUserAtMs: number | null = null;
	let activeTurnRunningTool: {
		turnId: string;
		clientMessageId: string;
		toolKey: string;
	} | null = null;
	for (const block of blocks) {
		const matchesActiveTurn =
			block.kind === "turn" &&
			block.state === "active" &&
			activeTurn !== undefined &&
			block.turnId === activeTurn.turnId &&
			block.clientMessageId === activeTurn.clientMessageId;
		if (matchesActiveTurn) activeTurnRunningTool = null;
		const rows = block.kind === "turn" ? block.rows : [block.row];
		for (const row of rows) {
			const { body } = row.timeline.item;
			if (body.type === "message" && body.role === "user") {
				lastUserKey = row.key;
				lastUserAtMs = row.timeline.item.createdAtMs;
			}
			if (
				matchesActiveTurn &&
				body.type === "tool" &&
				body.state === "running"
			) {
				activeTurnRunningTool = {
					turnId: activeTurn.turnId,
					clientMessageId: activeTurn.clientMessageId,
					toolKey: row.key,
				};
			}
		}
	}
	return { lastUserKey, activeTurnRunningTool, lastUserAtMs };
}

interface PendingTurn {
	key: string;
	turnId: string | null;
	clientMessageId: string | null;
	startedAtMs: number | null;
	rows: AgentTimelineRowV1[];
	session: TurnSessionSpan;
}

const SESSION_LIFECYCLE_STATES = new Set([
	"session_ready",
	"session_failed",
	"session_exited",
]);

/** Session run bookkeeping for one open turn. A turn is served by exactly one
 * provider session run: the first session_ready after a turn starts on a down
 * session is that turn's own lazy runtime spawn; every other session
 * transition proves the runtime serving the turn is gone, so its terminal
 * lifecycle row can never arrive and the turn must project as interrupted
 * instead of live (a lost terminal row once kept a pane on "Responding" for
 * 29 hours). */
interface TurnSessionSpan {
	sessionWasUp: boolean;
	sawSpawn: boolean;
}

function sessionTransitionInterruptsTurn(
	state: string,
	span: TurnSessionSpan,
): boolean {
	if (state !== "session_ready") return true;
	return span.sessionWasUp || span.sawSpawn;
}

const TERMINAL_TURN_STATES = new Map<
	string,
	Exclude<AgentChatTurnState, "active">
>([
	["turn_completed", "completed"],
	["turn_failed", "failed"],
	["turn_canceled", "canceled"],
]);

function terminalTurnState(
	row: AgentTimelineRowV1,
): Exclude<AgentChatTurnState, "active"> | undefined {
	const body = row.item.body;
	return body.type === "lifecycle"
		? TERMINAL_TURN_STATES.get(body.state)
		: undefined;
}

function rowMatchesTurn(row: AgentTimelineRowV1, turn: PendingTurn): boolean {
	const { turnId, clientMessageId } = row.item;
	return (
		(turnId !== null || clientMessageId !== null) &&
		(turnId === null || turn.turnId === turnId) &&
		(clientMessageId === null || turn.clientMessageId === clientMessageId)
	);
}

function repeatsActiveTurnStart(
	row: AgentTimelineRowV1,
	turn: PendingTurn,
): boolean {
	const { turnId, clientMessageId } = row.item;
	return (
		(turnId !== null || clientMessageId !== null) &&
		turnId === turn.turnId &&
		clientMessageId === turn.clientMessageId
	);
}

function timelineRevision(row: AgentTimelineRowV1): string {
	return `${row.cursor.epoch}:${row.cursor.sequence}`;
}

function foldToolSnapshots(
	rows: readonly AgentTimelineRowV1[],
): AgentChatProjectedRow[] {
	const projected: AgentChatProjectedRow[] = [];
	const projectedToolByCallId = new Map<
		string,
		{ position: number; row: AgentChatProjectedRow }
	>();
	for (const row of rows) {
		const body = row.item.body;
		if (body.type !== "tool") {
			projected.push({
				key: `timeline:${timelineRevision(row)}`,
				revision: timelineRevision(row),
				timeline: row,
			});
			continue;
		}
		const projectedTool = projectedToolByCallId.get(body.toolCallId);
		if (!projectedTool) {
			const first = {
				key: `tool:${body.toolCallId}`,
				revision: timelineRevision(row),
				timeline: row,
			};
			projectedToolByCallId.set(body.toolCallId, {
				position: projected.length,
				row: first,
			});
			projected.push(first);
		} else {
			const previous = projectedTool.row;
			const previousBody = previous.timeline.item.body;
			const input =
				body.input ??
				(previousBody.type === "tool" ? previousBody.input : null);
			const output =
				body.output ??
				(previousBody.type === "tool" ? previousBody.output : null);
			const next = {
				key: previous.key,
				revision: `${previous.revision}|${timelineRevision(row)}`,
				timeline:
					input === body.input && output === body.output
						? row
						: {
								...row,
								item: {
									...row.item,
									body: { ...body, input, output },
								},
							},
			};
			projectedTool.row = next;
			projected[projectedTool.position] = next;
		}
	}
	return projected;
}

function finishTurn(
	turn: PendingTurn,
	state: AgentChatTurnState,
	endedAtMs: number | null = null,
	terminalRow?: AgentTimelineRowV1,
): AgentChatTurnBlock {
	const rows = foldToolSnapshots(turn.rows);
	const failureReason =
		state === "failed" && terminalRow?.item.body.type === "lifecycle"
			? parseTurnFailureReason(terminalRow.item.body.detail)
			: undefined;
	return {
		kind: "turn",
		key: turn.key,
		turnId: turn.turnId,
		clientMessageId: turn.clientMessageId,
		rows,
		state,
		...(failureReason ? { failureReason } : {}),
		workedMs:
			state !== "active" && turn.startedAtMs !== null && endedAtMs !== null
				? Math.max(0, endedAtMs - turn.startedAtMs)
				: null,
		assistantMarkdown: rows
			.flatMap(({ timeline }) => {
				const body = timeline.item.body;
				return body.type === "message" && body.role === "assistant"
					? [body.markdown.trim()]
					: [];
			})
			.filter(Boolean)
			.join("\n\n"),
	};
}

function isTurnContent(row: AgentTimelineRowV1): boolean {
	switch (row.item.body.type) {
		case "message":
		case "goal_continuation":
		case "pending_answer":
		case "reasoning":
		case "tool":
		case "tool_input":
		case "plan":
		case "error":
			return true;
		default:
			return false;
	}
}

/** Projects the canonical flat timeline into presentation-only turn blocks.
 * Providers are still free to omit turn IDs from assistant/tool events: the
 * conversation contract permits one active turn, so unkeyed rows between its
 * durable start and terminal lifecycle belong to that turn. Unknown provider
 * evidence remains durable but is intentionally absent from the transcript. */
export function projectAgentChatTranscript(
	rows: readonly AgentTimelineRowV1[],
): AgentChatTranscriptBlock[] {
	const blocks: AgentChatTranscriptBlock[] = [];
	let active: PendingTurn | undefined;
	let sessionUp = false;
	let partialRows: AgentTimelineRowV1[] = [];
	let partialAnchor = "head";
	const flushPartialRows = () => {
		blocks.push(
			...foldToolSnapshots(partialRows).map(
				(row): AgentChatStandaloneRowBlock => ({
					kind: "row",
					key: JSON.stringify(["partial", partialAnchor, row.key]),
					row,
				}),
			),
		);
		partialRows = [];
	};

	for (const row of rows) {
		const body = row.item.body;
		if (body.type === "provider_evidence") continue;

		if (body.type === "lifecycle" && body.state === "turn_started") {
			if (active && repeatsActiveTurnStart(row, active)) continue;
			flushPartialRows();
			if (active) blocks.push(finishTurn(active, "active"));
			active = {
				key: timelineRevision(row),
				turnId: row.item.turnId,
				clientMessageId: row.item.clientMessageId,
				startedAtMs: row.item.createdAtMs,
				rows: [],
				session: { sessionWasUp: sessionUp, sawSpawn: false },
			};
			continue;
		}

		if (body.type === "lifecycle" && SESSION_LIFECYCLE_STATES.has(body.state)) {
			if (
				active &&
				sessionTransitionInterruptsTurn(body.state, active.session)
			) {
				blocks.push(finishTurn(active, "interrupted"));
				active = undefined;
			} else if (active) {
				active.session.sawSpawn = true;
			}
			sessionUp = body.state === "session_ready";
			// Falls through: an in-flight lazy spawn stays inside its turn's
			// rows; a superseding transition renders standalone below.
		}

		const terminalState = terminalTurnState(row);
		if (active && terminalState && rowMatchesTurn(row, active)) {
			blocks.push(finishTurn(active, terminalState, row.item.createdAtMs, row));
			active = undefined;
			partialAnchor = timelineRevision(row);
			continue;
		}
		if (!active && terminalState && partialRows.length > 0) {
			blocks.push(
				finishTurn(
					{
						key: timelineRevision(partialRows[0] ?? row),
						turnId: row.item.turnId,
						clientMessageId: row.item.clientMessageId,
						startedAtMs: null,
						rows: partialRows,
						session: { sessionWasUp: sessionUp, sawSpawn: false },
					},
					terminalState,
					null,
					row,
				),
			);
			partialRows = [];
			partialAnchor = timelineRevision(row);
			continue;
		}

		if (active) {
			active.rows.push(row);
		} else if (isTurnContent(row)) {
			partialRows.push(row);
		} else {
			flushPartialRows();
			const [projected] = foldToolSnapshots([row]);
			if (
				projected &&
				(body.type !== "lifecycle" ||
					presentLifecycleRow(body.state, body.detail).kind !== "hidden")
			) {
				blocks.push({
					kind: "row",
					key: `standalone:${projected.key}`,
					row: projected,
				});
			}
			partialAnchor = timelineRevision(row);
		}
	}

	if (active) blocks.push(finishTurn(active, "active"));
	flushPartialRows();
	return blocks;
}

function sameRuntimeAuthority(
	left: AgentInteractionBindingV1,
	right: AgentInteractionBindingV1,
): boolean {
	const sameExecutionProfile =
		left.executionProfile.kind === right.executionProfile.kind &&
		(left.executionProfile.kind === "provider_default" ||
			(right.executionProfile.kind === "credential_reference" &&
				left.executionProfile.reference_id ===
					right.executionProfile.reference_id &&
				left.executionProfile.credential_generation ===
					right.executionProfile.credential_generation));
	return (
		left.schemaVersion === right.schemaVersion &&
		left.interactionSessionId === right.interactionSessionId &&
		left.agentId === right.agentId &&
		left.providerId === right.providerId &&
		sameExecutionProfile &&
		(left.providerConversationRef === null ||
			right.providerConversationRef === null ||
			left.providerConversationRef === right.providerConversationRef) &&
		left.runtime.runtimeGeneration === right.runtime.runtimeGeneration &&
		left.runtime.providerEpoch === right.runtime.providerEpoch &&
		left.timelineEpoch === right.timelineEpoch &&
		left.createdAtMs === right.createdAtMs
	);
}

function assertExpectedAgentChatPage(
	page: AgentTimelinePageV1,
	expected: { agentId: string; interactionSessionId: string },
): void {
	if (
		page.binding.agentId !== expected.agentId ||
		page.binding.interactionSessionId !== expected.interactionSessionId
	) {
		throw new Error("agent_chat_binding_mismatch");
	}
}

/** A complete authoritative tail snapshot replaces the local projection. A
 * response that finished after a newer read is harmlessly ignored. */
export function convergeAgentChatPage(
	current: AgentTimelinePageV1 | undefined,
	next: AgentTimelinePageV1,
	expected: { agentId: string; interactionSessionId: string },
): AgentTimelinePageV1 {
	assertExpectedAgentChatPage(next, expected);
	if (!current) return next;
	if (next.binding.bindingRevision < current.binding.bindingRevision) {
		return current;
	}
	if (
		next.binding.bindingRevision === current.binding.bindingRevision &&
		!sameRuntimeAuthority(current.binding, next.binding)
	) {
		throw new Error("agent_chat_runtime_fence_conflict");
	}
	if (
		next.binding.timelineEpoch === current.binding.timelineEpoch &&
		next.finalCursor.sequence < current.finalCursor.sequence
	) {
		return current;
	}
	return next;
}

function sameTimelineRow(
	left: AgentTimelineRowV1,
	right: AgentTimelineRowV1,
): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Prepends one authoritative `before` page without letting the historical
 * read replace a newer live head. `requested` is the snapshot whose oldest
 * cursor formed the request; retaining it closes the seam if an `after` read
 * advanced and trimmed that cursor while the history request was in flight. */
export function convergeAgentChatHistory(
	current: AgentTimelinePageV1,
	requested: AgentTimelinePageV1,
	older: AgentTimelinePageV1,
	expected: { agentId: string; interactionSessionId: string },
): AgentTimelinePageV1 {
	assertExpectedAgentChatPage(current, expected);
	assertExpectedAgentChatPage(requested, expected);
	assertExpectedAgentChatPage(older, expected);
	if (
		!sameRuntimeAuthority(current.binding, requested.binding) ||
		!sameRuntimeAuthority(current.binding, older.binding)
	) {
		throw new Error("agent_chat_runtime_fence_conflict");
	}
	const requestedCursor = requested.rows[0]?.cursor;
	if (
		!requestedCursor ||
		requestedCursor.epoch !== current.binding.timelineEpoch
	) {
		throw new Error("agent_chat_history_cursor_unavailable");
	}
	if (
		older.rows.some(
			(row) =>
				row.cursor.epoch !== requestedCursor.epoch ||
				row.cursor.sequence >= requestedCursor.sequence,
		) ||
		older.finalCursor.epoch !== requestedCursor.epoch ||
		older.finalCursor.sequence !==
			(older.rows[0]?.cursor.sequence ?? requestedCursor.sequence) ||
		(older.hasMore && older.rows.length === 0)
	) {
		throw new Error("agent_chat_history_cursor_invalid");
	}

	const bySequence = new Map<number, AgentTimelineRowV1>();
	for (const row of [...older.rows, ...requested.rows, ...current.rows]) {
		const existing = bySequence.get(row.cursor.sequence);
		if (existing && !sameTimelineRow(existing, row)) {
			throw new Error("agent_chat_history_row_conflict");
		}
		bySequence.set(row.cursor.sequence, existing ?? row);
	}
	const rows = [...bySequence.values()].sort(
		(left, right) => left.cursor.sequence - right.cursor.sequence,
	);
	if (
		rows.some(
			(row) =>
				row.cursor.epoch !== current.binding.timelineEpoch ||
				row.cursor.sequence > current.finalCursor.sequence,
		)
	) {
		throw new Error("agent_chat_history_sequence_invalid");
	}
	return {
		...current,
		binding:
			older.binding.bindingRevision > current.binding.bindingRevision
				? older.binding
				: current.binding,
		rows,
		hasMore: older.hasMore,
	};
}

/** Converges one cursor-relative `after` page onto the retained tail. Unlike a
 * complete tail read, the delta cannot replace runtime authority or historical
 * rows. Live text, pending requests, and the active turn are complete
 * replaceable snapshots on every read; durable rows append monotonically under
 * the caller's retention policy. */
export function convergeAgentChatDelta(
	current: AgentTimelinePageV1,
	delta: AgentTimelinePageV1,
	expected: { agentId: string; interactionSessionId: string },
	maximumRows?: number,
): AgentTimelinePageV1 {
	assertExpectedAgentChatPage(delta, expected);
	if (!sameRuntimeAuthority(current.binding, delta.binding)) {
		throw new Error("agent_chat_runtime_fence_conflict");
	}
	if (delta.binding.bindingRevision < current.binding.bindingRevision) {
		return current;
	}
	if (delta.finalCursor.sequence < current.finalCursor.sequence) return current;

	let sequence = current.finalCursor.sequence;
	for (const row of delta.rows) {
		if (
			row.cursor.epoch !== current.binding.timelineEpoch ||
			row.cursor.sequence <= sequence
		) {
			throw new Error("agent_chat_delta_sequence_invalid");
		}
		sequence = row.cursor.sequence;
	}
	if (
		sequence !== delta.finalCursor.sequence ||
		(delta.hasMore && delta.rows.length === 0)
	) {
		throw new Error("agent_chat_delta_cursor_invalid");
	}

	const combinedRows =
		delta.rows.length === 0 ? current.rows : [...current.rows, ...delta.rows];
	const rows =
		maximumRows !== undefined && combinedRows.length > maximumRows
			? combinedRows.slice(-maximumRows)
			: combinedRows;
	return {
		...delta,
		rows,
		hasMore:
			current.hasMore ||
			(maximumRows !== undefined && combinedRows.length > maximumRows),
	};
}

export function activeAgentChatTurn(
	page: AgentTimelinePageV1 | undefined,
): AgentChatActiveTurnV1 | undefined {
	return page?.activeTurn ?? undefined;
}

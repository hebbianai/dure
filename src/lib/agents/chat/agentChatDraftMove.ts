import type {
	AgentChatDraftMove,
	AgentChatDraftMoveOperation,
	AgentChatDraftMoveReceipt,
	AgentChatDraftStoreSlice,
	AgentChatDraftTransfer,
} from "./agentChatDraftTypes";

export type {
	AgentChatDraftMove,
	AgentChatDraftMoveOperation,
	AgentChatDraftMoveReceipt,
	AgentChatDraftPacket,
	AgentChatDrafts,
	AgentChatDraftTransfer,
} from "./agentChatDraftTypes";

export function sameDraftTransfer(
	a: AgentChatDraftTransfer,
	b: AgentChatDraftTransfer,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The moves a workspace still has to show recovery for: those it is the
 * source or the destination of. A departed marker is bookkeeping for the
 * window the draft left, not a move anyone can still act on. */
export function pendingAgentChatDraftMoves(
	moves: Readonly<Record<string, AgentChatDraftMove>>,
	desktopId: string,
): AgentChatDraftMove[] {
	return Object.values(moves).filter(
		(move) =>
			move.role !== "departed" &&
			(move.role === "source"
				? move.transfer.source.desktopId
				: move.transfer.destination.desktopId) === desktopId,
	);
}

/** Keeping the draft at its source is offered only while nothing irreversible
 * has happened: the destination layout has not committed and no receipt says
 * the draft already moved. */
export function agentChatDraftMoveCancellable(
	move: AgentChatDraftMove,
	receipt: AgentChatDraftMoveReceipt | undefined,
): boolean {
	return (
		!move.layoutCommitted &&
		receipt?.status !== "moved" &&
		receipt?.status !== "committed"
	);
}

/** Only this volatile slice changes draft ownership. Layout and runtime remain
 * separate authorities; callers validate them before invoking these transitions. */
export function reduceAgentChatDraftMove(
	state: AgentChatDraftStoreSlice,
	operation: AgentChatDraftMoveOperation,
): Partial<AgentChatDraftStoreSlice> {
	const transfer =
		"packet" in operation ? operation.packet.transfer : operation.transfer;
	const agentId = transfer.target.identity.agentId;
	const move = state.chatDraftMoves[agentId];
	const previous = state.chatDraftMoveReceipts[transfer.id];
	const fail = () => {
		throw new Error(
			"The chat draft transfer changed or conflicts with another draft.",
		);
	};
	const receipt = (
		status: AgentChatDraftMoveReceipt["status"],
	): AgentChatDraftMoveReceipt => ({
		kind: "draft_move",
		id: transfer.id,
		digest: transfer.digest,
		status,
		...(previous?.dropReceipt
			? {
					dropReceipt: previous.dropReceipt,
					dropPosition: previous.dropPosition,
				}
			: {}),
	});
	const matching = move && sameDraftTransfer(move.transfer, transfer);
	if (previous && previous.digest !== transfer.digest) return fail();
	if (operation.action === "begin") {
		if (move || previous || state.chatDrafts[agentId] !== operation.expected)
			return fail();
		return {
			chatDraftMoves: {
				...state.chatDraftMoves,
				[agentId]: { transfer, role: "source" },
			},
		};
	}
	if (operation.action === "mark_moved") {
		if (!matching || move.role !== "source") return fail();
		return {
			chatDraftMoves: {
				...state.chatDraftMoves,
				[agentId]: { ...move, layoutCommitted: true },
			},
		};
	}
	if (operation.action === "release") {
		if (
			!matching ||
			move.role !== "source" ||
			operation.receipt.id !== transfer.id ||
			operation.receipt.digest !== transfer.digest ||
			!["committed", "aborted"].includes(operation.receipt.status)
		)
			return fail();
		const chatDraftMoves = { ...state.chatDraftMoves };
		if (operation.receipt.status === "aborted") {
			delete chatDraftMoves[agentId];
			return { chatDraftMoves };
		}
		chatDraftMoves[agentId] = { transfer, role: "departed" };
		const chatDrafts = { ...state.chatDrafts };
		delete chatDrafts[agentId];
		return { chatDraftMoves, chatDrafts };
	}
	// Completed replay is a read. It must never restore an old snapshot over a
	// newer destination edit, even after the pane has moved again.
	if (
		previous &&
		(previous.status === "committed" || previous.status === "aborted")
	)
		return {};
	if (operation.action === "record_drop") {
		if (
			!matching ||
			move.role !== "destination" ||
			!previous ||
			operation.receipt.error ||
			operation.receipt.movedPanelIds.length !== 1 ||
			operation.receipt.movedPanelIds[0] !== transfer.source.paneId
		)
			return fail();
		if (previous.dropReceipt) return {};
		return {
			chatDraftMoveReceipts: {
				...state.chatDraftMoveReceipts,
				[transfer.id]: {
					...receipt("moved"),
					dropReceipt: operation.receipt,
					dropPosition: operation.position,
				},
			},
		};
	}
	if (operation.action === "stage") {
		if (previous) {
			if (!matching || move.role !== "destination") return fail();
			return {};
		}
		if (
			(move && move.role !== "departed") ||
			Object.keys(state.chatDrafts[agentId] ?? {}).length
		)
			return fail();
		return {
			chatDraftMoves: {
				...state.chatDraftMoves,
				[agentId]: {
					transfer,
					role: "destination",
					drafts: operation.packet.drafts,
					previousDeparture:
						move?.role === "departed" ? move.transfer : undefined,
				},
			},
			chatDraftMoveReceipts: {
				...state.chatDraftMoveReceipts,
				[transfer.id]: receipt("staged"),
			},
		};
	}
	if (operation.action === "abort") {
		if (previous?.status === "moved") return {};
		if (move && !matching && move.role !== "departed") return fail();
		if (matching && move.role !== "destination") return fail();
		const chatDraftMoves = { ...state.chatDraftMoves };
		if (matching) {
			if (move.previousDeparture)
				chatDraftMoves[agentId] = {
					role: "departed",
					transfer: move.previousDeparture,
				};
			else delete chatDraftMoves[agentId];
		}
		return {
			chatDraftMoves,
			chatDraftMoveReceipts: {
				...state.chatDraftMoveReceipts,
				[transfer.id]: receipt("aborted"),
			},
		};
	}
	if (
		!matching ||
		move.role !== "destination" ||
		!move.drafts ||
		(previous?.status !== "staged" && previous?.status !== "moved")
	)
		return fail();
	const chatDraftMoves = { ...state.chatDraftMoves };
	delete chatDraftMoves[agentId];
	return {
		chatDraftMoves,
		chatDrafts: { ...state.chatDrafts, [agentId]: move.drafts },
		chatDraftMoveReceipts: {
			...state.chatDraftMoveReceipts,
			[transfer.id]: receipt("committed"),
		},
	};
}

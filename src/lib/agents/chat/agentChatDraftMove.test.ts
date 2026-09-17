import { expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
	type AgentChatDraftMove,
	type AgentChatDraftMoveReceipt,
	type AgentChatDraftPacket,
	agentChatDraftMoveCancellable,
	pendingAgentChatDraftMoves,
} from "./agentChatDraftMove";
import {
	draftTransferDigest,
	parseAgentChatDraftMoveRequest,
} from "./agentChatDraftMoveRequest";
import {
	type AgentChatDraftStoreSlice,
	agentChatDraftEditable,
	agentChatDraftKey,
	createAgentChatDraftStoreSlice,
} from "./agentChatDraftStoreSlice";

const identity = {
	agentId: "chat",
	backendProfileId: "local",
	interactionSessionId: "conversation",
};
const key = agentChatDraftKey(identity);
function store() {
	return createStore<AgentChatDraftStoreSlice>((set) =>
		createAgentChatDraftStoreSlice(set),
	);
}
async function fixture() {
	const source = store();
	const destination = store();
	source.getState().updateChatDraft(identity, () => ({
		text: "한글 초안\n ",
		attachments: [{ fileName: "이미지.png", dataB64: "cHJpdmF0ZS1pbWFnZQ==" }],
	}));
	source
		.getState()
		.updateChatDraft({ ...identity, interactionSessionId: "older" }, () => ({
			text: " ".repeat(270_000),
			attachments: Array.from({ length: 7 }, (_, i) => ({
				fileName: `${i}.png`,
				dataB64: "aW1hZ2U=",
			})),
		}));
	const expected = source.getState().chatDrafts.chat;
	const request = parseAgentChatDraftMoveRequest({
		step: "stage",
		transfer: {
			id: "transfer-1",
			digest: `sha256:${"0".repeat(64)}`,
			target: {
				identity,
				sessionId: "runtime",
				projectId: "project",
				provider: "codex",
				worktreePath: "/repo",
			},
			source: {
				schemaVersion: 1,
				desktopId: "source",
				dockviewId: "dock-1",
				windowLabel: "main",
				windowGeneration: "boot-1",
				paneId: "agent:chat",
			},
			destination: {
				schemaVersion: 1,
				desktopId: "target",
				dockviewId: "dock-2",
				windowLabel: "win-popout-target",
				windowGeneration: "boot-2",
			},
		},
		drafts: expected,
	});
	if (request?.step !== "stage") throw new Error("invalid fixture");
	const packet: AgentChatDraftPacket = {
		...request,
		transfer: {
			...request.transfer,
			digest: await draftTransferDigest(request.transfer, request.drafts),
		},
	};
	return { source, destination, expected, packet, transfer: packet.transfer };
}

it("moves every conversation and exact composed bytes between independent stores with only one editable copy", async () => {
	const { source, destination, expected, packet, transfer } = await fixture();
	source.getState().applyChatDraftMove({ action: "begin", packet, expected });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	expect(source.getState().chatDrafts.chat).toBe(expected);
	expect(destination.getState().chatDrafts).toEqual({});
	for (const state of [source, destination])
		expect(() =>
			state.getState().updateChatDraft(identity, (draft) => ({
				...draft,
				text: "too early",
			})),
		).toThrow("moving");
	destination.getState().applyChatDraftMove({ action: "commit", transfer });
	expect(destination.getState().chatDrafts.chat).toEqual(expected);
	destination.getState().updateChatDraft(identity, (draft) => ({
		...draft,
		text: "새 창에서 편집",
	}));
	expect(() =>
		source.getState().updateChatDraft(identity, (draft) => draft),
	).toThrow("moving");
	source.getState().applyChatDraftMove({
		action: "release",
		transfer,
		receipt: destination.getState().chatDraftMoveReceipts[transfer.id],
	});
	expect(source.getState().chatDrafts.chat).toBeUndefined();
	expect(() =>
		source.getState().updateChatDraft(identity, (draft) => draft),
	).toThrow("moving");
	for (const action of ["commit", "abort"] as const)
		destination.getState().applyChatDraftMove({ action, transfer });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	expect(destination.getState().chatDrafts.chat[key].text).toBe(
		"새 창에서 편집",
	);
	expect(
		JSON.stringify(destination.getState().chatDraftMoveReceipts),
	).not.toContain("cHJpdmF0ZS1pbWFnZQ");
});

it("aborts a staged move without losing source bytes or allowing a delayed stage to resurrect it", async () => {
	const { source, destination, expected, packet, transfer } = await fixture();
	source.getState().applyChatDraftMove({ action: "begin", packet, expected });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	destination.getState().applyChatDraftMove({ action: "abort", transfer });
	source.getState().applyChatDraftMove({
		action: "release",
		transfer,
		receipt: destination.getState().chatDraftMoveReceipts[transfer.id],
	});
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	expect(destination.getState().chatDraftMoves).toEqual({});
	expect(destination.getState().chatDrafts).toEqual({});
	expect(source.getState().chatDrafts.chat).toBe(expected);
	source
		.getState()
		.updateChatDraft(identity, (draft) => ({ ...draft, text: "계속 작성" }));
	expect(source.getState().chatDrafts.chat[key].text).toBe("계속 작성");
});

it("records abort before stage and refuses to activate the later packet", async () => {
	const { destination, packet, transfer } = await fixture();
	destination.getState().applyChatDraftMove({ action: "abort", transfer });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	destination.getState().applyChatDraftMove({ action: "commit", transfer });
	expect(destination.getState().chatDrafts).toEqual({});
	expect(destination.getState().chatDraftMoveReceipts[transfer.id].status).toBe(
		"aborted",
	);
});

it("preserves both independent compositions when the destination has a conflicting draft", async () => {
	const { source, destination, expected, packet } = await fixture();
	destination
		.getState()
		.updateChatDraft(identity, () => ({ text: "독립 초안", attachments: [] }));
	expect(() =>
		destination.getState().applyChatDraftMove({ action: "stage", packet }),
	).toThrow("conflicts");
	expect(source.getState().chatDrafts.chat).toBe(expected);
	expect(destination.getState().chatDrafts.chat[key].text).toBe("독립 초안");
});

it("refuses a snapshot superseded while its digest was being prepared", async () => {
	const { source, expected, packet } = await fixture();
	source.getState().updateChatDraft(identity, (draft) => ({
		...draft,
		text: "해시 계산 중 편집",
	}));
	expect(() =>
		source.getState().applyChatDraftMove({ action: "begin", packet, expected }),
	).toThrow("changed");
	expect(source.getState().chatDraftMoves).toEqual({});
});

it("retains source data on an unrelated receipt and invalidates earlier asynchronous editors even after abort", async () => {
	const { source, destination, expected, packet, transfer } = await fixture();
	const before = source.getState().chatDraftEpochs.chat ?? 0;
	source.getState().applyChatDraftMove({ action: "begin", packet, expected });
	expect(() =>
		source.getState().applyChatDraftMove({
			action: "release",
			transfer,
			receipt: {
				kind: "draft_move",
				id: "other",
				digest: transfer.digest,
				status: "committed",
			},
		}),
	).toThrow();
	expect(source.getState().chatDrafts.chat).toBe(expected);
	destination.getState().applyChatDraftMove({ action: "abort", transfer });
	source.getState().applyChatDraftMove({
		action: "release",
		transfer,
		receipt: destination.getState().chatDraftMoveReceipts[transfer.id],
	});
	expect(source.getState().chatDraftEpochs.chat).toBeGreaterThan(before);
});

it("accepts a return transfer after departure and ignores the old committed packet", async () => {
	const { source, destination, expected, packet, transfer } = await fixture();
	source.getState().applyChatDraftMove({ action: "begin", packet, expected });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	destination.getState().applyChatDraftMove({ action: "commit", transfer });
	source.getState().applyChatDraftMove({
		action: "release",
		transfer,
		receipt: destination.getState().chatDraftMoveReceipts[transfer.id],
	});
	const returned = {
		transfer: {
			...transfer,
			id: "return-2",
			source: { ...transfer.destination, paneId: transfer.source.paneId },
			destination: transfer.source,
		},
		drafts: { [key]: { text: "돌아온 초안", attachments: [] } },
	};
	source.getState().applyChatDraftMove({ action: "stage", packet: returned });
	source
		.getState()
		.applyChatDraftMove({ action: "commit", transfer: returned.transfer });
	source.getState().updateChatDraft(identity, (draft) => ({
		...draft,
		text: "돌아온 뒤 편집",
	}));
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	expect(source.getState().chatDrafts.chat[key].text).toBe("돌아온 뒤 편집");
});

it("an aborted return preserves the original window's departure lock", async () => {
	const { source, destination, expected, packet, transfer } = await fixture();
	source.getState().applyChatDraftMove({ action: "begin", packet, expected });
	destination.getState().applyChatDraftMove({ action: "stage", packet });
	destination.getState().applyChatDraftMove({ action: "commit", transfer });
	source
		.getState()
		.applyChatDraftMove({
			action: "release",
			transfer,
			receipt: destination.getState().chatDraftMoveReceipts[transfer.id],
		});
	const returned = {
		transfer: {
			...transfer,
			id: "aborted-return",
			source: { ...transfer.destination, paneId: transfer.source.paneId },
			destination: transfer.source,
		},
		drafts: packet.drafts,
	};
	source.getState().applyChatDraftMove({ action: "stage", packet: returned });
	source
		.getState()
		.applyChatDraftMove({ action: "abort", transfer: returned.transfer });
	expect(source.getState().chatDraftMoves.chat).toEqual({
		role: "departed",
		transfer,
	});
	expect(() =>
		source
			.getState()
			.updateChatDraft(identity, (draft) => ({ ...draft, text: "stale pane" })),
	).toThrow("moving");
});
function move(
	role: "source" | "destination" | "departed",
	extra: Partial<Pick<AgentChatDraftMove, "layoutCommitted">> = {},
): AgentChatDraftMove {
	return {
		role,
		transfer: {
			id: "notice-transfer",
			digest: `sha256:${"a".repeat(64)}`,
			target: {
				identity,
				sessionId: "session",
				projectId: "project",
				provider: "claude",
				worktreePath: "/repo",
				project: undefined,
			},
			source: {
				schemaVersion: 1,
				desktopId: "source-space",
				dockviewId: "dock-1",
				paneId: "agent:chat",
				windowLabel: "main",
				windowGeneration: "boot-1",
			},
			destination: {
				schemaVersion: 1,
				desktopId: "target-space",
				dockviewId: "dock-2",
				windowLabel: "win-2",
				windowGeneration: "boot-2",
			},
		},
		...extra,
	};
}

it("shows a move only to the workspace that is its source or its destination", () => {
	const moves = {
		chat: move("source"),
		other: {
			...move("destination"),
			transfer: { ...move("destination").transfer, id: "other" },
		},
		gone: move("departed"),
	};
	expect(
		pendingAgentChatDraftMoves(moves, "source-space").map((m) => m.role),
	).toEqual(["source"]);
	expect(
		pendingAgentChatDraftMoves(moves, "target-space").map((m) => m.role),
	).toEqual(["destination"]);
	expect(pendingAgentChatDraftMoves(moves, "elsewhere")).toEqual([]);
});

it("offers keeping the source only before the layout commits or a receipt says it moved", () => {
	const receipt = (
		status: AgentChatDraftMoveReceipt["status"],
	): AgentChatDraftMoveReceipt => ({
		kind: "draft_move",
		id: "notice-transfer",
		digest: `sha256:${"a".repeat(64)}`,
		status,
	});
	expect(agentChatDraftMoveCancellable(move("source"), undefined)).toBe(true);
	expect(agentChatDraftMoveCancellable(move("source"), receipt("staged"))).toBe(
		true,
	);
	expect(
		agentChatDraftMoveCancellable(move("source"), receipt("aborted")),
	).toBe(true);
	expect(agentChatDraftMoveCancellable(move("source"), receipt("moved"))).toBe(
		false,
	);
	expect(
		agentChatDraftMoveCancellable(move("source"), receipt("committed")),
	).toBe(false);
	expect(
		agentChatDraftMoveCancellable(
			move("source", { layoutCommitted: true }),
			undefined,
		),
	).toBe(false);
});

it("fences a composer's edits on the move in flight and on the epoch a finished move bumped", () => {
	const s = store();
	s.getState().updateChatDraft(identity, () => ({
		text: "draft",
		attachments: [],
	}));
	expect(agentChatDraftEditable(s.getState(), identity.agentId, 0)).toBe(true);

	const { transfer } = move("source");
	const expected = s.getState().chatDrafts[identity.agentId];
	s.getState().applyChatDraftMove({
		action: "begin",
		packet: { transfer, drafts: expected },
		expected,
	});
	expect(agentChatDraftEditable(s.getState(), identity.agentId, 0)).toBe(false);

	s.getState().applyChatDraftMove({
		action: "release",
		transfer,
		receipt: {
			kind: "draft_move",
			id: transfer.id,
			digest: transfer.digest,
			status: "aborted",
		},
	});
	const current = s.getState().chatDraftEpochs[identity.agentId];
	expect(current).toBeGreaterThan(0);
	expect(agentChatDraftEditable(s.getState(), identity.agentId, 0)).toBe(false);
	expect(agentChatDraftEditable(s.getState(), identity.agentId, current)).toBe(
		true,
	);
});

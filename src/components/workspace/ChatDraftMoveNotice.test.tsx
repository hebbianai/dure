// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
import { agentChatDraftKey } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { ChatDraftMoveNotice } from "./ChatDraftMoveNotice";

const recovery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/chat/agentChatDraftMoveRecovery", () => ({
	recoverAgentChatDraftMove: recovery,
}));
const agent = managedAgentFixture({
	id: "notice-chat",
	name: "Review",
	interactionProfile: {
		schemaVersion: 1,
		kind: "structured_protocol",
		backendProfileId: "local",
		interactionSessionId: "notice-conversation",
	},
});
function fixture() {
	const target = prepareAgentChatDraftTarget(agent);
	const transfer = {
		id: "notice-transfer",
		digest: `sha256:${"a".repeat(64)}`,
		target,
		source: {
			schemaVersion: 1 as const,
			desktopId: "source",
			dockviewId: "dock-1",
			paneId: "agent:notice-chat",
			windowLabel: "main",
			windowGeneration: "boot-1",
		},
		destination: {
			schemaVersion: 1 as const,
			desktopId: "target",
			dockviewId: "dock-2",
			windowLabel: "win-100-2",
			windowGeneration: "boot-2",
		},
	};
	useStore.getState().updateChatDraft(target.identity, () => ({
		text: "보존한 초안",
		attachments: [{ fileName: "이미지.png", dataB64: "aW1hZ2U=" }],
	}));
	const expected = useStore.getState().chatDrafts[agent.id];
	useStore.getState().applyChatDraftMove({
		action: "begin",
		packet: { transfer, drafts: expected },
		expected,
	});
	return transfer;
}
beforeEach(() => {
	recovery.mockReset();
	useStore.setState({
		agents: [agent],
		projects: [],
		layouts: {},
		chatDrafts: {},
		chatDraftEpochs: {},
		chatDraftMoves: {},
		chatDraftMoveReceipts: {},
	});
});
afterEach(cleanup);

it("retains recovery in the source workspace after its pane is gone and uses the exact transfer on Check", async () => {
	const transfer = fixture();
	useStore.getState().applyChatDraftMove({ action: "mark_moved", transfer });
	let resolve!: () => void;
	recovery.mockImplementationOnce(async (request) => {
		expect(request).toEqual({ transfer, intent: "finish" });
		await new Promise<void>((accept) => {
			resolve = accept;
		});
		const receipt = {
			kind: "draft_move" as const,
			id: transfer.id,
			digest: transfer.digest,
			status: "committed" as const,
		};
		useStore
			.getState()
			.applyChatDraftMove({ action: "release", transfer, receipt });
		return receipt;
	});
	render(<ChatDraftMoveNotice desktopId="source" />);
	expect(
		(
			screen.getByRole("button", {
				name: t("agents.chat.draftMoveKeepSource"),
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.chat.draftMoveCheck") }),
	);
	expect(
		(
			screen.getByRole("button", {
				name: t("agents.chat.draftMoveCheck"),
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	await act(async () => {
		resolve();
	});
	expect(screen.queryByRole("button")).toBeNull();
	expect(useStore.getState().chatDrafts[agent.id]).toBeUndefined();
});

it("keeps the original draft editable after an acknowledged cancellation", async () => {
	const transfer = fixture();
	recovery.mockImplementationOnce(async (request) => {
		expect(request).toEqual({ transfer, intent: "cancel" });
		const receipt = {
			kind: "draft_move" as const,
			id: transfer.id,
			digest: transfer.digest,
			status: "aborted" as const,
		};
		useStore
			.getState()
			.applyChatDraftMove({ action: "release", transfer, receipt });
		return receipt;
	});
	render(<ChatDraftMoveNotice desktopId="source" />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.chat.draftMoveKeepSource") }),
	);
	await act(async () => {});
	expect(screen.queryByRole("button")).toBeNull();
	expect(
		useStore.getState().chatDrafts[agent.id][
			agentChatDraftKey(transfer.target.identity)
		].text,
	).toBe("보존한 초안");
	useStore.getState().updateChatDraft(transfer.target.identity, (draft) => ({
		...draft,
		text: "계속 작성",
	}));
});

it("retains the original identity and image after a failed check and exposes the same Check again", async () => {
	const transfer = fixture();
	const before = useStore.getState().chatDrafts[agent.id];
	recovery.mockRejectedValueOnce(new Error("lost response"));
	recovery.mockResolvedValueOnce({
		kind: "draft_move",
		id: transfer.id,
		digest: transfer.digest,
		status: "staged",
	});
	render(<ChatDraftMoveNotice desktopId="source" />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.chat.draftMoveCheck") }),
	);
	await act(async () => {});
	expect(screen.getByRole("alert").textContent).toContain(
		t("agents.chat.draftMoveRecoveryFailed"),
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.chat.draftMoveCheck") }),
	);
	await act(async () => {});
	expect(recovery.mock.calls).toEqual([
		[{ transfer, intent: "finish" }],
		[{ transfer, intent: "finish" }],
	]);
	expect(screen.getByRole("alert").textContent).toContain(
		t("agents.chat.draftMoveUnfinished"),
	);
	expect(useStore.getState().chatDrafts[agent.id]).toBe(before);
});

it("does not expose another workspace's pending draft", () => {
	fixture();
	render(<ChatDraftMoveNotice desktopId="unrelated" />);
	expect(screen.queryByRole("button")).toBeNull();
});

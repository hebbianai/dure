// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BACKGROUND_WORK_REFRESH_MS } from "@/lib/agents/chat/backgroundWork";
import type { ProviderConversationDetails } from "@/lib/agents/providerConversationDiscovery";
import { setLang } from "@/lib/i18n";
import type { BackgroundWorkList } from "@/lib/ipc/conversations";
import { ProviderConversationHistory } from "./ProviderConversationHistory";

const mocks = vi.hoisted(() => ({ details: vi.fn(), work: vi.fn() }));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	loadProviderConversationDetails: (...args: unknown[]) =>
		mocks.details(...args),
}));
vi.mock("@/lib/ipc/conversations", () => ({
	readAgentBackgroundWork: (...args: unknown[]) => mocks.work(...args),
}));

const SESSION = { workspaceId: "workspace-1", sessionId: "session-1" };

function details(
	subagents: ProviderConversationDetails["subagents"],
): ProviderConversationDetails {
	return {
		inputAuthority: { kind: "independent" },
		subagents,
		totalCount: subagents.length,
	};
}

function work(ids: string[]): BackgroundWorkList {
	return {
		items: ids.map((id) => ({
			id,
			kind: "subagent",
			startedUnixMs: Date.now(),
		})),
		counts: { subagents: ids.length, workflows: 0, shells: 0, monitors: 0 },
		truncated: false,
	};
}

/** The subagent row's status line, by its title. */
function statusOf(title: string): string | null | undefined {
	return screen.getByText(title).closest("div.px-2")?.lastElementChild
		?.textContent;
}

function renderHistory(
	props: Partial<Parameters<typeof ProviderConversationHistory>[0]> = {},
) {
	return render(
		<ProviderConversationHistory
			provider="claude"
			conversationId="conversation-1"
			executionLocation="local"
			recentTurns={[]}
			subagentCount={2}
			sshHosts={[]}
			backgroundWorkSession={SESSION}
			{...props}
		/>,
	);
}

beforeAll(() => setLang("en"));
afterAll(() => setLang("ko"));

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	mocks.details.mockResolvedValue(
		details([
			{ id: "agent-a1", title: "Quiet review", status: "unknown", mtime: 1 },
			{
				id: "agent-a2",
				title: "Finished survey",
				status: "completed",
				mtime: 1,
				toolUseId: "toolu_02",
			},
		]),
	);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	mocks.details.mockReset();
	mocks.work.mockReset();
});

describe("ProviderConversationHistory subagents", () => {
	it("says running for exactly the subagents the chat line's list names", async () => {
		mocks.work.mockResolvedValue(work(["a1"]));
		renderHistory();

		await screen.findByText("Quiet review");
		expect(mocks.work).toHaveBeenCalledWith("workspace-1", "session-1");
		expect(statusOf("Quiet review")).toMatch(/^running/i);
		expect(statusOf("Finished survey")).toMatch(/^done/i);
	});

	it("reads again on the line's interval until the list lets the row go", async () => {
		mocks.work.mockResolvedValueOnce(work(["a1"])).mockResolvedValue(work([]));
		renderHistory();
		await screen.findByText("Quiet review");
		expect(statusOf("Quiet review")).toMatch(/^running/i);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_REFRESH_MS);
		});
		expect(mocks.work).toHaveBeenCalledTimes(2);
		expect(statusOf("Quiet review")).toMatch(/^unknown/i);

		// Nothing runs any more, so nothing is read again.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_REFRESH_MS * 3);
		});
		expect(mocks.work).toHaveBeenCalledTimes(2);
		expect(mocks.details).toHaveBeenCalledTimes(2);
	});

	it("shows the recorded rows when the list cannot be read", async () => {
		mocks.work.mockRejectedValue(new Error("host_unreachable"));
		renderHistory();

		await screen.findByText("Quiet review");
		expect(statusOf("Quiet review")).toMatch(/^unknown/i);
		expect(statusOf("Finished survey")).toMatch(/^done/i);
	});

	it("reads no list without a managed session", async () => {
		renderHistory({ backgroundWorkSession: null });
		await screen.findByText("Quiet review");

		expect(mocks.work).not.toHaveBeenCalled();
	});

	it("keeps a provider's own rows when its list names no subagent", async () => {
		// The desktop answers an empty list for a provider without background
		// work records; its rows keep their own status, and an empty list is
		// not read again.
		mocks.details.mockResolvedValue(
			details([
				{ id: "codex-1", title: "Codex child", status: "running", mtime: 1 },
			]),
		);
		mocks.work.mockResolvedValue(work([]));
		renderHistory({ provider: "codex", subagentCount: 1 });
		await screen.findByText("Codex child");
		expect(statusOf("Codex child")).toMatch(/^running/i);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_REFRESH_MS * 3);
		});
		expect(mocks.work).toHaveBeenCalledTimes(1);
		expect(mocks.details).toHaveBeenCalledTimes(1);
	});
});

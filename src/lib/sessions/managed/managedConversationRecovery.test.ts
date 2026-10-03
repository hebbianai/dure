// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { recoverManagedConversationPane } from "./managedConversationRecovery";

const mocks = vi.hoisted(() => ({ resume: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => ({
	resumeExactManagedAgentPane: mocks.resume,
}));
vi.mock(
	"@/lib/sessions/managed/managedClosedLineageWake",
	async (original) => ({
		...(await original<typeof import("./managedClosedLineageWake")>()),
		wakeClosedManagedLineage: mocks.wake,
	}),
);
const closed = new Error(
	"session_checkout_closing: checkout claim admission is closed",
);

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [agentFixture({ runtimeBinding: managedBindingFixture() })],
	});
});
afterEach(() => useStore.setState({ agents: [] }));

describe("shared Resume and Refresh recovery", () => {
	it("recovers a closed checkout through the same exact conversation", async () => {
		mocks.resume.mockRejectedValueOnce(closed);
		const result = { state: "stable", sessionId: "replacement" };
		mocks.wake.mockResolvedValueOnce(result);
		await expect(
			recoverManagedConversationPane("agent-1", "pane-1", "conversation-1"),
		).resolves.toBe(result);
		expect(mocks.wake).toHaveBeenCalledExactlyOnceWith(
			"agent-1",
			"conversation-1",
		);
	});

	it("shares the whole recovery across concurrent Resume and Refresh actions", async () => {
		mocks.resume.mockRejectedValue(closed);
		let complete!: (value: unknown) => void;
		mocks.wake.mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const resume = recoverManagedConversationPane(
			"agent-1",
			"pane-1",
			"conversation-1",
		);
		await vi.waitFor(() => expect(mocks.wake).toHaveBeenCalledOnce());
		const refresh = recoverManagedConversationPane(
			"agent-1",
			"pane-2",
			"conversation-1",
		);
		const result = { state: "stable" };
		complete(result);
		expect(await Promise.all([resume, refresh])).toEqual([result, result]);
		expect(mocks.resume).toHaveBeenCalledOnce();
		expect(mocks.wake).toHaveBeenCalledOnce();
	});

	it("does not launch through another mechanism after an uncertain native response", async () => {
		const lost = new Error("managed_create_outcome_unknown");
		mocks.resume.mockRejectedValueOnce(lost);
		await expect(
			recoverManagedConversationPane("agent-1", "pane-1", "conversation-1"),
		).rejects.toBe(lost);
		expect(mocks.wake).not.toHaveBeenCalled();
	});

	it("keeps the original refusal when no backend route can recover it", async () => {
		mocks.resume.mockRejectedValueOnce(closed);
		mocks.wake.mockResolvedValueOnce(undefined);
		await expect(
			recoverManagedConversationPane("agent-1", "pane-1", "conversation-1"),
		).rejects.toBe(closed);
	});

	it("releases a failed attempt so a later explicit action can retry", async () => {
		mocks.resume
			.mockRejectedValueOnce(closed)
			.mockResolvedValueOnce({ projection: "applied" });
		mocks.wake.mockRejectedValueOnce(new Error("response lost"));
		await expect(
			recoverManagedConversationPane("agent-1", "pane-1", "conversation-1"),
		).rejects.toThrow("response lost");
		await expect(
			recoverManagedConversationPane("agent-1", "pane-1", "conversation-1"),
		).resolves.toEqual({ projection: "applied" });
		expect(mocks.resume).toHaveBeenCalledTimes(2);
		expect(mocks.wake).toHaveBeenCalledOnce();
	});
});

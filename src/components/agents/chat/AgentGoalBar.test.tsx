// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentGoalBar } from "@/components/agents/chat/AgentGoalBar";
import { setLang } from "@/lib/i18n";
import { chatComposerSessionFixture } from "@/test/chatComposerSessionFixture";
const mode = vi.hoisted(() => ({ pro: true }));
vi.mock("@/components/workspace/useInterfaceMode", () => ({
	useInterfaceMode: () => (mode.pro ? "pro" : "basic"),
}));
beforeEach(() => {
	setLang("en");
	mode.pro = true;
});
afterEach(cleanup);
function fixture() {
	const session = chatComposerSessionFixture("codex");
	if (!session.page) throw new Error("expected page");
	session.page.goal = {
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 1,
		objective: "Finish the shared project",
		status: "active",
		detail: null,
		activationCursor: { epoch: "timeline-1", sequence: 0 },
		createdAtMs: 1,
		updatedAtMs: 1,
	};
	return session;
}
it("sets a free-text goal and keeps a failed submission available for editing", async () => {
	const session = chatComposerSessionFixture("codex");
	vi.mocked(session.putGoal)
		.mockResolvedValueOnce(false)
		.mockResolvedValueOnce(true);
	render(<AgentGoalBar session={session} />);
	fireEvent.click(screen.getByRole("button", { name: "Set goal" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), {
		target: { value: "Complete the launch and choose the next useful task" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
	await waitFor(() => expect(session.putGoal).toHaveBeenCalledTimes(1));
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"Complete the launch and choose the next useful task",
	);
	fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
	await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
	expect(session.putGoal).toHaveBeenLastCalledWith({
		objective: "Complete the launch and choose the next useful task",
		status: "active",
		expectedRevision: 0,
	});
});
it("preserves a draft when another teammate changes the goal and requires an explicit choice to apply it", async () => {
	const session = fixture();
	const { rerender } = render(<AgentGoalBar session={session} />);
	fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "My revised direction" },
	});
	const next = {
		...session,
		page: {
			...session.page!,
			goal: {
				...session.page!.goal!,
				objective: "Teammate direction",
				revision: 2,
			},
		},
	};
	rerender(<AgentGoalBar session={next} />);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"My revised direction",
	);
	expect(screen.getByRole("status").textContent).toContain(
		"Teammate direction",
	);
	expect(session.putGoal).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Apply my changes" }));
	await waitFor(() =>
		expect(session.putGoal).toHaveBeenCalledWith({
			objective: "My revised direction",
			status: "active",
			expectedRevision: 2,
		}),
	);
});
it("pauses and resumes the observed revision, and Basic can stop an existing goal", async () => {
	const session = fixture();
	mode.pro = false;
	const { rerender } = render(<AgentGoalBar session={session} />);
	fireEvent.click(screen.getByRole("button", { name: "Pause" }));
	await waitFor(() =>
		expect(session.putGoal).toHaveBeenCalledWith({
			objective: "Finish the shared project",
			status: "paused",
			expectedRevision: 1,
		}),
	);
	const paused = {
		...session,
		page: {
			...session.page!,
			goal: { ...session.page!.goal!, status: "paused" as const, revision: 2 },
		},
	};
	rerender(<AgentGoalBar session={paused} />);
	expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
	mode.pro = true;
	rerender(<AgentGoalBar session={paused} />);
	fireEvent.click(screen.getByRole("button", { name: "Resume" }));
	await waitFor(() =>
		expect(session.putGoal).toHaveBeenCalledWith({
			objective: "Finish the shared project",
			status: "active",
			expectedRevision: 2,
		}),
	);
});
it("does not offer a new goal in Basic", () => {
	mode.pro = false;
	render(<AgentGoalBar session={chatComposerSessionFixture("codex")} />);
	expect(screen.queryByRole("button", { name: "Set goal" })).toBeNull();
});

it("keeps an unfinished objective when pausing current work", async () => {
	const session = fixture();
	render(<AgentGoalBar session={session} />);
	fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "Keep this draft" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Pause" }));
	await waitFor(() => expect(session.putGoal).toHaveBeenCalledTimes(1));
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"Keep this draft",
	);
});

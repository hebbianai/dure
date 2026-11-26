// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLabel } from "@/components/agents/StatusBits";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionMetadataFixture,
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Project, Space } from "@/types";

const navigation = vi.hoisted(() => ({
	agentRevealTargets: vi.fn(),
	goToNextUp: vi.fn(),
	revealAgent: vi.fn(),
}));
const windows = vi.hoisted(() => ({ isMainWindow: vi.fn(() => true) }));
vi.mock("@/lib/agents/nextUpNavigation", () => navigation);
vi.mock("@/lib/workspace/window/windows", () => windows);

import { NextUpChip } from "./NextUpChip";

const agents = ["approval", "question", "finished", "working"].map((id) =>
	agentFixture({
		id,
		name: id,
		displayName: `Agent ${id}`,
		sessionId: `session-${id}`,
	}),
);

function runtime(patch: Partial<HmuxAgentRuntimeState>): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-1",
		revision: "3",
		observedThroughOutputSeq: "9",
		lifecycle: "running",
		activity: "waiting",
		attention: "none",
		source: "provider_event",
		...patch,
	};
}

function seed(attention: Partial<ReturnType<typeof useAgentAttention.getState>>) {
	useAgentAttention.setState({
		...useAgentAttention.getInitialState(),
		...attention,
	});
}

function chip() {
	return screen.getByRole("button", { name: new RegExp(t("agents.nextUp.open")) });
}

beforeEach(() => {
	useStore.setState({
		agents,
		activeSpaceId: "space-a",
		spaces: [
			{ id: "space-a", name: "Main" },
			{ id: "space-b", name: "Review" },
		] as Space[],
		projects: [{ id: "project-1", name: "repo", path: "/repo" }] as Project[],
		hmuxSessionMetadata: {},
		sessionActivity: {},
		sessionAgentRuntimeState: {
			"session-question": runtime({
				attention: "input_required",
				programStatus: {
					state: "blocked",
					blocked_kind: "question",
					app: "claude-code",
					message: "Which branch?",
				},
			}),
			"session-finished": runtime({
				programStatus: { state: "error", message: "Stale report" },
			}),
		},
	});
	windows.isMainWindow.mockReturnValue(true);
	navigation.agentRevealTargets.mockImplementation(
		(agentIds: readonly string[]) =>
			new Map(
				agentIds.map((agentId) => [
					agentId,
					agentId === "question"
						? { kind: "pane", desktopId: "space-b", panelId: "pane-q" }
						: { kind: "pane", desktopId: "space-a", panelId: `pane-${agentId}` },
				]),
			),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("NextUpChip", () => {
	it("belongs to the main window only", () => {
		windows.isMainWindow.mockReturnValue(false);
		seed({ displayStates: { approval: "blocked" } });
		const { container } = render(<NextUpChip />);
		expect(container.innerHTML).toBe("");
		const key = new KeyboardEvent("keydown", {
			key: "J",
			metaKey: true,
			shiftKey: true,
			cancelable: true,
		});
		act(() => {
			window.dispatchEvent(key);
		});
		expect(navigation.goToNextUp).not.toHaveBeenCalled();
	});

	it("draws nothing while nothing waits", () => {
		seed({ displayStates: { approval: "working", working: "working" } });
		const { container } = render(<NextUpChip />);
		expect(container.innerHTML).toBe("");
	});

	it("counts the agents a human is blocking, in the attention tone", () => {
		seed({
			displayStates: { approval: "blocked", question: "input", finished: "waiting" },
			episodes: { finished: 1 },
			episodeKinds: { finished: "done" },
		});
		render(<NextUpChip />);
		expect(chip().textContent).toBe(`${t("agents.nextUp.needsYou")}2`);
		expect(chip().getAttribute("data-tone")).toBe("attention");
	});

	it("stays quiet when only results wait", () => {
		seed({
			displayStates: { finished: "waiting" },
			episodes: { finished: 1 },
			episodeKinds: { finished: "done" },
		});
		render(<NextUpChip />);
		expect(chip().textContent).toBe(`${t("agents.nextUp.results")}1`);
		expect(chip().getAttribute("data-tone")).toBe("quiet");
	});

	it("lists who waits, why, since when and where, oldest wait first", () => {
		const now = Date.now();
		seed({
			displayStates: { approval: "blocked", question: "input", finished: "waiting" },
			waitingSince: { approval: now - 2 * 60_000, question: now - 9 * 60_000 },
			episodes: { finished: 1 },
			episodeKinds: { finished: "done" },
			episodeAt: { finished: now },
		});
		render(<NextUpChip />);
		act(() => fireEvent.click(chip()));

		const needsYou = screen.getByRole("region", { name: t("agents.nextUp.needsYou") });
		const [question, approval] = within(needsYou).getAllByRole("button");
		expect(question.textContent).toContain("Agent question");
		expect(question.textContent).toContain(
			[
				activityLabel("input"),
				t("common.time.minutesAgo", { n: 9 }),
				"repo",
				"Review",
			].join(" · "),
		);
		// The program's words are attributed and only ever add to Host attention.
		expect(question.textContent).toContain(
			t("agents.row.programMessageFromApp", {
				app: "claude-code",
				message: "Which branch?",
			}),
		);
		expect(approval.textContent).toContain("Agent approval");
		expect(approval.textContent).toContain(
			[activityLabel("blocked"), t("common.time.minutesAgo", { n: 2 }), "repo"].join(
				" · ",
			),
		);

		const results = screen.getByRole("region", { name: t("agents.nextUp.results") });
		const [done] = within(results).getAllByRole("button");
		expect(done.textContent).toContain(t("agents.row.result"));
		expect(done.textContent).not.toContain("Stale report");
	});

	it("lists an unexpected exit with its cause, and says what each agent was asked", () => {
		const now = Date.now();
		useStore.setState({
			agents: [
				...agents,
				managedAgentFixture({
					id: "crashed",
					name: "crashed",
					displayName: "Agent crashed",
					sessionId: "session-crashed",
				}),
			],
			hmuxSessionMetadata: hmuxSessionMetadataFixture({
				failure: {
					correlationId: "failure_1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					terminalEpoch: "terminal-1",
					code: "provider_exited_at_sign_in",
					phase: "conversation_identity",
					summary: "Managed provider exited at its sign-in screen.",
					exitKind: "normal",
					exitCode: 0,
					occurredUnixMs: String(now - 4 * 60_000),
					retryPosture: "never",
				},
			}),
			sessionActivity: {
				"session-approval": { text: "Clean up\nthe build" },
			},
			sessionAgentRuntimeState: {
				"session-approval": runtime({
					attention: "approval_required",
					attentionId: "request-1",
					approvalRequest: {
						toolName: "Bash",
						summary: "rm -rf build",
						choices: ["approve", "deny"],
					},
				}),
			},
		});
		seed({ displayStates: { crashed: "exited", approval: "blocked", finished: "waiting" } });
		render(<NextUpChip />);
		expect(chip().textContent).toBe(`${t("agents.nextUp.needsYou")}2`);
		act(() => fireEvent.click(chip()));

		const needsYou = screen.getByRole("region", { name: t("agents.nextUp.needsYou") });
		const [approval, crashed] = within(needsYou).getAllByRole("button");
		expect(crashed.textContent).toContain("Agent crashed");
		expect(crashed.textContent).toContain(
			[t("agents.row.signInExit"), t("common.time.minutesAgo", { n: 4 }), "repo"].join(
				" · ",
			),
		);
		// The Host's approval says what it asks; the prompt line yields to it.
		expect(approval.textContent).toContain(
			t("agents.row.approvalWithSummary", { tool: "Bash", summary: "rm -rf build" }),
		);
		expect(approval.textContent).not.toContain("Clean up");
	});

	it("shows who manages a waiting agent at any depth, and what a waiting manager manages", () => {
		const team = [
			["coordinator", undefined],
			["lead", "s-coordinator"],
			["worker", "s-lead"],
		].map(([id, parentSession]) =>
			managedAgentFixture({
				id,
				name: id,
				displayName: `Agent ${id}`,
				sessionId: `s-${id}`,
				runtimeBinding: managedBindingFixture({ sessionId: `s-${id}` }),
				...(parentSession
					? {
							runParent: { sessionId: parentSession, workspaceId: "workspace-1" },
						}
					: {}),
			}),
		);
		useStore.setState({ agents: [...agents, ...team] });
		seed({
			displayStates: { coordinator: "blocked", lead: "working", worker: "input" },
		});
		render(<NextUpChip />);
		act(() => fireEvent.click(chip()));

		// Equal wait starts keep the store's order.
		const rows = () =>
			within(
				screen.getByRole("region", { name: t("agents.nextUp.needsYou") }),
			).getAllByRole("button");
		const [coordinator, worker] = rows();
		expect(worker.textContent).toContain("Agent coordinator › Agent lead");
		expect(worker.textContent).toContain("Agent worker");
		const managed = (needYou: number, working?: number) =>
			[
				t("agents.row.manages", { n: 2 }),
				t("agents.row.managedNeedYou", { n: needYou }),
				...(working ? [t("agents.row.managedWorking", { n: working })] : []),
			].join(" · ");
		expect(coordinator.textContent).toContain(managed(1, 1));
		expect(coordinator.textContent).not.toContain("›");

		// Attention alone updates the counts.
		act(() =>
			useAgentAttention.setState({
				displayStates: { coordinator: "blocked", lead: "input", worker: "input" },
			}),
		);
		const [nextCoordinator, lead] = rows();
		expect(nextCoordinator.textContent).toContain(managed(2));
		expect(lead.textContent).toContain(t("agents.row.manages", { n: 1 }));
		expect(lead.textContent).toContain("Agent coordinator");
	});

	it("labels a result's line as what the agent was asked", () => {
		useStore.setState({
			sessionActivity: { "session-finished": { text: "Clean up\nthe build" } },
		});
		seed({
			displayStates: { finished: "waiting" },
			episodes: { finished: 1 },
			episodeKinds: { finished: "done" },
		});
		render(<NextUpChip />);
		act(() => fireEvent.click(chip()));
		const [done] = within(
			screen.getByRole("region", { name: t("agents.nextUp.results") }),
		).getAllByRole("button");
		expect(done.textContent).toContain(
			t("agents.row.asked", { prompt: "Clean up the build" }),
		);
	});

	it("brings the chosen agent forward and closes the list", () => {
		seed({ displayStates: { approval: "blocked" } });
		render(<NextUpChip />);
		act(() => fireEvent.click(chip()));
		act(() => fireEvent.click(screen.getByRole("button", { name: /Agent approval/ })));
		expect(navigation.revealAgent).toHaveBeenCalledWith("approval");
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("walks the list with its shortcut and leaves the key alone when idle", () => {
		seed({ displayStates: { approval: "blocked" } });
		render(<NextUpChip />);
		navigation.goToNextUp.mockReturnValueOnce(true);
		const handled = new KeyboardEvent("keydown", {
			key: "J",
			metaKey: true,
			shiftKey: true,
			cancelable: true,
		});
		act(() => {
			window.dispatchEvent(handled);
		});
		expect(navigation.goToNextUp).toHaveBeenCalledTimes(1);
		expect(handled.defaultPrevented).toBe(true);

		navigation.goToNextUp.mockReturnValueOnce(false);
		const idle = new KeyboardEvent("keydown", {
			key: "J",
			metaKey: true,
			shiftKey: true,
			cancelable: true,
		});
		act(() => {
			window.dispatchEvent(idle);
		});
		expect(idle.defaultPrevented).toBe(false);

		// A bare Ctrl+J is a terminal newline, never this command.
		const newline = new KeyboardEvent("keydown", {
			key: "j",
			ctrlKey: true,
			cancelable: true,
		});
		act(() => {
			window.dispatchEvent(newline);
		});
		expect(navigation.goToNextUp).toHaveBeenCalledTimes(2);
		expect(newline.defaultPrevented).toBe(false);
	});
});

// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	copyTextToClipboard: vi.fn(async () => true),
}));

vi.mock("@/lib/platform/clipboardWrite", () => ({
	copyTextToClipboard: mocks.copyTextToClipboard,
}));

function session(): AgentChatSessionView {
	return {
		draftIdentity: {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		},
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		putGoal: vi.fn(async () => true),
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				agentId: "agent-1",
				providerId: "claude",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: {
					runtimeGeneration: "runtime-1",
					providerEpoch: "query-1",
				},
				timelineEpoch: "timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "item-1",
						turnId: null,
						clientMessageId: null,
						providerMessageId: "provider-message-1",
						body: {
							type: "message",
							role: "assistant",
							markdown: "Hello from Claude",
						},
						createdAtMs: 1,
					},
				},
			],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 1 },
			hasMore: false,
		},
		retryConnection: vi.fn(),
		loadOlder: vi.fn(async () => {}),
		send: vi.fn(async () => {}),
		retryTurn: vi.fn(async () => {}),
		editRetryableTurn: vi.fn(() => undefined),
		answerPending: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		dismissActionError: vi.fn(),
		queueMessage: vi.fn(),
		steerOrQueue: vi.fn(async () => "queued" as const),
		dequeueMessage: vi.fn(() => undefined),
	};
}

describe("AgentChatSurface", () => {
	beforeEach(() => {
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders provider Markdown while keeping raw HTML inert", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const message = value.page.rows[0]?.item.body;
		if (message?.type !== "message") throw new Error("expected a message");
		message.markdown =
			"# Safe result\n\nUse `rg`.\n\n<script>alert('no')</script>";

		const view = render(<AgentChatSurface session={value} />);
		expect(
			screen.getByRole("heading", { level: 1, name: "Safe result" }),
		).toBeTruthy();
		expect(screen.getByText("rg").tagName).toBe("CODE");
		expect(view.container.querySelector("script")).toBeNull();
		expect(screen.queryByText("<script>alert('no')</script>")).toBeNull();
	});

	it("identifies automatic goal input and lets the reader inspect its objective", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows[0].item.body = {
			type: "goal_continuation",
			objective: "Finish the report",
			goalRevision: 2,
		};
		const view = render(<AgentChatSurface session={value} />);
		const label = screen.getByText(t("agents.chat.goal.continuing"));
		fireEvent.click(label);
		expect(label.closest("details")?.open).toBe(true);
		expect(screen.getByText("Finish the report")).toBeTruthy();
		expect(view.container.querySelector("article")).toBeNull();
	});

	it("shows confirmed question answers in the transcript without exposing sensitive values", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows[0].item.body = {
			type: "pending_answer",
			idempotencyKey: "answer-1",
			request: {
				interactionSessionId: "interaction-1",
				runtime: value.page.binding.runtime,
				request: {
					requestId: "question-1",
					clientMessageId: "message-1",
					turnId: null,
					kind: "question",
					createdAtMs: 1,
					payload: {
						input: {
							questions: [
								{ id: "stack", question: "Which database?", options: [] },
								{
									id: "token",
									question: "Access token?",
									options: [],
									isSecret: true,
								},
							],
						},
					},
				},
			},
			answer: { answers: { stack: "Use SQLite", token: "private-answer" } },
		};
		const view = render(<AgentChatSurface session={value} />);
		expect(screen.getByText("Which database?")).toBeTruthy();
		expect(screen.getByText("Use SQLite")).toBeTruthy();
		expect(view.container.textContent).not.toContain("private-answer");
		expect(
			screen.getByText(t("agents.chat.answer.sensitiveHidden")),
		).toBeTruthy();
	});

	it("announces transcript additions and initial connection states", () => {
		const value = session();
		const view = render(<AgentChatSurface session={value} />);
		const transcript = screen.getByRole("log", {
			name: t("agents.chat.transcript"),
		});
		expect(transcript.getAttribute("aria-relevant")).toBe("additions");

		value.page = undefined;
		value.phase = "connecting";
		view.rerender(<AgentChatSurface session={value} />);
		expect(screen.getByRole("status").textContent).toContain(
			t("agents.chat.connecting"),
		);

		value.phase = "error";
		value.error = "backend unavailable";
		view.rerender(<AgentChatSurface session={value} />);
		expect(screen.getByRole("alert").textContent).toContain(
			"backend unavailable",
		);
	});

	it("keeps canonical row anchors when an older lifecycle row regroups a tool", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows[0]!.cursor.sequence = 2;
		value.page.rows[0]!.item.itemId = "item-2";
		value.page.rows[0]!.item.turnId = "turn-1";
		value.page.rows[0]!.item.clientMessageId = "message-1";
		value.page.rows[0]!.item.body = {
			type: "tool",
			toolCallId: "tool-1",
			name: "Read",
			state: "running",
			input: { path: "README.md" },
			output: null,
		};
		value.page.finalCursor.sequence = 2;
		value.page.hasMore = true;
		value.loadOlder = vi.fn(() => {
			value.loadingOlder = true;
			return new Promise<void>(() => {});
		});
		const view = render(<AgentChatSurface session={value} />);
		const log = screen.getByRole("log", {
			name: t("agents.chat.transcript"),
		});
		const scroller = log.firstElementChild as HTMLElement;

		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.chat.loadEarlierHistory"),
			}),
		);
		expect(value.loadOlder).toHaveBeenCalledTimes(1);
		value.page = {
			...value.page,
			rows: [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "item-1",
						turnId: "turn-1",
						clientMessageId: "message-1",
						providerMessageId: null,
						body: {
							type: "lifecycle",
							state: "turn_started",
							detail: null,
						},
						createdAtMs: 0,
					},
				},
				...value.page.rows,
				{
					cursor: { epoch: "timeline-1", sequence: 3 },
					item: {
						itemId: "item-3",
						turnId: "turn-1",
						clientMessageId: "message-1",
						providerMessageId: "provider-message-tool-1",
						body: {
							type: "tool",
							toolCallId: "tool-1",
							name: "Read",
							state: "completed",
							input: null,
							output: "contents",
						},
						createdAtMs: 3,
					},
				},
			],
			finalCursor: { epoch: "timeline-1", sequence: 3 },
			hasMore: false,
		};
		view.rerender(<AgentChatSurface session={value} />);

		const regrouped = [
			...scroller.querySelectorAll<HTMLElement>(
				"[data-agent-chat-row-anchors]",
			),
		].find((candidate) =>
			candidate.dataset.agentChatRowAnchors
				?.split(" ")
				.includes("timeline-1:2"),
		);
		expect(regrouped?.dataset.agentChatRowAnchors?.split(" ")).toEqual(
			expect.arrayContaining(["timeline-1:2", "timeline-1:3"]),
		);
		// Real layout/scroll anchoring is exercised by agent-chat-virtualization.mjs.
	});

	it("keeps a tail-following reader pinned when an older read fails", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.hasMore = true;
		value.loadOlder = vi.fn(async () => {
			throw new Error("history unavailable");
		});
		render(<AgentChatSurface session={value} />);

		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.chat.loadEarlierHistory"),
			}),
		);
		await waitFor(() => expect(value.loadOlder).toHaveBeenCalledTimes(1));

		expect(
			screen.queryByRole("button", { name: t("agents.chat.scrollToLatest") }),
		).toBeNull();
	});

	it("projects a completed turn into one copyable status footer", () => {
		mocks.copyTextToClipboard.mockClear();
		const response = `## Done\n\nFirst answer.\n\n${Array.from(
			{ length: 2000 },
			(_, index) => `- Item ${index}`,
		).join("\n")}`;
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start-1",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "user-1",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "message", role: "user", markdown: "Inspect it" },
					createdAtMs: 1_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 3 },
				item: {
					itemId: "assistant-1",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					body: {
						type: "message",
						role: "assistant",
						markdown: response,
					},
					createdAtMs: 2_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 4 },
				item: {
					itemId: "assistant-2",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-2",
					body: {
						type: "message",
						role: "assistant",
						markdown: "Second answer.",
					},
					createdAtMs: 3_000,
				},
			},
			{
				cursor: { epoch: "timeline-1", sequence: 5 },
				item: {
					itemId: "turn-completed-1",
					turnId: null,
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_completed", detail: null },
					createdAtMs: 4_000,
				},
			},
		];

		const view = render(<AgentChatSurface session={value} />);
		expect(
			screen.queryByText(t("agents.chat.lifecycle.turn_started")),
		).toBeNull();
		const footer = view.container.querySelector("[data-agent-turn-footer]");
		expect(footer).toBeTruthy();
		expect(view.container.querySelectorAll("li").length).toBeLessThan(100);
		expect(screen.queryByText("Item 1999")).toBeNull();
		// A completed turn stays quiet — no per-turn status announcement.
		expect(
			screen.queryByText(t("agents.chat.lifecycle.turn_completed")),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.copyResponse") }),
		);
		expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
			`${response}\n\nSecond answer.`,
		);

		const terminal = value.page.rows[value.page.rows.length - 1];
		if (terminal?.item.body.type !== "lifecycle") {
			throw new Error("expected the terminal lifecycle row");
		}
		value.page = {
			...value.page,
			rows: [
				...value.page.rows.slice(0, -1),
				{
					...terminal,
					item: {
						...terminal.item,
						body: { type: "lifecycle", state: "turn_failed", detail: null },
					},
				},
			],
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(
			screen.getByText(t("agents.chat.lifecycle.turn_failed")),
		).toBeTruthy();
	});

	it("keeps provider evidence out of the conversation transcript", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows.push({
			cursor: { epoch: "timeline-1", sequence: 2 },
			item: {
				itemId: "evidence-1",
				turnId: null,
				clientMessageId: null,
				providerMessageId: null,
				body: {
					type: "provider_evidence",
					namespace: "claude",
					kind: "provider_event",
					value: { type: "command_lifecycle", subtype: null },
				},
				createdAtMs: 2,
			},
		});

		const view = render(<AgentChatSurface session={value} />);
		expect(screen.getByText("Hello from Claude")).toBeTruthy();
		expect(view.container.querySelector("details")).toBeNull();
		expect(screen.queryByText(/command_lifecycle/)).toBeNull();

		value.page = {
			...value.page,
			rows: value.page.rows.filter(
				(row) => row.item.body.type === "provider_evidence",
			),
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(screen.getByText(t("agents.chat.empty"))).toBeTruthy();
	});

	it("shows the empty hint when the timeline contains only hidden lifecycle rows", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const visibleRows = value.page.rows;
		value.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "session-ready",
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					body: { type: "lifecycle", state: "session_ready", detail: null },
					createdAtMs: 1,
				},
			},
		];

		const view = render(<AgentChatSurface session={value} />);
		expect(screen.getByText(t("agents.chat.empty"))).toBeTruthy();

		value.page = {
			...value.page,
			rows: visibleRows,
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(screen.queryByText(t("agents.chat.empty"))).toBeNull();
		expect(screen.getByText("Hello from Claude")).toBeTruthy();
	});

	it("preserves an opened tool card while its snapshot completes", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		const turnStart: AgentTimelineRowV1 = {
			cursor: { epoch: "timeline-1", sequence: 1 },
			item: {
				itemId: "turn-start",
				turnId: "turn-1",
				clientMessageId: "message-1",
				providerMessageId: null,
				body: { type: "lifecycle", state: "turn_started", detail: null },
				createdAtMs: 1,
			},
		};
		const running: AgentTimelineRowV1 = {
			cursor: { epoch: "timeline-1", sequence: 2 },
			item: {
				itemId: "tool-running",
				turnId: null,
				clientMessageId: null,
				providerMessageId: "provider-tool-1",
				body: {
					type: "tool",
					toolCallId: "tool-call-1",
					name: "Read",
					state: "running",
					input: { file_path: "README.md" },
					output: null,
				},
				createdAtMs: 2,
			},
		};
		value.page.rows = [turnStart, running];

		const view = render(<AgentChatSurface session={value} />);
		// Running state is carried by the shimmer treatment, not a status label.
		expect(view.container.querySelector(".chat-shimmer")).toBeTruthy();
		fireEvent.click(view.container.querySelector("summary")!);
		const details = (await screen.findByText("Read")).closest("details");
		if (!details) throw new Error("expected tool details");
		fireEvent.click(details.querySelector("summary")!);
		await waitFor(() => expect(details.open).toBe(true));

		const completed: AgentTimelineRowV1 = {
			cursor: { epoch: "timeline-1", sequence: 3 },
			item: {
				...running.item,
				itemId: "tool-completed",
				body: {
					type: "tool",
					toolCallId: "tool-call-1",
					name: "Read",
					state: "completed",
					input: null,
					output: "contents",
				},
				createdAtMs: 3,
			},
		};
		value.page = {
			...value.page,
			rows: [turnStart, running, completed],
			finalCursor: { epoch: "timeline-1", sequence: 3 },
		};
		view.rerender(<AgentChatSurface session={value} />);

		expect(view.container.querySelector("details .chat-shimmer")).toBeNull();
		expect(view.container.querySelectorAll(".chat-shimmer")).toHaveLength(1);
		const updated = screen.getByText("Read").closest("details");
		expect(updated).toBe(details);
		expect(updated?.open).toBe(true);
		expect(view.container.textContent).toContain("README.md");

		value.page = {
			...value.page,
			rows: [turnStart, completed],
			finalCursor: { epoch: "timeline-1", sequence: 4 },
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(view.container.textContent).not.toContain("README.md");
		expect(view.container.querySelector("details details")).toBe(details);
	});

	it("summarizes a tool call as verb plus argument with JSON behind it", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		value.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "tool-1",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool-call-1",
						name: "Bash",
						state: "completed",
						input: { command: "pnpm gate:scope", description: "Classify" },
						output: null,
					},
					createdAtMs: 1,
				},
			},
		];
		const view = render(<AgentChatSurface session={value} />);
		fireEvent.click(view.container.querySelector("summary")!);
		expect(await screen.findByText("Bash")).toBeTruthy();
		expect(screen.getByText("pnpm gate:scope")).toBeTruthy();
		const details = screen.getByText("Bash").closest("details");
		expect(details?.open).toBe(false);
		expect(screen.queryByText(t("agents.chat.toolState.completed"))).toBeNull();
	});

	it("collapses a settled burst of tool calls into one aggregated line", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const tool = (
			itemId: string,
			sequence: number,
			name: string,
			state: "completed" | "failed",
		): AgentTimelineRowV1 => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId,
				turnId: null,
				clientMessageId: null,
				providerMessageId: `provider-${itemId}`,
				body: {
					type: "tool",
					toolCallId: itemId,
					name,
					state,
					input: null,
					output: null,
				},
				createdAtMs: sequence,
			},
		});
		value.page.rows = [
			tool("tool-1", 1, "Read", "completed"),
			tool("tool-2", 2, "Read", "completed"),
			tool("tool-3", 3, "Bash", "completed"),
		];
		const view = render(<AgentChatSurface session={value} />);
		expect(
			screen.getByText(
				`${t("agents.chat.workReadMany", { count: 2 })} · ${t(
					"agents.chat.workRunOne",
				)}`,
			),
		).toBeTruthy();
		const burst = view.container.querySelector("details");
		expect(burst?.open).toBe(false);

		value.page = {
			...value.page,
			rows: [...value.page.rows, tool("tool-4", 4, "Grep", "failed")],
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(screen.getByText(t("agents.chat.workFailedOne"))).toBeTruthy();
	});

	it("renders a recognized plan as a checklist and opaque plans as JSON when expanded", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const planRow = (itemId: string, planValue: unknown) => ({
			cursor: { epoch: "timeline-1", sequence: itemId === "plan-1" ? 1 : 2 },
			item: {
				itemId,
				turnId: null,
				clientMessageId: null,
				providerMessageId: null,
				body: { type: "plan" as const, value: planValue },
				createdAtMs: 1,
			},
		});
		value.page.rows = [
			planRow("plan-1", {
				explanation: "Fix the pane",
				steps: [
					{ step: "Reproduce", status: "completed" },
					{ step: "Restyle", status: "in_progress" },
				],
			}),
			planRow("plan-2", { opaque: true }),
		];
		const view = render(<AgentChatSurface session={value} />);
		expect(screen.getByText("Reproduce")).toBeTruthy();
		expect(screen.getByText("Restyle")).toBeTruthy();
		expect(screen.getByText("Fix the pane")).toBeTruthy();
		expect(view.container.textContent).not.toContain('"steps"');
		expect(view.container.textContent).not.toContain('"opaque"');
		fireEvent.click(view.container.querySelector("details summary")!);
		await screen.findByText(/"opaque": true/);
	});

	it("scales the pane typography from the shared settings", () => {
		const value = session();
		const view = render(
			<AgentChatSurface
				session={value}
				typography={{ fontSize: 16, lineHeight: 1.4 }}
			/>,
		);
		const root = view.container.firstElementChild as HTMLElement;
		expect(root.style.fontSize).toBe("16px");
		expect(root.style.lineHeight).toBe("1.4");
		// Provider markdown must inherit inline — `.prose-terminal` pins its own
		// unlayered 14px/1.7 that beats any utility class.
		const prose = view.container.querySelector(
			".prose-terminal",
		) as HTMLElement;
		expect(prose.style.fontSize).toBe("inherit");
		expect(prose.style.lineHeight).toBe("inherit");
		const bare = render(<AgentChatSurface session={session()} />);
		expect(
			(bare.container.firstElementChild as HTMLElement).style.fontSize,
		).toBe("");
	});

	it("quiets expected lifecycle rows and humanizes exit payloads", () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const lifecycle = (
			itemId: string,
			sequence: number,
			state: string,
			detail: string | null,
		): AgentTimelineRowV1 => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId,
				turnId: null,
				clientMessageId: null,
				providerMessageId: null,
				body: { type: "lifecycle", state, detail } as Extract<
					AgentTimelineRowV1["item"]["body"],
					{ type: "lifecycle" }
				>,
				createdAtMs: sequence,
			},
		});
		value.page.rows = [
			lifecycle("ready-1", 1, "session_ready", null),
			lifecycle("exit-1", 2, "session_exited", '{"code":0,"signal":null}'),
		];
		const view = render(<AgentChatSurface session={value} />);
		expect(
			screen.queryByText(t("agents.chat.lifecycle.session_ready")),
		).toBeNull();
		// A clean exit is the norm — not announced at all.
		expect(
			screen.queryByText(t("agents.chat.lifecycle.session_exited")),
		).toBeNull();
		expect(view.container.textContent).not.toContain('"code"');

		value.page = {
			...value.page,
			rows: [
				lifecycle("exit-2", 3, "session_exited", '{"code":1,"signal":null}'),
			],
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(
			screen.getByText(t("agents.chat.lifecycle.session_exited")),
		).toBeTruthy();
		expect(screen.getByText("exit 1")).toBeTruthy();
	});

	it("shows a live streaming indicator only while a turn is active", () => {
		const value = session();
		const view = render(<AgentChatSurface session={value} />);
		expect(screen.queryByText(t("agents.chat.streaming"))).toBeNull();
		value.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		view.rerender(<AgentChatSurface session={value} />);
		const streaming = screen.getByText(t("agents.chat.streaming"));
		expect(streaming).toBeTruthy();
		expect(view.container.querySelectorAll(".chat-shimmer")).toHaveLength(1);
	});

	describe("live shimmer ownership", () => {
		const runningTool = (
			itemId: string,
			sequence: number,
			name: string,
			turnId = "turn-1",
			clientMessageId = "message-1",
			toolCallId = itemId,
		): AgentTimelineRowV1 => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId,
				turnId,
				clientMessageId,
				providerMessageId: `provider-${itemId}`,
				body: {
					type: "tool",
					toolCallId,
					name,
					state: "running",
					input: null,
					output: null,
				},
				createdAtMs: sequence,
			},
		});
		const lifecycle = (
			itemId: string,
			sequence: number,
			state: "turn_started" | "turn_completed",
			turnId = "turn-1",
			clientMessageId = "message-1",
		): AgentTimelineRowV1 => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId,
				turnId,
				clientMessageId,
				providerMessageId: null,
				body: { type: "lifecycle", state, detail: null },
				createdAtMs: sequence,
			},
		});
		const reasoning = (
			itemId: string,
			sequence: number,
			turnId = "turn-1",
			clientMessageId = "message-1",
		): AgentTimelineRowV1 => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId,
				turnId,
				clientMessageId,
				providerMessageId: null,
				body: { type: "reasoning", text: itemId },
				createdAtMs: sequence,
			},
		});
		const launch = (switching: boolean): AgentRuntimeLaunchSelectionView => ({
			ownerKey: "fixture-runtime",
			loaded: true,
			hydrationError: false,
			model: null,
			effort: null,
			permissionMode: "default",
			switching,
			error: null,
			switchSelection: vi.fn(),
			dismissError: vi.fn(),
			retryHydration: vi.fn(),
		});

		it("renders one live shimmer for an active tool burst", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-1",
				clientMessageId: "message-1",
			};
			value.page.rows = [
				lifecycle("turn-start", 1, "turn_started"),
				runningTool("tool-1", 2, "Read"),
				runningTool("tool-2", 3, "Bash"),
			];

			const view = render(<AgentChatSurface session={value} />);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.closest("details")).toBe(
				view.container.querySelector("details"),
			);
		});

		it("selects only the newest running burst in the active turn", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-1",
				clientMessageId: "message-1",
			};
			value.page.rows = [
				lifecycle("turn-start", 1, "turn_started"),
				runningTool("tool-old", 2, "OlderTool"),
				reasoning("reasoning", 3),
				runningTool("tool-new", 4, "NewestTool"),
			];

			const view = render(<AgentChatSurface session={value} />);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.textContent).toBe("NewestTool");
		});

		it("leaves a terminal turn's stale running snapshot static", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.page.rows = [
				lifecycle("turn-start", 1, "turn_started"),
				runningTool("tool-stale", 2, "StaleTool"),
				lifecycle("turn-completed", 3, "turn_completed"),
			];

			const view = render(<AgentChatSurface session={value} />);
			expect(view.container.textContent).toContain("StaleTool");
			expect(view.container.querySelectorAll(".chat-shimmer")).toHaveLength(0);
		});

		it("ignores an older stale turn when the authoritative turn has no tool", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-2",
				clientMessageId: "message-2",
			};
			value.page.rows = [
				lifecycle("turn-1-start", 1, "turn_started"),
				runningTool("tool-stale", 2, "StaleTool"),
				lifecycle("turn-2-start", 3, "turn_started", "turn-2", "message-2"),
				reasoning("turn-2-reasoning", 4, "turn-2", "message-2"),
			];

			const view = render(<AgentChatSurface session={value} />);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.textContent).toBe(t("agents.chat.streaming"));
		});

		it("fences a reused tool identity to the authoritative turn", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-2",
				clientMessageId: "message-2",
			};
			value.page.rows = [
				lifecycle("turn-1-start", 1, "turn_started"),
				runningTool(
					"tool-old",
					2,
					"OlderTool",
					"turn-1",
					"message-1",
					"shared-call",
				),
				lifecycle("turn-2-start", 3, "turn_started", "turn-2", "message-2"),
				runningTool(
					"tool-new",
					4,
					"NewestTool",
					"turn-2",
					"message-2",
					"shared-call",
				),
			];

			const view = render(<AgentChatSurface session={value} />);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.textContent).toBe("NewestTool");
		});

		it("preserves the full turn identity when turn and tool IDs are reused", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "shared-turn",
				clientMessageId: "message-2",
			};
			value.page.rows = [
				lifecycle(
					"turn-1-start",
					1,
					"turn_started",
					"shared-turn",
					"message-1",
				),
				runningTool(
					"tool-old",
					2,
					"OlderTool",
					"shared-turn",
					"message-1",
					"shared-call",
				),
				lifecycle(
					"turn-2-start",
					3,
					"turn_started",
					"shared-turn",
					"message-2",
				),
				runningTool(
					"tool-new",
					4,
					"NewestTool",
					"shared-turn",
					"message-2",
					"shared-call",
				),
			];

			const view = render(<AgentChatSurface session={value} />);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.textContent).toBe("NewestTool");
		});

		it("shows reconnect status without presenting it as a runtime switch", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-1",
				clientMessageId: "message-1",
			};
			value.reconnecting = true;
			value.page.rows = [
				lifecycle("turn-start", 1, "turn_started"),
				runningTool("tool-running", 2, "RunningTool"),
			];

			const view = render(
				<AgentChatSurface session={value} launchSelection={launch(false)} />,
			);
			expect(view.container.querySelectorAll(".chat-shimmer")).toHaveLength(0);
			expect(screen.getByText(t("agents.chat.reconnecting"))).toBeTruthy();
		});

		it("gives an intentional runtime switch the sole composer shimmer", () => {
			const value = session();
			if (!value.page) throw new Error("expected a timeline page");
			value.activeTurn = {
				turnId: "turn-1",
				clientMessageId: "message-1",
			};
			value.page.rows = [
				lifecycle("turn-start", 1, "turn_started"),
				runningTool("tool-running", 2, "RunningTool"),
			];

			const view = render(
				<AgentChatSurface session={value} launchSelection={launch(true)} />,
			);
			const shimmers = view.container.querySelectorAll(".chat-shimmer");
			expect(shimmers).toHaveLength(1);
			expect(shimmers[0]?.closest("form")).toBeTruthy();
			expect(shimmers[0]?.textContent).toBe(t("agents.chat.switching"));
		});
	});

	it("does not reserialize an unchanged tool snapshot for live text", async () => {
		const value = session();
		if (!value.page) throw new Error("expected a timeline page");
		const input = { file_path: "README.md" };
		value.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "tool-running",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-tool-1",
					body: {
						type: "tool",
						toolCallId: "tool-call-1",
						name: "Read",
						state: "running",
						input,
						output: null,
					},
					createdAtMs: 1,
				},
			},
		];
		const stringify = vi.spyOn(JSON, "stringify");
		const view = render(<AgentChatSurface session={value} />);
		expect(
			stringify.mock.calls.filter(([entry]) => entry === input),
		).toHaveLength(0);
		fireEvent.click(view.container.querySelector("summary")!);
		const tool = (await screen.findByText("Read")).closest("details")!;
		fireEvent.click(tool.querySelector("summary")!);
		await screen.findByText(/"file_path"/);
		expect(
			stringify.mock.calls.filter(([entry]) => entry === input),
		).toHaveLength(1);

		value.page = {
			...value.page,
			liveText: [
				{
					streamId: "assistant-live",
					itemId: "assistant-live-item",
					kind: "assistant",
					text: "working",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					updatedAtMs: 2,
				},
			],
		};
		view.rerender(<AgentChatSurface session={value} />);
		expect(
			stringify.mock.calls.filter(([entry]) => entry === input),
		).toHaveLength(1);
	});

	it("submits with Enter and keeps Shift+Enter for a newline", () => {
		const value = session();
		render(<AgentChatSurface session={value} />);
		const composer = screen.getByRole("textbox");
		fireEvent.change(composer, { target: { value: "hello" } });
		fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
		expect(value.send).not.toHaveBeenCalled();
		fireEvent.keyDown(composer, { key: "Enter" });
		expect(value.send).toHaveBeenCalledWith("hello");
	});

	it("does not infer an expired sign-in from a provider failure", () => {
		const value = session();
		value.page = undefined;
		value.phase = "error";
		value.error = "agent_conversation_provider_failed";
		// Recovery handlers exist; only an explicit provider-reported reason
		// may ever surface them.
		render(
			<AgentChatSurface
				session={value}
				recovery={{
					switchAccount: { targetName: "other", run: vi.fn() },
					manageAccounts: vi.fn(),
					signIn: vi.fn(),
				}}
			/>,
		);
		expect(screen.getByText("agent_conversation_provider_failed")).toBeTruthy();
		expect(screen.getAllByRole("button")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));
		expect(value.retryConnection).toHaveBeenCalledTimes(1);
	});

	it("keeps durable history visible and offers explicit runtime recovery", () => {
		const value = session();
		value.error = "backend unavailable";
		render(<AgentChatSurface session={value} />);
		expect(screen.getByText("backend unavailable")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));
		expect(value.retryConnection).toHaveBeenCalledTimes(1);
	});

	it("reports the first authoritative snapshot as pane-ready once", () => {
		const value = session();
		const onReady = vi.fn();
		const view = render(<AgentChatSurface session={value} onReady={onReady} />);
		expect(onReady).toHaveBeenCalledTimes(1);
		view.rerender(<AgentChatSurface session={value} onReady={onReady} />);
		expect(onReady).toHaveBeenCalledTimes(1);
	});
});

beforeEach(() => useStore.setState({ chatDrafts: {} }));

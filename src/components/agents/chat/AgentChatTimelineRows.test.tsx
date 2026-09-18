// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { buildPromptWithAttachments } from "@/lib/agents/attachmentPrompt";
import { projectAgentChatTranscript } from "@/lib/agents/chat/agentChatProjection";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import { opaqueJsonText } from "@/lib/agents/chat/chatFormat";
import { t } from "@/lib/i18n";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

const mocks = vi.hoisted(() => ({
	renderMarkdown: vi.fn(),
	readChatAttachment: vi.fn(),
}));

vi.mock("@/lib/agents/chat/chatFormat", { spy: true });

vi.mock("@/lib/ipc", () => ({
	readChatAttachment: (path: string) => mocks.readChatAttachment(path),
}));

vi.mock("@/components/agents/chat/ChatMarkdown", () => ({
	ChatMarkdown: ({ markdown }: { markdown: string }) => {
		mocks.renderMarkdown(markdown);
		return <div>{markdown}</div>;
	},
}));

function page(): AgentTimelinePageV1 {
	return {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			agentId: "agent-1",
			providerId: "codex",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: {
				runtimeGeneration: "runtime-1",
				providerEpoch: "provider-1",
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
					itemId: "historical-message",
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-message-1",
					body: {
						type: "message",
						role: "assistant",
						markdown: "historical markdown",
					},
					createdAtMs: 1,
				},
			},
		],
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		latestFailure: null,
		goal: null,
		finalCursor: { epoch: "timeline-1", sequence: 1 },
		hasMore: false,
	};
}

function pageWithDuplicateTurnStart(): AgentTimelinePageV1 {
	const value = page();
	value.rows = [
		{
			cursor: { epoch: "timeline-1", sequence: 1 },
			item: {
				itemId: "client-turn-start",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: null,
				body: { type: "lifecycle", state: "turn_started", detail: null },
				createdAtMs: 1,
			},
		},
		{
			cursor: { epoch: "timeline-1", sequence: 2 },
			item: {
				itemId: "user-message",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: null,
				body: { type: "message", role: "user", markdown: "client prompt" },
				createdAtMs: 2,
			},
		},
		{
			cursor: { epoch: "timeline-1", sequence: 3 },
			item: {
				itemId: "provider-turn-start",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: "provider-start",
				body: { type: "lifecycle", state: "turn_started", detail: null },
				createdAtMs: 3,
			},
		},
		{
			cursor: { epoch: "timeline-1", sequence: 4 },
			item: {
				itemId: "assistant-message",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: "provider-message",
				body: {
					type: "message",
					role: "assistant",
					markdown: "provider answer",
				},
				createdAtMs: 4,
			},
		},
		{
			cursor: { epoch: "timeline-1", sequence: 5 },
			item: {
				itemId: "turn-complete",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: "provider-complete",
				body: { type: "lifecycle", state: "turn_completed", detail: null },
				createdAtMs: 5,
			},
		},
	];
	value.finalCursor = { epoch: "timeline-1", sequence: 5 };
	return value;
}

function pageWithBackfilledFailedTurn(): AgentTimelinePageV1 {
	const value = pageWithDuplicateTurnStart();
	value.rows[4] = {
		cursor: { epoch: "timeline-1", sequence: 5 },
		item: {
			itemId: "turn-failed",
			turnId: "shared-turn",
			clientMessageId: "shared-message",
			providerMessageId: null,
			body: {
				type: "lifecycle",
				state: "turn_failed",
				detail: "runtime_replaced",
			},
			createdAtMs: 5,
		},
	};
	value.rows.push(
		{
			cursor: { epoch: "timeline-1", sequence: 6 },
			item: {
				itemId: "backfilled-assistant-message",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: "provider-backfill",
				body: {
					type: "message",
					role: "assistant",
					markdown: "backfilled answer",
				},
				createdAtMs: 1,
			},
		},
		{
			cursor: { epoch: "timeline-1", sequence: 7 },
			item: {
				itemId: "backfilled-turn-canceled",
				turnId: "shared-turn",
				clientMessageId: "shared-message",
				providerMessageId: null,
				body: { type: "lifecycle", state: "turn_canceled", detail: null },
				createdAtMs: 1,
			},
		},
	);
	value.finalCursor = { epoch: "timeline-1", sequence: 7 };
	return value;
}

const attachmentObservers = new Map<Element, (visible: boolean) => void>();

function revealAttachments(count = attachmentObservers.size) {
	act(() => {
		for (const reveal of [...attachmentObservers.values()].slice(0, count)) {
			reveal(true);
		}
	});
}

function attachmentPage(paths: string[]) {
	const source = page();
	source.rows[0]!.item.body = {
		type: "message",
		role: "user",
		markdown: buildPromptWithAttachments("Images", paths),
	};
	return source;
}

describe("TranscriptContents", () => {
	beforeEach(() => {
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				private targets = new Set<Element>();
				constructor(private callback: IntersectionObserverCallback) {}
				observe(target: Element) {
					this.targets.add(target);
					attachmentObservers.set(target, (isIntersecting) =>
						this.callback(
							[{ target, isIntersecting } as IntersectionObserverEntry],
							this as unknown as IntersectionObserver,
						),
					);
				}
				disconnect() {
					for (const target of this.targets) attachmentObservers.delete(target);
					this.targets.clear();
				}
			},
		);
	});

	afterEach(() => {
		cleanup();
		attachmentObservers.clear();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		mocks.renderMarkdown.mockClear();
		vi.mocked(opaqueJsonText).mockClear();
	});

	it("serializes opaque plans only while expanded, including after appends and updates", async () => {
		const initial = page();
		const template = initial.rows[0]!;
		initial.rows = Array.from({ length: 16 }, (_, index) => ({
			cursor: { epoch: "timeline-1", sequence: index + 1 },
			item: {
				...template.item,
				itemId: `plan-${index}`,
				body: {
					type: "plan" as const,
					value: { opaqueDetails: "x".repeat(32_768) },
				},
			},
		}));
		initial.finalCursor = { epoch: "timeline-1", sequence: 16 };
		const transcript = (source: AgentTimelinePageV1) => (
			<TranscriptContents
				page={source}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>
		);
		const view = render(transcript(initial));
		expect(opaqueJsonText).not.toHaveBeenCalled();
		expect(view.container.querySelector("pre")).toBeNull();

		const appended = {
			...initial,
			rows: [
				...initial.rows,
				{ ...template, cursor: { epoch: "timeline-1", sequence: 17 } },
			],
			finalCursor: { epoch: "timeline-1", sequence: 17 },
		};
		view.rerender(transcript(appended));
		expect(screen.getByText("historical markdown")).toBeTruthy();
		expect(opaqueJsonText).not.toHaveBeenCalled();

		const disclosure = view.container.querySelector("details")!;
		fireEvent.click(disclosure.querySelector("summary")!);
		await waitFor(() => expect(opaqueJsonText).toHaveBeenCalledTimes(1));
		expect(view.container.querySelectorAll("pre")).toHaveLength(1);
		expect(disclosure.textContent).toContain("x".repeat(32_768));

		const update = (opaqueDetails: string) => ({
			...appended,
			rows: appended.rows.map((row, index) =>
				index === 0
					? {
							...row,
							item: {
								...row.item,
								body: { type: "plan" as const, value: { opaqueDetails } },
							},
						}
					: row,
			),
		});
		view.rerender(transcript(update("Updated while open")));
		expect(disclosure.textContent).toContain("Updated while open");
		expect(opaqueJsonText).toHaveBeenCalledTimes(2);

		fireEvent.click(disclosure.querySelector("summary")!);
		await waitFor(() => expect(view.container.querySelector("pre")).toBeNull());
		view.rerender(transcript(update("Latest closed snapshot")));
		expect(opaqueJsonText).toHaveBeenCalledTimes(2);
		fireEvent.click(disclosure.querySelector("summary")!);
		await waitFor(() =>
			expect(disclosure.textContent).toContain("Latest closed snapshot"),
		);
		expect(opaqueJsonText).toHaveBeenCalledTimes(3);
	});

	it("reads only the four nearby attachments among twenty mounted images", async () => {
		mocks.readChatAttachment
			.mockReset()
			.mockResolvedValue({ mime: "image/png", dataB64: "aGk=" });
		const paths = Array.from(
			{ length: 20 },
			(_, index) => `/home/x/.dure/chat-attachments/session-1/${index}.png`,
		);
		const view = render(
			<TranscriptContents
				page={attachmentPage(paths)}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		expect(mocks.readChatAttachment).not.toHaveBeenCalled();
		revealAttachments(4);
		expect(mocks.readChatAttachment).toHaveBeenCalledTimes(4);
		await view.findByAltText("3.png");
		expect(view.queryByAltText("4.png")).toBeNull();
		expect(view.getByText("4.png")).toBeTruthy();
		expect(mocks.readChatAttachment.mock.calls.map(([path]) => path)).toEqual(
			paths.slice(0, 4),
		);
		revealAttachments(1);
		await view.findByAltText("4.png");
		expect(mocks.readChatAttachment).toHaveBeenCalledTimes(5);
	});

	it("ignores non-intersections and duplicate notifications after a failed read", async () => {
		mocks.readChatAttachment.mockReset().mockRejectedValue(new Error("gone"));
		const view = render(
			<TranscriptContents
				page={attachmentPage([
					"/home/x/.dure/chat-attachments/session-1/missing.png",
				])}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		const [notify] = attachmentObservers.values();
		expect(notify).toBeTypeOf("function");
		act(() => notify!(false));
		expect(mocks.readChatAttachment).not.toHaveBeenCalled();
		await act(async () => notify!(true));
		act(() => {
			notify!(false);
			notify!(true);
		});
		expect(mocks.readChatAttachment).toHaveBeenCalledTimes(1);
		expect(view.getByText("missing.png")).toBeTruthy();
		expect(view.queryByAltText("missing.png")).toBeNull();
		expect(attachmentObservers.size).toBe(0);
	});

	it("does not read an attachment after its row unmounts before intersection", () => {
		mocks.readChatAttachment.mockReset();
		const view = render(
			<TranscriptContents
				page={attachmentPage([
					"/home/x/.dure/chat-attachments/session-1/hidden.png",
				])}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		const [notify] = attachmentObservers.values();
		expect(notify).toBeTypeOf("function");
		view.unmount();
		act(() => notify!(true));
		expect(mocks.readChatAttachment).not.toHaveBeenCalled();
		expect(attachmentObservers.size).toBe(0);
	});

	it("discards a late attachment read after the message replaces its path", async () => {
		let finish!: (value: { mime: string; dataB64: string }) => void;
		mocks.readChatAttachment
			.mockReset()
			.mockResolvedValue({ mime: "image/png", dataB64: "bmV3" })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
		const view = render(
			<TranscriptContents
				page={attachmentPage([
					"/home/x/.dure/chat-attachments/session-1/old.png",
				])}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		revealAttachments();
		view.rerender(
			<TranscriptContents
				page={attachmentPage([
					"/home/x/.dure/chat-attachments/session-1/new.png",
				])}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		expect(view.queryByAltText("old.png")).toBeNull();
		expect(view.getByText("new.png")).toBeTruthy();
		revealAttachments();
		const image = await view.findByAltText("new.png");
		await act(async () => finish({ mime: "image/png", dataB64: "b2xk" }));
		expect(image.getAttribute("src")).toBe("data:image/png;base64,bmV3");
		expect(view.queryByAltText("old.png")).toBeNull();
		expect(mocks.readChatAttachment).toHaveBeenCalledTimes(2);
	});

	it.each([20, 120, 127, 128, 1_000])(
		"mounts and parses only a viewport window of %i retained answers",
		(count) => {
			const height = vi
				.spyOn(HTMLElement.prototype, "offsetHeight", "get")
				.mockReturnValue(600);
			try {
				const source = page();
				const template = source.rows[0]!;
				source.rows = Array.from({ length: count }, (_, index) => ({
					cursor: { epoch: "timeline-1", sequence: index + 1 },
					item: {
						...template.item,
						itemId: `item-${index}`,
						turnId: "long-turn",
						clientMessageId: "long-message",
						body: {
							type: "message" as const,
							role: "assistant" as const,
							markdown: `Answer ${index}\n\n${"- List item with **detail**\n".repeat(20)}`,
						},
					},
				}));
				const view = render(
					<TranscriptContents
						page={source}
						loadingOlder={false}
						onLoadOlder={async () => {}}
					/>,
				);
				const mounted = view.container.querySelectorAll(
					"[data-agent-chat-row-anchors]",
				).length;
				expect(mounted).toBeGreaterThan(0);
				expect(mounted).toBeLessThan(Math.min(count, 32));
				expect(mocks.renderMarkdown.mock.calls.length).toBeGreaterThan(0);
				expect(mocks.renderMarkdown.mock.calls.length).toBeLessThan(
					Math.min(count, 40),
				);
				expect(source.rows).toHaveLength(count);
			} finally {
				cleanup();
				height.mockRestore();
			}
		},
	);

	it("does not rerender retained history for a live-text-only update", () => {
		const initial = page();
		const view = render(
			<TranscriptContents
				page={initial}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);

		view.rerender(
			<TranscriptContents
				page={{
					...initial,
					liveText: [
						{
							streamId: "live-1",
							itemId: "live-item-1",
							kind: "assistant",
							text: "live markdown",
							turnId: null,
							clientMessageId: null,
							providerMessageId: "provider-message-live",
							updatedAtMs: 2,
						},
					],
				}}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);

		expect(
			mocks.renderMarkdown.mock.calls.filter(
				([markdown]) => markdown === "historical markdown",
			),
		).toHaveLength(1);
		expect(mocks.renderMarkdown).toHaveBeenCalledWith("live markdown");
	});

	it("offers an action when earlier canonical history is available", () => {
		const initial = page();
		initial.hasMore = true;
		const loadOlder = vi.fn(async () => {});
		render(
			<TranscriptContents
				page={initial}
				loadingOlder={false}
				onLoadOlder={loadOlder}
			/>,
		);

		const action = screen.getByRole("button", {
			name: t("agents.chat.loadEarlierHistory"),
		});
		action.click();
		expect(loadOlder).toHaveBeenCalledTimes(1);
	});

	it("renders duplicate client and provider turn-start evidence with one key", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const view = render(
				<TranscriptContents
					page={pageWithDuplicateTurnStart()}
					loadingOlder={false}
					onLoadOlder={async () => {}}
				/>,
			);

			expect(view.getByText("client prompt")).toBeTruthy();
			expect(view.getByText("provider answer")).toBeTruthy();
			expect(
				view.container.querySelectorAll('[class~="group/turn"]'),
			).toHaveLength(1);
			expect(
				consoleError.mock.calls.filter(
					([message]) =>
						typeof message === "string" && message.includes("same key"),
				),
			).toEqual([]);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("gives a backfilled span of the same failed turn a unique render key", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const source = pageWithBackfilledFailedTurn();
			expect(
				projectAgentChatTranscript(source.rows).flatMap((block) =>
					block.kind === "turn" ? [block.key] : [],
				),
			).toEqual(["timeline-1:1", "timeline-1:6"]);
			const view = render(
				<TranscriptContents
					page={source}
					loadingOlder={false}
					onLoadOlder={async () => {}}
				/>,
			);

			expect(view.getByText("provider answer")).toBeTruthy();
			expect(view.getByText("backfilled answer")).toBeTruthy();
			expect(
				view.container.querySelectorAll('[class~="group/turn"]'),
			).toHaveLength(2);
			expect(
				consoleError.mock.calls.filter(
					([message]) =>
						typeof message === "string" && message.includes("same key"),
				),
			).toEqual([]);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("renders pasted attachments as images and hides the file references", async () => {
		mocks.readChatAttachment.mockReset().mockResolvedValue({
			mime: "image/png",
			dataB64: "aGk=",
		});
		const source = page();
		source.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "user-attachment",
					turnId: "turn-1",
					clientMessageId: "client-1",
					providerMessageId: null,
					body: {
						type: "message",
						role: "user",
						markdown:
							"what is this?\n\nRead the attached image 1 before starting: /home/x/.dure/chat-attachments/session-1/1-shot.png",
					},
					createdAtMs: 5,
				},
			},
		];
		const view = render(
			<TranscriptContents
				page={source}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		expect(view.getByText("what is this?")).toBeTruthy();
		expect(view.queryByText(/Read the attached image/)).toBeNull();
		revealAttachments();
		const image = await view.findByAltText("1-shot.png");
		expect(image.getAttribute("src")).toBe("data:image/png;base64,aGk=");
		expect(mocks.readChatAttachment).toHaveBeenCalledWith(
			"/home/x/.dure/chat-attachments/session-1/1-shot.png",
		);
	});

	it("releases attachment data with the mounted transcript", async () => {
		mocks.readChatAttachment.mockReset().mockResolvedValue({
			mime: "image/png",
			dataB64: "aGk=",
		});
		const source = page();
		source.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "user-attachment-lifetime",
					turnId: "turn-1",
					clientMessageId: "client-1",
					providerMessageId: null,
					body: {
						type: "message",
						role: "user",
						markdown:
							"Read the attached image 1 before starting: /home/x/.dure/chat-attachments/session-1/lifetime.png",
					},
					createdAtMs: 5,
				},
			},
		];
		const renderTranscript = () =>
			render(
				<TranscriptContents
					page={source}
					loadingOlder={false}
					onLoadOlder={async () => {}}
				/>,
			);

		const first = renderTranscript();
		revealAttachments();
		await first.findByAltText("lifetime.png");
		first.unmount();
		const second = renderTranscript();
		revealAttachments();
		await second.findByAltText("lifetime.png");

		expect(mocks.readChatAttachment).toHaveBeenCalledTimes(2);
	});

	it("keeps the filename visible when the attachment cannot be read", async () => {
		mocks.readChatAttachment.mockRejectedValue(new Error("gone"));
		const source = page();
		source.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "user-attachment-missing",
					turnId: "turn-1",
					clientMessageId: "client-1",
					providerMessageId: null,
					body: {
						type: "message",
						role: "user",
						markdown:
							"Read the attached image 1 before starting: /home/x/.dure/chat-attachments/session-1/2-gone.png",
					},
					createdAtMs: 5,
				},
			},
		];
		const view = render(
			<TranscriptContents
				page={source}
				loadingOlder={false}
				onLoadOlder={async () => {}}
			/>,
		);
		revealAttachments();
		expect(await view.findByText("2-gone.png")).toBeTruthy();
	});

	it("shows elapsed time since the live turn's user message while active", () => {
		vi.useFakeTimers();
		vi.setSystemTime(95_000);
		try {
			const source = page();
			source.rows = [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "user-live",
						turnId: "turn-live",
						clientMessageId: "client-live",
						providerMessageId: null,
						body: { type: "message", role: "user", markdown: "go" },
						createdAtMs: 10_000,
					},
				},
			];
			const view = render(
				<TranscriptContents
					page={source}
					active
					loadingOlder={false}
					onLoadOlder={async () => {}}
				/>,
			);
			expect(view.getByText("1m 25s")).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("pauses elapsed presentation while its retained workspace is inactive", () => {
		vi.useFakeTimers();
		vi.setSystemTime(95_000);
		const roleStore = new TerminalPresentationRoleStore();
		let view: ReturnType<typeof render> | undefined;
		try {
			const source = page();
			source.rows = [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "user-live",
						turnId: "turn-live",
						clientMessageId: "client-live",
						providerMessageId: null,
						body: { type: "message", role: "user", markdown: "go" },
						createdAtMs: 10_000,
					},
				},
			];
			const route = (active: boolean) => (
				<WorkspaceRuntimeProvider
					desktopId="desktop-1"
					active={active}
					presentationRoleStore={roleStore}
					commitLayout={() => true}
				>
					<TranscriptContents
						page={source}
						active
						loadingOlder={false}
						onLoadOlder={async () => {}}
					/>
				</WorkspaceRuntimeProvider>
			);
			view = render(route(true));
			// Settle the virtualizer's initial scroll frame before counting elapsed timers.
			act(() => vi.advanceTimersToNextFrame());
			expect(view.getByText("1m 25s")).toBeTruthy();
			expect(vi.getTimerCount()).toBe(1);

			act(() => {
				vi.advanceTimersByTime(1_000);
			});
			expect(view.getByText("1m 26s")).toBeTruthy();

			act(() => {
				view?.rerender(route(false));
			});
			expect(vi.getTimerCount()).toBe(0);

			act(() => {
				vi.advanceTimersByTime(4_000);
			});
			expect(view.getByText("1m 26s")).toBeTruthy();

			act(() => {
				view?.rerender(route(true));
			});
			expect(view.getByText("1m 30s")).toBeTruthy();
			expect(vi.getTimerCount()).toBe(1);

			act(() => {
				vi.advanceTimersByTime(1_000);
			});
			expect(view.getByText("1m 31s")).toBeTruthy();
		} finally {
			view?.unmount();
			vi.useRealTimers();
		}
	});
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { chatInputLatency } from "@/lib/agents/chat/chatInputLatency";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { chatComposerSessionFixture as session } from "@/test/chatComposerSessionFixture";
import { openSelect } from "@/test/select";

beforeEach(() => {
	useStore.setState((state) => ({
		chatDrafts: {},
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
	}));
});

afterEach(() => {
	cleanup();
	chatInputLatency.resetMeasurements();
});

function row(
	sequence: number,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId: "turn-1",
			clientMessageId: "message-1",
			providerMessageId: null,
			createdAtMs: sequence,
			body,
		},
	};
}

function countedRows(rows: AgentTimelineRowV1[]) {
	let reads = 0;
	return {
		rows: new Proxy(rows, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
				return Reflect.get(target, key, receiver);
			},
		}),
		reads: () => reads,
	};
}

it("does not revisit 4096 history rows for 20 draft edits or a live-text snapshot", () => {
	const history = countedRows(
		Array.from({ length: 4096 }, (_, index) =>
			row(index + 1, {
				type: "message",
				role: "assistant",
				markdown: "History",
			}),
		),
	);
	const value = session("codex");
	value.page = { ...value.page!, rows: history.rows };
	const view = render(<ChatComposer session={value} disabled={false} />);
	const initialReads = history.reads();
	expect(initialReads).toBeGreaterThan(0);
	const input = screen.getByRole<HTMLTextAreaElement>("textbox");
	for (let index = 1; index <= 20; index += 1) {
		fireEvent.change(input, { target: { value: "a".repeat(index) } });
	}
	expect(input.value).toBe("a".repeat(20));
	expect(history.reads() - initialReads).toBe(0);

	view.rerender(
		<ChatComposer
			session={{
				...value,
				page: {
					...value.page!,
					liveText: [
						{
							streamId: "stream-1",
							itemId: "streamed-item",
							kind: "assistant",
							text: "Streaming",
							turnId: "turn-1",
							clientMessageId: "message-1",
							providerMessageId: "provider-message-1",
							updatedAtMs: 4097,
						},
					],
				},
			}}
			disabled={false}
		/>,
	);
	expect(history.reads() - initialReads).toBe(0);
});

function facts(sequence: number, model: string, label: string, reason: string) {
	return [
		row(sequence, {
			type: "provider_evidence",
			namespace: "provider.codex",
			kind: "provider_session_initialized",
			value: { model },
		}),
		row(sequence + 1, {
			type: "provider_evidence",
			namespace: "provider.codex",
			kind: "provider_catalog",
			value: { models: [{ value: model, displayName: label }] },
		}),
		row(sequence + 2, {
			type: "lifecycle",
			state: "turn_failed",
			detail: reason,
		}),
	];
}

function expectModelOption(label: string, absent?: string) {
	openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
	expect(screen.getByRole("option", { name: label })).toBeTruthy();
	if (absent)
		expect(screen.queryByRole("option", { name: absent })).toBeNull();
	fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
}

it("refreshes observed model, catalog and failure when the page changes and clears them on detach", () => {
	const value = session("codex");
	value.page = {
		...value.page!,
		rows: facts(1, "reported-one", "Choice One", "usage_limit"),
		recovery: null,
		latestFailure: { itemId: "item-3", createdAtMs: 3, reason: "usage_limit", userInput: null },
	};
	const recovery = { manageAccounts: vi.fn() };
	const view = render(
		<ChatComposer session={value} disabled={false} recovery={recovery} />,
	);
	expect(screen.getByText("reported-one")).toBeTruthy();
	expect(
		screen.getByText(t("agents.chat.turnFailure.usageLimit")),
	).toBeTruthy();
	expectModelOption("Choice One");

	const next = {
		...value,
		page: {
			...value.page,
			rows: facts(4, "reported-two", "Choice Two", "rate_limit"),
			recovery: null,
			latestFailure: { itemId: "item-6", createdAtMs: 6, reason: "rate_limit" as const, userInput: null },
		},
	};
	view.rerender(
		<ChatComposer session={next} disabled={false} recovery={recovery} />,
	);
	expect(screen.getByText("reported-two")).toBeTruthy();
	expect(screen.queryByText("reported-one")).toBeNull();
	expect(screen.getByText(t("agents.chat.turnFailure.rateLimit"))).toBeTruthy();
	expect(
		screen.queryByText(t("agents.chat.turnFailure.usageLimit")),
	).toBeNull();
	expectModelOption("Choice Two", "Choice One");

	view.rerender(
		<ChatComposer
			session={{ ...next, page: undefined }}
			disabled={false}
			recovery={recovery}
		/>,
	);
	expect(screen.queryByText("reported-two")).toBeNull();
	expect(
		screen.queryByRole("combobox", { name: t("agents.chat.modelLabel") }),
	).toBeNull();
	expect(screen.queryByText(t("agents.chat.turnFailure.rateLimit"))).toBeNull();
});

it("updates failure visibility for active-turn changes without revisiting unchanged rows", () => {
	const value = session("codex");
	const history = countedRows(facts(1, "reported", "Choice", "usage_limit"));
	value.page = { ...value.page!, rows: history.rows, latestFailure: { itemId: "item-3", createdAtMs: 3, reason: "usage_limit", userInput: null } };
	const recovery = { manageAccounts: vi.fn() };
	const view = render(
		<ChatComposer session={value} disabled={false} recovery={recovery} />,
	);
	const initialReads = history.reads();
	const failure = t("agents.chat.turnFailure.usageLimit");
	expect(screen.getByText(failure)).toBeTruthy();
	view.rerender(
		<ChatComposer
			session={{
				...value,
				activeTurn: { turnId: "turn-2", clientMessageId: "message-2" },
			}}
			disabled={false}
			recovery={recovery}
		/>,
	);
	expect(screen.queryByText(failure)).toBeNull();
	view.rerender(
		<ChatComposer session={value} disabled={false} recovery={recovery} />,
	);
	expect(screen.getByText(failure)).toBeTruthy();
	expect(history.reads() - initialReads).toBe(0);
});

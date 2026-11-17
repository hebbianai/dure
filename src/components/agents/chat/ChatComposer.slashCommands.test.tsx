// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { chatComposerSessionFixture } from "@/test/chatComposerSessionFixture";

vi.mock("@/lib/ipc", () => ({
	readClipboardImage: vi.fn(async () => null),
	saveChatAttachments: vi.fn(async () => []),
}));

const launch: AgentRuntimeLaunchSelectionView = {
	ownerKey: "fixture-runtime",
	loaded: true,
	hydrationError: false,
	model: "fable",
	effort: null,
	permissionMode: "default",
	switching: false,
	error: null,
	switchSelection: vi.fn(),
	retryHydration: vi.fn(),
	dismissError: vi.fn(),
};

function claudeSession(): AgentChatSessionView {
	const value = chatComposerSessionFixture("claude");
	value.page = {
		...value.page!,
		rows: [
			...value.page!.rows,
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "commands",
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					createdAtMs: 2,
					body: {
						type: "provider_evidence",
						namespace: "provider.claude",
						kind: "provider_commands",
						value: {
							commands: [
								{
									name: "compact",
									description: "Clear history but keep a summary",
									argumentHint: "<instructions>",
								},
								{ name: "review", description: "Review a pull request" },
								{ name: "clear", description: "Provider clear" },
							],
						},
					},
				},
			},
		],
	};
	return value;
}

function composer() {
	return screen.getByRole<HTMLTextAreaElement>("textbox", {
		name: t("agents.chat.composerLabel"),
	});
}

function type(value: string) {
	fireEvent.change(composer(), { target: { value } });
}

async function press(key: string) {
	await act(async () => {
		fireEvent.keyDown(composer(), { key });
	});
}

beforeEach(() => {
	useStore.setState((state) => ({
		chatDrafts: {},
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
	}));
	const prototype = window.Element.prototype;
	prototype.hasPointerCapture ??= () => false;
	prototype.setPointerCapture ??= () => {};
	prototype.releasePointerCapture ??= () => {};
	prototype.scrollIntoView ??= () => {};
});

afterEach(() => cleanup());

describe("ChatComposer slash commands", () => {
	it("lists Dure's and the provider's commands when the draft starts with /", () => {
		render(
			<ChatComposer
				session={claudeSession()}
				disabled={false}
				launch={launch}
				onNewConversation={vi.fn()}
			/>,
		);
		type("/");
		const palette = screen.getByRole("listbox", { name: t("agents.chat.commandsLabel") });
		expect(
			within(palette)
				.getAllByRole("option")
				.map((option) => option.querySelector("span")?.textContent),
		).toEqual(["/clear", "/model", "/compact", "/review"]);

		type("/rev");
		expect(
			within(screen.getByRole("listbox", { name: t("agents.chat.commandsLabel") }))
				.getAllByRole("option")
				.map((option) => option.getAttribute("aria-selected")),
		).toEqual(["true"]);

		type("/review the diff");
		expect(screen.queryByRole("listbox", { name: t("agents.chat.commandsLabel") })).toBeNull();
	});

	it("runs a provider command through the provider as its own input", async () => {
		const value = claudeSession();
		render(<ChatComposer session={value} disabled={false} launch={launch} />);
		type("/comp");
		// A command with arguments completes first, then runs.
		await press("Enter");
		expect(composer().value).toBe("/compact ");
		expect(value.send).not.toHaveBeenCalled();
		await press("Enter");
		expect(value.send).toHaveBeenCalledWith("/compact");

		type("/compact");
		await press("Enter");
		expect(value.send).toHaveBeenLastCalledWith("/compact");
	});

	it("opens the model picker for /model instead of sending it", async () => {
		const value = claudeSession();
		render(<ChatComposer session={value} disabled={false} launch={launch} />);
		const input = composer();
		type("/model");
		await press("Enter");
		expect(value.send).not.toHaveBeenCalled();
		// The open menu is modal: it hides the rest of the pane from queries.
		expect(input.value).toBe("");
		expect(
			screen
				.getByRole("combobox", { name: t("agents.chat.modelLabel"), hidden: true })
				.getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("starts a new conversation for /clear, shadowing the provider's own /clear", async () => {
		const value = claudeSession();
		const onNewConversation = vi.fn();
		render(
			<ChatComposer
				session={value}
				disabled={false}
				launch={launch}
				onNewConversation={onNewConversation}
			/>,
		);
		type("/clear");
		await press("Enter");
		expect(onNewConversation).toHaveBeenCalledOnce();
		expect(value.send).not.toHaveBeenCalled();
	});

	it("keeps an unknown command in the draft with an inline reason", async () => {
		const value = claudeSession();
		render(<ChatComposer session={value} disabled={false} launch={launch} />);
		type("/nope");
		await press("Enter");
		expect(value.send).not.toHaveBeenCalled();
		expect(composer().value).toBe("/nope");
		expect(
			screen.getByText(t("agents.chat.commandUnknown", { name: "nope" })),
		).toBeTruthy();
		// A path is ordinary text, not a command.
		type("/Users/me/notes.md what is this?");
		await press("Enter");
		expect(value.send).toHaveBeenCalledWith("/Users/me/notes.md what is this?");
	});

	it("does not steer a provider command into a running turn", async () => {
		const value = claudeSession();
		value.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
			startedAtMs: 1,
		} as AgentChatSessionView["activeTurn"];
		render(<ChatComposer session={value} disabled={false} launch={launch} />);
		type("/review");
		await press("Escape");
		expect(screen.queryByRole("listbox", { name: t("agents.chat.commandsLabel") })).toBeNull();
		await press("Enter");
		expect(value.steerOrQueue).not.toHaveBeenCalled();
		expect(value.send).not.toHaveBeenCalled();
		expect(
			screen.getByText(t("agents.chat.commandBusy", { name: "review" })),
		).toBeTruthy();

		// The model picker is locked during a turn; /model says so instead of
		// clearing the draft and doing nothing.
		type("/model");
		await press("Escape");
		await press("Enter");
		expect(composer().value).toBe("/model");
		expect(
			screen.getByText(t("agents.chat.commandBusy", { name: "model" })),
		).toBeTruthy();
	});
});

// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import { chatInputLatency } from "@/lib/agents/chat/chatInputLatency";
import { t } from "@/lib/i18n";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/ipc/dureAgentRuntime";
import { getForegroundInteractionBudget } from "@/lib/scheduling/foregroundInteractionBudget";
import { getWorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformance";
import { useStore } from "@/store";
import { chatComposerSessionFixture as session } from "@/test/chatComposerSessionFixture";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { openSelect } from "@/test/select";

const mocks = vi.hoisted(() => ({
	launch: {
		ownerKey: "fixture-runtime",
		loaded: true,
		hydrationError: false,
		model: "gpt-5.6-sol" as string | null,
		effort: "xhigh" as string | null,
		permissionMode: "default" as "default" | "skip_permissions",
		switching: false,
		error: null as string | null,
		switchSelection: vi.fn(),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
	},
}));

afterEach(() => chatInputLatency.resetMeasurements());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	readText: vi.fn(async () => ""),
}));

vi.mock("@/lib/platform/clipboardImagePaste", () => ({
	resolvePaste: vi.fn(async () => ({
		kind: "image",
		dataB64: "QUJD",
		ext: "png",
	})),
}));

vi.mock("@/lib/ipc", () => ({
	readClipboardImage: vi.fn(async () => null),
	saveChatAttachments: vi.fn(async () => ["/saved/pasted-1.png"]),
}));

function resolveLastLaunchSelection(
	source: DureAgentRuntimeLaunchSelectionV1 = {
		model: "gpt-5.6-sol",
		effort: "xhigh",
		permissionMode: "default",
	},
) {
	const calls = mocks.launch.switchSelection.mock.calls;
	const update = calls[calls.length - 1]?.[0];
	if (typeof update !== "function") return update;
	return update(source);
}

describe("ChatComposer foreground scheduling", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("pauses background work at the existing draft input boundary", () => {
		const baseline = performance.now();
		vi.spyOn(performance, "now").mockReturnValue(baseline);
		const budget = getForegroundInteractionBudget();
		expect(budget.isBackgroundPaused()).toBe(false);

		render(<ChatComposer session={session("codex")} disabled={false} />);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "a" },
		});

		// The mocked baseline is a real performance.now() float, so
		// (baseline + 100) - baseline can drift by one ulp.
		expect(budget.backgroundPauseRemainingMs()).toBeCloseTo(100, 6);
	});

	it("reports the existing draft input through its React commit boundary", () => {
		const view = render(
			<ChatComposer session={session("codex")} disabled={false} />,
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "a" },
		});

		const snapshot = getWorkspacePerformanceSnapshot();
		expect(snapshot.chatInput).toMatchObject({
			inFlightCount: 1,
			samples: [],
		});

		view.unmount();
		expect(getWorkspacePerformanceSnapshot().chatInput).toMatchObject({
			inFlightCount: 0,
			samples: [],
		});
	});
});

describe("ChatComposer attachments", () => {
	afterEach(() => cleanup());

	it.each(["runtime", "remote"])("retires a pending image capture when its %s changes", async (change) => {
		const { resolvePaste } = await import("@/lib/platform/clipboardImagePaste");
		let finish!: (value: Awaited<ReturnType<typeof resolvePaste>>) => void;
		vi.mocked(resolvePaste).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const value = session("claude");
		const view = render(<ChatComposer session={value} disabled={false} />);
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] },
		});
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Describe" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		const next = session("claude");
		if (change === "runtime") next.page!.binding.runtime.runtimeGeneration = "replacement";
		view.rerender(<ChatComposer session={next} disabled={false} attachmentsEnabled={change !== "remote"} />);
		await act(async () => { finish({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		expect(value.send).not.toHaveBeenCalled();
		expect(next.send).not.toHaveBeenCalled();
		expect(screen.queryByText(/pasted-.*\.png/)).toBeNull();
	});

	it("retires a file read after the input target changes and returns", async () => {
		let finish!: (bytes: ArrayBuffer) => void;
		const file = { name: "old.txt", size: 3, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) };
		const value = session("claude");
		const view = render(<ChatComposer session={value} disabled={false} />);
		fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { types: ["Files"], files: [file] } });
		const next = session("claude");
		next.page!.binding.runtime.runtimeGeneration = "replacement";
		view.rerender(<ChatComposer session={next} disabled={false} />);
		view.rerender(<ChatComposer session={value} disabled={false} />);
		await act(async () => { finish(new Uint8Array([1, 2, 3]).buffer); });
		expect(screen.queryByText("old.txt")).toBeNull();
	});

	it("includes an unfinished paste when Enter requests the current draft", async () => {
		const { resolvePaste } = await import("@/lib/platform/clipboardImagePaste");
		let finish!: (value: Awaited<ReturnType<typeof resolvePaste>>) => void;
		vi.mocked(resolvePaste).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const value = session("claude");
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "send now" } });
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await act(async () => { finish({ kind: "text", text: "old paste" }); });
		expect(value.send).toHaveBeenCalledWith("send nowold paste");
		expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
	});

	it("waits for image paste before sending the draft once", async () => {
		const { resolvePaste } = await import("@/lib/platform/clipboardImagePaste");
		let finish!: (value: Awaited<ReturnType<typeof resolvePaste>>) => void;
		vi.mocked(resolvePaste).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const value = session("claude");
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Describe" } });
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(value.send).not.toHaveBeenCalled();
		await act(async () => { finish({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		expect(value.send).toHaveBeenCalledTimes(1);
		expect(value.send).toHaveBeenCalledWith(expect.stringContaining("/saved/pasted-1.png"));
		expect(value.send).toHaveBeenCalledWith(expect.stringContaining("Describe"));
	});

	it("captures a pasted image as a removable chip", async () => {
		const value = session("claude");
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				items: [{ type: "image/png", getAsFile: () => null }],
			},
		});
		expect(await screen.findByText(/pasted-.*\.png/)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.attachmentRemove") }),
		);
		expect(screen.queryByText(/pasted-.*\.png/)).toBeNull();
	});

	it("refuses local attachment paths when the execution host is remote", async () => {
		render(
			<ChatComposer
				session={session("claude")}
				disabled={false}
				attachmentsEnabled={false}
			/>,
		);

		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				items: [{ type: "image/png", getAsFile: () => null }],
			},
		});

		expect(
			await screen.findByText(t("agents.chat.attachmentRemoteUnavailable")),
		).toBeTruthy();
		expect(screen.queryByText(/pasted-.*\.png/)).toBeNull();
	});

	it("does not deliver a local attachment path after execution becomes remote", async () => {
		const { saveChatAttachments } = await import("@/lib/ipc");
		let finishSave: ((paths: string[]) => void) | undefined;
		vi.mocked(saveChatAttachments).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishSave = resolve;
				}),
		);
		const value = session("claude");
		const view = render(
			<ChatComposer session={value} disabled={false} attachmentsEnabled />,
		);
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				items: [{ type: "image/png", getAsFile: () => null }],
			},
		});
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "inspect this" },
		});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await vi.waitFor(() => expect(saveChatAttachments).toHaveBeenCalled());

		view.rerender(
			<ChatComposer
				session={value}
				disabled={false}
				attachmentsEnabled={false}
			/>,
		);
		const completeSave = finishSave;
		if (!completeSave) throw new Error("attachment save did not start");
		await act(async () => {
			completeSave(["/saved/pasted-1.png"]);
		});

		expect(value.send).not.toHaveBeenCalled();
		expect(value.steerOrQueue).not.toHaveBeenCalled();
		expect(
			screen.getByText(t("agents.chat.attachmentRemoteUnavailable")),
		).toBeTruthy();
		expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
			"inspect this",
		);
	});

	it("sends the message with saved-path references", async () => {
		const { saveChatAttachments } = await import("@/lib/ipc");
		const value = session("claude");
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				items: [{ type: "image/png", getAsFile: () => null }],
			},
		});
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "look at this" },
		});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await vi.waitFor(() => expect(value.send).toHaveBeenCalled());
		expect(saveChatAttachments).toHaveBeenCalledWith(
			"interaction-1",
			expect.any(Array),
		);
		expect(vi.mocked(value.send).mock.calls[0]?.[0]).toBe(
			"look at this\n\nRead the attached image 1 before starting: /saved/pasted-1.png",
		);
	});

	it("keeps a prepared draft when its runtime is replaced during attachment persistence", async () => {
		const { saveChatAttachments } = await import("@/lib/ipc");
		let finishSaving: ((paths: string[]) => void) | undefined;
		vi.mocked(saveChatAttachments).mockImplementationOnce(
			() =>
				new Promise<string[]>((resolve) => {
					finishSaving = resolve;
				}),
		);
		const original = session("claude");
		const view = render(<ChatComposer session={original} disabled={false} />);
		fireEvent.paste(screen.getByRole("textbox"), {
			clipboardData: {
				items: [{ type: "image/png", getAsFile: () => null }],
			},
		});
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "keep this draft" },
		});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await vi.waitFor(() => expect(saveChatAttachments).toHaveBeenCalled());

		const replacement = session("claude");
		if (!replacement.page) throw new Error("expected replacement page");
		replacement.page.binding.interactionSessionId = "interaction-2";
		replacement.page.binding.bindingRevision = 2;
		replacement.page.binding.runtime = {
			runtimeGeneration: "runtime-2",
			providerEpoch: "query-2",
		};
		view.rerender(<ChatComposer session={replacement} disabled={false} />);
		await act(async () => {
			finishSaving?.(["/saved/pasted-1.png"]);
			await Promise.resolve();
		});

		expect(original.send).not.toHaveBeenCalled();
		expect(replacement.send).not.toHaveBeenCalled();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"keep this draft",
		);
		expect(screen.getByText(/pasted-.*\.png/)).toBeTruthy();
	});
});

describe("ChatComposer queueing", () => {
	afterEach(() => cleanup());

	it("restores a failed steer to the composer without queueing another send", async () => {
		const value = session("codex");
		const page = value.page;
		if (!page) throw new Error("expected page fixture");
		page.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		const backend = { id: "backend", generation: "one" };
		const routeAuthority = testDureBackendRouteAuthority(
			backend.id,
			backend.generation,
		);
		const initial = { type: "page" as const, page };
		const client: DureAgentConversationClient = {
			inspect: async () => ({ backend, routeAuthority, binding: page.binding }),
			recover: async (binding) => binding,
			read: async () => ({ backend, routeAuthority, read: initial }),
			subscribe: async () => ({
				backend,
				routeAuthority,
				initial,
				subscriptionId: "test",
				close: async () => {},
			}),
			startTurn: vi.fn(async () => "accepted" as const),
			steerTurn: vi.fn(async () => {
				throw new Error("Delivery response lost");
			}),
			answerPending: async () => {},
			interruptTurn: async () => {},
			putGoal: async () => {
				throw new Error("unused");
			},
		};
		const controller = new AgentChatSessionController({
			agentId: page.binding.agentId,
			interactionSessionId: page.binding.interactionSessionId,
			client,
		});
		controller.start();
		await act(async () => {});
		try {
			value.activeTurn = page.activeTurn;
			value.steerOrQueue = (input) => controller.steerOrQueue(input);
			render(<ChatComposer session={value} disabled={false} />);
			const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
			fireEvent.change(composer, { target: { value: "change direction" } });
			await act(async () => {
				fireEvent.keyDown(composer, { key: "Enter" });
			});
			expect(composer.value).toBe("change direction");
			expect(screen.getByText("Delivery response lost")).toBeTruthy();
			expect(controller.getSnapshot().queuedMessages).toEqual([]);
			expect(client.steerTurn).toHaveBeenCalledTimes(1);
			expect(client.startTurn).not.toHaveBeenCalled();
		} finally {
			controller.stop();
		}
	});

	it("steers Enter into an active turn and renders the queue", () => {
		const value = session("claude");
		value.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		value.queuedMessages = ["ㅇㅇ 회수하고 있어?"];
		render(<ChatComposer session={value} disabled={false} />);
		expect(screen.getByText("ㅇㅇ 회수하고 있어?")).toBeTruthy();
		expect(screen.getByText(t("agents.chat.queuedHint"))).toBeTruthy();

		const composer = screen.getByRole("textbox");
		fireEvent.change(composer, { target: { value: "다음 질문" } });
		fireEvent.keyDown(composer, { key: "Enter" });
		expect(value.steerOrQueue).toHaveBeenCalledWith("다음 질문");
		expect(value.send).not.toHaveBeenCalled();
		expect((composer as HTMLTextAreaElement).value).toBe("");
	});

	it("offers interrupt-and-send while a turn is active", () => {
		const value = session("claude");
		value.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		value.queuedMessages = ["보내줘"];
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.chat.queuedInterruptSend"),
			}),
		);
		expect(value.interrupt).toHaveBeenCalledTimes(1);
	});

	it("hides interrupt-and-send once the turn has settled", () => {
		const value = session("claude");
		value.queuedMessages = ["보내줘"];
		render(<ChatComposer session={value} disabled={false} />);
		expect(
			screen.queryByRole("button", {
				name: t("agents.chat.queuedInterruptSend"),
			}),
		).toBeNull();
	});

	it("pulls a queued message back into the draft", () => {
		const value = session("claude");
		value.activeTurn = { turnId: "turn-1", clientMessageId: "message-1" };
		value.queuedMessages = ["park me"];
		value.dequeueMessage = vi.fn(() => "park me");
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.queuedEdit") }),
		);
		expect(value.dequeueMessage).toHaveBeenCalledWith(0);
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"park me",
		);
	});
});

describe("ChatComposer uncertain send recovery", () => {
	afterEach(() => cleanup());

	it("humanizes catalogued action errors and keeps the raw token visible", () => {
		const value = session("claude");
		value.actionError = "agent_conversation_provider_failed";
		render(<ChatComposer session={value} disabled={false} />);
		expect(
			screen.getByText(t("agents.chat.error.providerFailed")),
		).toBeTruthy();
		expect(screen.getByText("agent_conversation_provider_failed")).toBeTruthy();
	});

	it("dismisses a transient action error but never a parked retryable turn", () => {
		const value = session("claude");
		value.actionError = "agent_conversation_provider_failed";
		render(<ChatComposer session={value} disabled={false} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		expect(value.dismissActionError).toHaveBeenCalledTimes(1);
		cleanup();

		const parked = session("claude");
		parked.actionError = "agent_conversation_provider_failed";
		parked.retryTurnAvailable = true;
		render(<ChatComposer session={parked} disabled={false} />);
		expect(
			screen.queryByRole("button", { name: t("common.close") }),
		).toBeNull();
	});

	it("restores the uncertain input before a draft without losing either", () => {
		const value = session("claude");
		value.actionError = "backend route changed";
		value.retryTurnAvailable = true;
		value.editRetryableTurn = vi.fn(() => "original input");
		render(<ChatComposer session={value} disabled={false} />);
		const composer = screen.getByRole("textbox");
		fireEvent.change(composer, { target: { value: "new draft" } });

		fireEvent.keyDown(composer, { key: "Enter" });
		expect(value.send).not.toHaveBeenCalled();
		expect((composer as HTMLTextAreaElement).value).toBe("new draft");

		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.chat.editUncertainSend"),
			}),
		);
		expect(value.editRetryableTurn).toHaveBeenCalledOnce();
		expect((composer as HTMLTextAreaElement).value).toBe(
			"original input\nnew draft",
		);
	});
});

describe("ChatComposer launch-selection controls", () => {
	beforeEach(() => {
		// These flows exercise the pro-tier launch pills; basic (the fresh
		// store default) folds them away by design.
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
		}));
	});
	afterEach(() => {
		cleanup();
		mocks.launch.switchSelection.mockClear();
		mocks.launch.dismissError.mockClear();
		mocks.launch.model = "gpt-5.6-sol";
		mocks.launch.effort = "xhigh";
		mocks.launch.permissionMode = "default";
		mocks.launch.loaded = true;
		mocks.launch.hydrationError = false;
		mocks.launch.error = null;
	});

	it("dismisses a failed launch-selection action without another runtime mutation", () => {
		mocks.launch.error = "Chat is unavailable";
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));

		expect(mocks.launch.dismissError).toHaveBeenCalledOnce();
		expect(mocks.launch.switchSelection).not.toHaveBeenCalled();
	});

	it("shows the committed model and effort as picker values", () => {
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		expect(screen.getByRole("combobox", {name: t("agents.chat.modelLabel")}).textContent).toBe("GPT-5.6 Sol");
		expect(screen.getByRole("combobox", { name: t("agents.chat.effortLabel") }).textContent).toBe("XHigh");
	});

	it("keeps launch selection available while chat reconnects", () => {
		const reconnecting = session("codex");
		reconnecting.phase = "connecting";
		reconnecting.reconnecting = true;

		render(
			<ChatComposer
				session={reconnecting}
				disabled={false}
				launch={mocks.launch}
			/>,
		);

		expect(
			screen.getByRole<HTMLButtonElement>("combobox", {
				name: t("agents.chat.modelLabel"),
			}).disabled,
		).toBe(false);
	});

	it("switches the model and drops an effort the new model cannot offer", () => {
		mocks.launch.model = "gpt-5.6-sol";
		mocks.launch.effort = "ultra";
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		fireEvent.click(screen.getByRole("option", { name: "GPT-5.6 Luna" }));
		// Luna has no "ultra" rung — the switch must not smuggle it through.
		expect(
			resolveLastLaunchSelection({
				model: "gpt-5.6-sol",
				effort: "ultra",
				permissionMode: "default",
			}),
		).toEqual({
			model: "gpt-5.6-luna",
			effort: null,
			permissionMode: "default",
		});
	});

	it("preserves an authoritative skip-permissions selection across a model switch", () => {
		mocks.launch.permissionMode = "skip_permissions";
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		fireEvent.click(screen.getByRole("option", { name: "GPT-5.6 Luna" }));

		expect(
			resolveLastLaunchSelection({
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permissionMode: "skip_permissions",
			}),
		).toEqual({
			model: "gpt-5.6-luna",
			effort: "xhigh",
			permissionMode: "skip_permissions",
		});
	});

	it("switches the permission mode with the danger option marked", () => {
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		openSelect(
			screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }),
		);
		fireEvent.click(screen.getByRole("option", {name: t("agents.chat.permissionSkip")}));
		expect(resolveLastLaunchSelection()).toEqual({
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permissionMode: "skip_permissions",
		});
	});

	it("offers auto-edit as a plain (non-danger) permission mode", () => {
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		openSelect(
			screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }),
		);
		fireEvent.click(screen.getByRole("option", {name: t("agents.chat.permissionAutoEdit")}));
		expect(resolveLastLaunchSelection()).toEqual({
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permissionMode: "auto_edit",
		});
	});

	it("shows the session's reported model when nothing is selected", () => {
		mocks.launch.model = null;
		const value = session("claude");
		if (!value.page) throw new Error("expected page");
		value.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "init-1",
					turnId: null,
					clientMessageId: null,
					providerMessageId: null,
					body: {
						type: "provider_evidence",
						namespace: "provider.claude",
						kind: "provider_session_initialized",
						value: { model: "claude-fable-5", permissionMode: "default" },
					},
					createdAtMs: 1,
				},
			},
		];
		render(
			<ChatComposer session={value} disabled={false} launch={mocks.launch} />,
		);
		expect(screen.getByText("Fable 5")).toBeTruthy();
	});

	it("keeps unloaded pickers actionable without inventing committed values", () => {
		mocks.launch.loaded = false;
		const view = render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		expect(
			screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeTruthy();
		expect(mocks.launch.switchSelection).not.toHaveBeenCalled();
		view.unmount();

		mocks.launch.loaded = true;
		render(
			<ChatComposer
				session={session("unknown-provider")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);
		expect(
			screen.queryByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeNull();
	});

	it("offers one explicit read retry after launch hydration fails", () => {
		mocks.launch.loaded = false;
		mocks.launch.hydrationError = true;
		render(
			<ChatComposer
				session={session("codex")}
				disabled={false}
				launch={mocks.launch}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));

		expect(mocks.launch.retryHydration).toHaveBeenCalledOnce();
		expect(mocks.launch.switchSelection).not.toHaveBeenCalled();
	});

	it("keeps draft changes off synchronous layout measurement", () => {
		render(<ChatComposer session={session("codex")} disabled={false} />);
		const composer = screen.getByRole("textbox");
		const readScrollHeight = vi.fn(() => 48);
		Object.defineProperty(composer, "scrollHeight", {
			configurable: true,
			get: readScrollHeight,
		});

		fireEvent.change(composer, { target: { value: "한글\nsecond line" } });

		expect(readScrollHeight).not.toHaveBeenCalled();
	});

	it("leaves Enter with the native textarea during IME composition", () => {
		const value = session("codex");
		render(<ChatComposer session={value} disabled={false} />);
		const composer = screen.getByRole("textbox");
		fireEvent.change(composer, { target: { value: "한글" } });

		fireEvent.keyDown(composer, { key: "Enter", isComposing: true });

		expect(value.send).not.toHaveBeenCalled();
	});
});

describe("ChatComposer turn failure recovery", () => {
	afterEach(() => cleanup());

	function failedTurnRows(detail: string | null) {
		const item = (
			sequence: number,
			body: { type: "lifecycle"; state: "turn_started" | "turn_failed"; detail: string | null },
		) => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId: `item-${sequence}`,
				turnId: "turn-1",
				clientMessageId: "message-1",
				providerMessageId: null,
				body,
				createdAtMs: sequence,
			},
		});
		return [
			item(1, { type: "lifecycle", state: "turn_started", detail: null }),
			item(2, { type: "lifecycle", state: "turn_failed", detail }),
		];
	}

	function recoveryHandlers(withTarget = true) {
		return {
			...(withTarget
				? { switchAccount: { targetName: "work", run: vi.fn() } }
				: {}),
			manageAccounts: vi.fn(),
			signIn: vi.fn(),
		};
	}

	it("offers the pane-scoped switch to a named account for a usage limit", () => {
		const value = session("codex");
		value.page = { ...value.page!, rows: failedTurnRows("usage_limit") };
		const recovery = recoveryHandlers();
		render(<ChatComposer session={value} disabled={false} recovery={recovery} />);
		expect(
			screen.getByText(t("agents.chat.turnFailure.usageLimit")),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.chat.recovery.switchTo", { name: "work" }),
			}),
		);
		expect(recovery.switchAccount?.run).toHaveBeenCalledTimes(1);
		// A usage limit is not a sign-in problem.
		expect(
			screen.queryByRole("button", { name: t("agents.chat.recovery.signIn") }),
		).toBeNull();
	});

	it("falls back to account management when the pane has no other account", () => {
		const value = session("codex");
		value.page = { ...value.page!, rows: failedTurnRows("rate_limit") };
		const recovery = recoveryHandlers(false);
		render(<ChatComposer session={value} disabled={false} recovery={recovery} />);
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.recovery.manageAccounts") }),
		);
		expect(recovery.manageAccounts).toHaveBeenCalledTimes(1);
	});

	it("offers sign-in and switch for an authentication failure, and nothing for a generic one", () => {
		const value = session("claude");
		value.page = { ...value.page!, rows: failedTurnRows("authentication_failed") };
		const recovery = recoveryHandlers();
		render(<ChatComposer session={value} disabled={false} recovery={recovery} />);
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.recovery.signIn") }),
		);
		expect(recovery.signIn).toHaveBeenCalledTimes(1);
		cleanup();

		const generic = session("claude");
		generic.page = { ...generic.page!, rows: failedTurnRows(null) };
		render(<ChatComposer session={generic} disabled={false} recovery={recovery} />);
		expect(
			screen.queryByRole("button", {
				name: t("agents.chat.recovery.switchTo", { name: "work" }),
			}),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: t("agents.chat.recovery.signIn") }),
		).toBeNull();
	});

	it("hides the recovery once dismissed or when the pane offers none", () => {
		const value = session("codex");
		value.page = { ...value.page!, rows: failedTurnRows("rate_limit") };
		const recovery = recoveryHandlers();
		render(<ChatComposer session={value} disabled={false} recovery={recovery} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		expect(
			screen.queryByRole("button", {
				name: t("agents.chat.recovery.switchTo", { name: "work" }),
			}),
		).toBeNull();
		cleanup();

		render(<ChatComposer session={value} disabled={false} />);
		expect(
			screen.queryByText(t("agents.chat.turnFailure.rateLimit")),
		).toBeNull();
	});
});

describe("ChatComposer handoff outcome", () => {
	afterEach(() => cleanup());

	function handedOffRows() {
		const item = (
			sequence: number,
			body:
				| { type: "lifecycle"; state: "turn_started" | "turn_failed"; detail: string | null }
				| { type: "message"; role: "user"; markdown: string },
		) => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId: `item-${sequence}`,
				turnId: "turn-1",
				clientMessageId: "message-1",
				providerMessageId: null,
				body,
				createdAtMs: sequence,
			},
		});
		return [
			item(1, { type: "lifecycle", state: "turn_started", detail: null }),
			item(2, { type: "message", role: "user", markdown: "finish the report" }),
			item(3, { type: "lifecycle", state: "turn_failed", detail: "usage_limit" }),
		];
	}

	it("says where the pane moved and resends the failed message on request", () => {
		const value = session("codex");
		value.page = { ...value.page!, rows: handedOffRows() };
		const resend = vi.fn();
		render(
			<ChatComposer
				session={value}
				disabled={false}
				recovery={{
					manageAccounts: vi.fn(),
					handedOff: { fromName: "personal", toName: "work", resend },
				}}
			/>,
		);
		expect(
			screen.getByText(
				t("agents.chat.recovery.handedOff", { from: "personal", to: "work" }),
			),
		).toBeTruthy();
		// The failure banner's own actions are not shown for a handled episode.
		expect(
			screen.queryByRole("button", { name: t("agents.chat.recovery.manageAccounts") }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: t("agents.chat.recovery.resend") }));
		expect(resend).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		expect(
			screen.queryByText(
				t("agents.chat.recovery.handedOff", { from: "personal", to: "work" }),
			),
		).toBeNull();
	});

	it("settles a rejected resend without submitting another request", async () => {
		const value = session("codex");
		value.page = { ...value.page!, rows: handedOffRows() };
		const resend = vi.fn().mockRejectedValue(new Error("agent_chat_turn_already_pending"));
		render(<ChatComposer session={value} disabled={false} recovery={{
			manageAccounts: vi.fn(), handedOff: { toName: "work", resend },
		}} />);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: t("agents.chat.recovery.resend") }));
		});
		expect(resend).toHaveBeenCalledOnce();
		expect(value.send).not.toHaveBeenCalled();
	});
});

beforeEach(() => useStore.setState({ chatDrafts: {} }));

import { prepareAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import { splitPromptAttachments } from "@/lib/agents/attachmentPrompt";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { handleCliAgentInput } from "@/lib/cli/cliAgentInput";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";
import { t } from "@/lib/i18n";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	read: vi.fn(),
	send: vi.fn(),
	claim: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
	...(await original<typeof import("@/lib/ipc")>()),
	saveChatAttachments: mocks.save,
	readFile: mocks.read,
}));
vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	sendAgentChatMessage: mocks.send,
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({ claimCliRequest: mocks.claim }));
vi.mock("@tauri-apps/api/webviewWindow", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/webviewWindow")>()),
	getCurrentWebviewWindow: () => ({ label: "main" }),
	getAllWebviewWindows: async () => [],
}));
const stops: Array<() => void> = [];
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-capture",
};
const agent = () =>
	managedAgentFixture({
		id: "agent-capture",
		name: "chat-capture",
		runtimeBinding: undefined,
		interactionProfile: profile,
	});
const image = { fileName: "captured-element.png", dataB64: "cG5nLWJ5dGVz" };
const imageAttachments = [{ kind: "bytes" as const, file: image }];
function session(): AgentChatSessionView {
	return {
		draftIdentity: {
			agentId: "agent-capture",
			backendProfileId: "local",
			interactionSessionId: "interaction-capture",
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
				interactionSessionId: "interaction-capture",
				agentId: "agent-capture",
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
			rows: [],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 0 },
			hasMore: false,
		},
		retryConnection: vi.fn(),
		loadOlder: vi.fn(async () => {}),
		send: vi.fn(async () => {}),
		loadMoreQueued: vi.fn(async () => {}),
		queueMessage: vi.fn(),
		steerOrQueue: vi.fn(async () => "queued" as const),
		dequeueMessage: vi.fn(),
		retryTurn: vi.fn(async () => {}),
		editRetryableTurn: vi.fn(),
		answerPending: vi.fn(async () => {}),
		interrupt: vi.fn(async () => {}),
		dismissActionError: vi.fn(),
	};
}
beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.save.mockResolvedValue([
		"/private/chat-attachments/interaction-capture/captured-element.png",
	]);
	mocks.claim.mockResolvedValue(true);
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(800, 600);
	api.addPanel({
		id: "pane:capture-slot",
		component: "agent",
		params: { agentRef: { agentId: agent().id } },
	});
	registerDockview("chat-space", api);
	stops.push(() => {
		unregisterDockview("chat-space", api);
		api.dispose();
		element.remove();
	});
	useStore.setState({
		spaces: [{ id: "chat-space", name: "Chat" }],
		activeSpaceId: "chat-space",
		layouts: { "chat-space": api.toJSON() },
		agents: [agent()],
		chatDrafts: {},
		chatDraftMoves: {},
		chatDraftMoveReceipts: {},
		chatDraftEpochs: {},
		projects: [
			{
				id: agent().projectId,
				name: "Capture",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
	});
});
afterEach(() => {
	cleanup();
	for (const stop of stops.splice(0).reverse()) stop();
});

it("appends a captured image and Korean text to the visible draft and submits only on Send", async () => {
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "기존 초안" },
	});
	await act(async () => {
		await deliverCaptureToAgent(
			"agent-capture",
			"요소 설명\n수정할 부분",
			imageAttachments,
		);
	});
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"기존 초안\n\n요소 설명\n수정할 부분",
	);
	expect(screen.getByText(image.fileName)).not.toBeNull();
	expect(mocks.save).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
	expect(value.send).not.toHaveBeenCalled();
	expect(value.steerOrQueue).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	await act(async () => {});
	expect(mocks.save).toHaveBeenCalledWith("interaction-capture", [image]);
	expect(value.send).toHaveBeenCalledTimes(1);
	expect(
		splitPromptAttachments(vi.mocked(value.send).mock.calls[0][0]),
	).toEqual({
		body: "기존 초안\n\n요소 설명\n수정할 부분",
		attachments: [
			{
				path: "/private/chat-attachments/interaction-capture/captured-element.png",
				fileName: image.fileName,
			},
		],
	});
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

it("retains an unsubmitted capture through pane remount and lets the user remove its image", async () => {
	await deliverCaptureToAgent(
		"agent-capture",
		"Remount draft",
		imageAttachments,
	);
	const first = render(<ChatComposer session={session()} disabled={false} />);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"Remount draft",
	);
	first.unmount();
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"Remount draft",
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.chat.attachmentRemove") }),
	);
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	await act(async () => {});
	expect(mocks.save).not.toHaveBeenCalled();
	expect(value.send).toHaveBeenCalledWith("Remount draft");
});

it("uses the same visible draft for the CLI no-enter input handler without submitting", async () => {
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	await act(async () => {
		await expect(
			handleCliAgentInput(
				{ name: "chat-capture", text: "CLI draft", enter: false },
				"draft-request",
			),
		).resolves.toMatchObject({
			ok: true,
			input: {
				panelId: "pane:capture-slot",
				enter: false,
				receipt: { kind: "structured_chat", delivery: "drafted" },
			},
		});
	});
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"CLI draft",
	);
	expect(value.send).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
});

it("rejects a capture when its interaction identity changes during the local file read", async () => {
	mocks.read.mockImplementationOnce(async () => {
		useStore.setState({
			agents: [
				{
					...agent(),
					interactionProfile: {
						...profile,
						interactionSessionId: "replacement",
					},
				},
			],
		});
		return {
			name: image.fileName,
			kind: "image",
			mime: "image/png",
			content: image.dataB64,
			truncated: false,
		};
	});
	await expect(
		deliverCaptureToAgent("agent-capture", "Stale capture", [
			{ kind: "local_file", path: "/private/capture.png" },
		]),
	).rejects.toMatchObject({ code: "write_failed" });
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
	expect(mocks.read).toHaveBeenCalledTimes(1);
	expect(mocks.save).not.toHaveBeenCalled();
	expect(value.send).not.toHaveBeenCalled();
});

it.each([
	{
		label: "execution host",
		patch: { kind: "ssh" as const, sshHostId: "other-host" },
	},
	{ label: "project path", patch: { path: "/replacement" } },
	{ label: "removed project", patch: null },
])(
	"rejects a capture when its $label changes during the local file read",
	async ({ patch }) => {
		mocks.read.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				projects: patch
					? state.projects.map((project) => ({ ...project, ...patch }))
					: [],
			}));
			return {
				name: image.fileName,
				kind: "image",
				mime: "image/png",
				content: image.dataB64,
				truncated: false,
			};
		});
		await expect(
			deliverCaptureToAgent("agent-capture", "Stale capture", [
				{ kind: "local_file", path: "/private/capture.png" },
			]),
		).rejects.toMatchObject({ code: "write_failed" });
		expect(useStore.getState().chatDrafts).toEqual({});
		expect(mocks.save).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	},
);

it("keeps a new capture received during image persistence for the next explicit Send", async () => {
	let finishSave: ((paths: string[]) => void) | undefined;
	mocks.save.mockImplementationOnce(
		() =>
			new Promise<string[]>((resolve) => {
				finishSave = resolve;
			}),
	);
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	await act(async () => {
		await deliverCaptureToAgent(
			"agent-capture",
			"First capture",
			imageAttachments,
		);
	});
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	expect(mocks.save).toHaveBeenCalledTimes(1);
	const secondImage = { fileName: "second.png", dataB64: "c2Vjb25k" };
	await act(async () => {
		await deliverCaptureToAgent("agent-capture", "Second capture", [
			{ kind: "bytes", file: secondImage },
		]);
		if (!finishSave) throw new Error("image persistence did not start");
		finishSave(["/private/first.png"]);
	});
	expect(value.send).not.toHaveBeenCalled();
	expect(value.steerOrQueue).not.toHaveBeenCalled();
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"First capture\n\nSecond capture",
	);
	expect(screen.getByText(image.fileName)).not.toBeNull();
	expect(screen.getByText(secondImage.fileName)).not.toBeNull();
	mocks.save.mockResolvedValueOnce([
		"/private/first.png",
		"/private/second.png",
	]);
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	await act(async () => {});
	expect(mocks.save).toHaveBeenLastCalledWith("interaction-capture", [
		image,
		secondImage,
	]);
	expect(value.send).toHaveBeenCalledTimes(1);
	expect(
		splitPromptAttachments(vi.mocked(value.send).mock.calls[0][0]),
	).toEqual({
		body: "First capture\n\nSecond capture",
		attachments: [
			{ path: "/private/first.png", fileName: "first.png" },
			{ path: "/private/second.png", fileName: "second.png" },
		],
	});
});

it("retains a capture if its composer unmounts while image persistence is pending", async () => {
	let finishSave: ((paths: string[]) => void) | undefined;
	mocks.save.mockImplementationOnce(
		() =>
			new Promise<string[]>((resolve) => {
				finishSave = resolve;
			}),
	);
	const value = session();
	const view = render(<ChatComposer session={value} disabled={false} />);
	await act(async () => {
		await deliverCaptureToAgent(
			"agent-capture",
			"Retain on unmount",
			imageAttachments,
		);
	});
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	view.unmount();
	await act(async () => {
		if (!finishSave) throw new Error("image persistence did not start");
		finishSave(["/private/first.png"]);
	});
	expect(value.send).not.toHaveBeenCalled();
	render(<ChatComposer session={session()} disabled={false} />);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
		"Retain on unmount",
	);
	expect(screen.getByText(image.fileName)).not.toBeNull();
});

it("blocks an image save started before a draft move, including a move aborted before that save returns", async () => {
	let finishSave!: (paths: string[]) => void;
	mocks.save.mockImplementationOnce(
		() =>
			new Promise<string[]>((resolve) => {
				finishSave = resolve;
			}),
	);
	const value = session();
	render(<ChatComposer session={value} disabled={false} />);
	await act(async () => {
		await deliverCaptureToAgent(
			"agent-capture",
			"이동할 초안",
			imageAttachments,
		);
	});
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	expect(mocks.save).toHaveBeenCalledOnce();
	const target = prepareAgentChatDraftTarget(agent());
	const transfer = {
		id: "composer-move",
		digest: `sha256:${"a".repeat(64)}`,
		target,
		source: {
			schemaVersion: 1 as const,
			desktopId: "source",
			dockviewId: "dock-1",
			paneId: "agent:agent-capture",
			windowLabel: "main",
			windowGeneration: "boot-1",
		},
		destination: {
			schemaVersion: 1 as const,
			desktopId: "target",
			dockviewId: "dock-2",
			windowLabel: "win-popout-target",
			windowGeneration: "boot-2",
		},
	};
	const expected = useStore.getState().chatDrafts[target.identity.agentId];
	act(() => {
		useStore
			.getState()
			.applyChatDraftMove({
				action: "begin",
				packet: { transfer, drafts: expected },
				expected,
			});
	});
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
		true,
	);
	act(() => {
		useStore
			.getState()
			.applyChatDraftMove({
				action: "release",
				transfer,
				receipt: {
					kind: "draft_move",
					id: transfer.id,
					digest: transfer.digest,
					status: "aborted",
				},
			});
	});
	await act(async () => {
		finishSave(["/private/captured.png"]);
	});
	expect(value.send).not.toHaveBeenCalled();
	expect(value.steerOrQueue).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts[target.identity.agentId]).toBe(
		expected,
	);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
		false,
	);
	fireEvent.click(screen.getByRole("button", { name: t("agents.chat.send") }));
	await act(async () => {});
	expect(value.send).toHaveBeenCalledOnce();
});

// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import {
	type CliAgentInputRouting,
	handleCliAgentInput,
} from "./cliAgentInput";

const nativeInput = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("./cliHmuxInput", () => ({ handleManagedHmuxInput: nativeInput }));

const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-routing",
};
const agent = () =>
	managedAgentFixture({
		id: "chat",
		sessionId: "chat-session",
		interactionProfile: profile,
		runtimeBinding: undefined,
	});
const paneOwner = {
	schemaVersion: 1 as const,
	paneId: "agent:chat",
	desktopId: "chat-space",
	dockviewId: "dock-1",
	windowLabel: "win-100-2",
	windowGeneration: "generation-2",
};
const params = {
	name: "chat",
	sessionId: "chat-session",
	targetPanelId: "agent:chat",
	text: "한글 초안",
	enter: false,
	expectedInteractionProfile: profile,
};
function routing(windowLabel = "main") {
	return {
		currentWindowLabel: () => windowLabel,
		resolve: vi.fn(async () => paneOwner),
		revalidate: vi.fn(),
		forward: vi.fn<CliAgentInputRouting["forward"]>(async () => {}),
		claim: vi.fn(async () => true),
	} satisfies CliAgentInputRouting;
}
let api: DockviewApi;
let element: HTMLDivElement;
function mount(
	paneId = paneOwner.paneId,
	agentId = "chat",
	component = "agent",
) {
	for (const panel of api.panels) api.removePanel(panel);
	const panel = api.addPanel({
		id: paneId,
		component,
		params: { agentRef: { agentId } },
	});
	useStore.setState({ layouts: { [paneOwner.desktopId]: api.toJSON() } });
	return panel;
}
beforeEach(() => {
	nativeInput.mockClear();
	useStore.setState({
		agents: [
			agent(),
			{ ...agent(), id: "original", sessionId: "original-session" },
		],
		projects: [],
		chatDrafts: {},
		spaces: [{ id: paneOwner.desktopId, name: "Chat" }],
		layouts: {},
	});
	element = document.createElement("div");
	document.body.append(element);
	api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(800, 600);
	registerDockview(paneOwner.desktopId, api);
	mount();
});
afterEach(() => {
	unregisterDockview(paneOwner.desktopId, api);
	api.dispose();
	element.remove();
});

it("forwards the original broker request before claim and appends only in the owner window", async () => {
	const source = routing();
	expect(await handleCliAgentInput(params, "request-1", source)).toBeNull();
	expect(source.claim).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
	expect(source.forward).toHaveBeenCalledTimes(1);
	const [windowLabel, forwarded] = source.forward.mock.calls[0];
	expect(windowLabel).toBe("win-100-2");
	expect(forwarded).toMatchObject({
		reqId: "request-1",
		action: "agent.input",
		params: { text: params.text, enter: false, paneOwner },
	});
	const destination = routing(windowLabel);
	await expect(
		handleCliAgentInput(forwarded.params, forwarded.reqId, destination),
	).resolves.toMatchObject({
		ok: true,
		input: {
			enter: false,
			receipt: { kind: "structured_chat", delivery: "drafted" },
		},
	});
	expect(destination.resolve).not.toHaveBeenCalled();
	expect(destination.forward).not.toHaveBeenCalled();
	expect(destination.claim).toHaveBeenCalledExactlyOnceWith("request-1");
	expect(Object.values(useStore.getState().chatDrafts.chat)[0].text).toBe(
		params.text,
	);
});
it("does not append after another handler wins the broker claim", async () => {
	const target = routing("win-100-2");
	target.claim.mockResolvedValue(false);
	expect(await handleCliAgentInput(params, "request-1", target)).toBeNull();
	expect(useStore.getState().chatDrafts).toEqual({});
});
it("refuses a pane moved during the awaited broker claim", async () => {
	const target = routing("win-100-2");
	target.revalidate.mockImplementationOnce(() => {});
	target.revalidate.mockImplementationOnce(() => {
		throw new PaneCommandError("pane_changed", "pane moved");
	});
	await expect(
		handleCliAgentInput(params, "request-1", target),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expect(target.claim).toHaveBeenCalledTimes(1);
	expect(useStore.getState().chatDrafts).toEqual({});
});
it("refuses a different conversation after owner lookup", async () => {
	const target = routing();
	target.resolve.mockImplementationOnce(async () => {
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
		return paneOwner;
	});
	await expect(
		handleCliAgentInput(params, "request-1", target),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expect(target.forward).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("refuses a malformed projected identity before choosing a window", async () => {
	const target = routing();
	await expect(
		handleCliAgentInput(
			{
				...params,
				expectedInteractionProfile: { ...profile, schemaVersion: 2 },
			},
			"request-invalid",
			target,
		),
	).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(target.resolve).not.toHaveBeenCalled();
	expect(target.forward).not.toHaveBeenCalled();
	expect(target.claim).toHaveBeenCalledExactlyOnceWith("request-invalid");
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("retains the original workspace across a window forward", async () => {
	const source = routing();
	await handleCliAgentInput(params, "request-workspace", source);
	const [windowLabel, forwarded] = source.forward.mock.calls[0];
	useStore.setState({
		agents: [{ ...agent(), worktreePath: "/replacement-worktree" }],
	});
	const target = routing(windowLabel);
	await expect(
		handleCliAgentInput(forwarded.params, forwarded.reqId, target),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expect(target.forward).not.toHaveBeenCalled();
	expect(target.claim).toHaveBeenCalledExactlyOnceWith("request-workspace");
	expect(useStore.getState().chatDrafts).toEqual({});
});

it.each(["pane:stable-slot", "launcher:previous", "agent:original"])(
	"routes draft input to current Agent content in %s and returns its real pane ID",
	async (paneId) => {
		mount(paneId);
		const owner = { ...paneOwner, paneId };
		const source = routing();
		source.resolve.mockResolvedValue(owner);
		await expect(
			handleCliAgentInput(
				{ ...params, targetPanelId: undefined },
				"opaque-request",
				source,
			),
		).resolves.toBeNull();
		expect(source.resolve).toHaveBeenCalledExactlyOnceWith(
			{ agentId: "chat" },
			undefined,
		);
		expect(source.claim).not.toHaveBeenCalled();
		const [label, request] = source.forward.mock.calls[0];
		expect(request).toMatchObject({
			reqId: "opaque-request",
			params: { targetPanelId: paneId, paneOwner: owner },
		});
		const destination = routing(label);
		await expect(
			handleCliAgentInput(request.params, request.reqId, destination),
		).resolves.toMatchObject({
			ok: true,
			input: {
				agentId: "chat",
				panelId: paneId,
				receipt: { delivery: "drafted" },
			},
		});
		expect(destination.resolve).not.toHaveBeenCalled();
		expect(Object.values(useStore.getState().chatDrafts.chat)[0].text).toBe(
			params.text,
		);
		expect(useStore.getState().chatDrafts.original).toBeUndefined();
	},
);

it.each(["pane:stable-slot", "launcher:previous", "agent:original"])(
	"honors an explicit exact pane hint %s without equating it to the Agent ID",
	async (paneId) => {
		mount(paneId);
		const target = routing(paneOwner.windowLabel);
		target.resolve.mockResolvedValue({ ...paneOwner, paneId });
		await expect(
			handleCliAgentInput(
				{ ...params, targetPanelId: paneId },
				"exact-request",
				target,
			),
		).resolves.toMatchObject({
			ok: true,
			input: { panelId: paneId, agentId: "chat" },
		});
		expect(target.resolve).toHaveBeenCalledExactlyOnceWith(paneId, undefined);
	},
);

it.each(["owner lookup", "broker claim"])(
	"preserves both drafts if the pane is retargeted during %s",
	async (boundary) => {
		const panel = api.getPanel(paneOwner.paneId)!;
		const before = {
			chat: { existing: { text: "keep chat", attachments: [] } },
			original: { existing: { text: "keep original", attachments: [] } },
		};
		useStore.setState({ chatDrafts: before });
		const target = routing(paneOwner.windowLabel);
		const retarget = () =>
			panel.api.updateParameters({ agentRef: { agentId: "original" } });
		if (boundary === "owner lookup")
			target.resolve.mockImplementationOnce(async () => {
				retarget();
				return paneOwner;
			});
		else
			target.claim.mockImplementationOnce(async () => {
				retarget();
				return true;
			});
		await expect(
			handleCliAgentInput(params, "retarget-request", target),
		).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
		expect(target.claim).toHaveBeenCalledExactlyOnceWith("retarget-request");
		expect(useStore.getState().chatDrafts).toEqual(before);
	},
);

it.each(["terminal", "launcher"])(
	"refuses current %s content in an old Agent-shaped slot",
	async (component) => {
		mount(paneOwner.paneId, "chat", component);
		await expect(
			handleCliAgentInput(
				params,
				"changed-content",
				routing(paneOwner.windowLabel),
			),
		).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
		expect(useStore.getState().chatDrafts).toEqual({});
	},
);

it("preserves the broker identity on duplicate delivery without appending twice", async () => {
	const target = routing(paneOwner.windowLabel);
	target.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
	await expect(
		handleCliAgentInput(params, "same-request", target),
	).resolves.toMatchObject({ ok: true });
	await expect(
		handleCliAgentInput(params, "same-request", target),
	).resolves.toBeNull();
	expect(Object.values(useStore.getState().chatDrafts.chat)[0].text).toBe(
		params.text,
	);
	expect(target.claim.mock.calls).toEqual([["same-request"], ["same-request"]]);
});

it("does not reinterpret a forwarded chat draft as native terminal input after a profile change", async () => {
	const source = routing();
	await handleCliAgentInput(
		{ ...params, expectedInteractionProfile: undefined },
		"profile-change",
		source,
	);
	const [label, request] = source.forward.mock.calls[0];
	useStore.setState({
		agents: [
			managedAgentFixture({
				id: "chat",
				sessionId: "chat-session",
				runtimeBinding: managedBindingFixture({
					sessionId: "chat-session",
					stopFence: stopFenceFixture(),
				}),
			}),
		],
	});
	await expect(
		handleCliAgentInput(request.params, request.reqId, routing(label)),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expect(nativeInput).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("refuses a forwarded owner that conflicts with the explicit pane hint", async () => {
	const target = routing(paneOwner.windowLabel);
	await expect(
		handleCliAgentInput(
			{ ...params, paneOwner: { ...paneOwner, paneId: "different-slot" } },
			"wrong-owner",
			target,
		),
	).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(target.resolve).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});

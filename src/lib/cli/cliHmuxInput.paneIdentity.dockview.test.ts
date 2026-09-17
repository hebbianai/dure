// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	probeSubmittedChatPaneSelection,
	submittedChatPaneSelectionCases,
} from "@/qa/submittedChatPaneSelection";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { handleExactHmuxInput, handleManagedHmuxInput } from "./cliHmuxInput";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	input: vi.fn(),
	remoteInput: vi.fn(),
	remoteController: vi.fn(),
	chat: vi.fn(),
}));
vi.mock("./cliRequestBroker", () => ({ claimCliRequest: mocks.claim }));
vi.mock("@/lib/ipc", async (original) => {
	const real = await original<typeof import("@/lib/ipc")>();
	return {
		...real,
		hmux: { ...real.hmux, commandInput: mocks.input },
		remoteHmuxCommandInput: mocks.remoteInput,
	};
});
vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
	resolveRemoteHmuxStandaloneController: mocks.remoteController,
}));
vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	sendAgentChatMessage: mocks.chat,
}));

const cleanups: Array<() => void> = [];
const fence = stopFenceFixture();
const binding = managedBindingFixture({ stopFence: fence });

function mounted(spaceId = "target"): DockviewApi {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(spaceId, api);
	cleanups.push(() => {
		unregisterDockview(spaceId, api);
		api.dispose();
		container.remove();
	});
	return api;
}

function addAgent(
	api: DockviewApi,
	id = "agent:historical",
	agentId = "historical",
) {
	return api.addPanel({
		id,
		component: "agent",
		params: { agentRef: { agentId } },
	});
}

function exact(
	panelId = "agent:historical",
	hostId = "local",
	targetBinding = binding,
) {
	return handleExactHmuxInput(
		{
			target: {
				schemaVersion: 1,
				targetPanelId: panelId,
				hostId,
				sessionId: targetBinding.sessionId,
				workspaceId: targetBinding.workspaceId,
			},
			text: "draft",
			enter: false,
		},
		"request",
	);
}

function named(panelId: string, agentId = "historical", reqId = "request") {
	return handleManagedHmuxInput(
		{ name: agentId, targetPanelId: panelId, text: "draft", enter: false },
		reqId,
	);
}

function expectUnwritten() {
	expect(mocks.input).not.toHaveBeenCalled();
	expect(mocks.remoteInput).not.toHaveBeenCalled();
	expect(mocks.chat).not.toHaveBeenCalled();
}

function chatProfile(agentId: string) {
	return {
		schemaVersion: 1 as const,
		kind: "structured_protocol" as const,
		backendProfileId: "local",
		interactionSessionId: `conversation-${agentId}`,
	};
}

function installChatAgents() {
	useStore.setState({
		agents: useStore.getState().agents.map((agent) => ({
			...agent,
			runtimeBinding: undefined,
			interactionProfile: chatProfile(agent.id),
		})),
	});
}

function submitted(panelId?: string, agentId = "historical") {
	return handleManagedHmuxInput(
		{ name: agentId, targetPanelId: panelId, text: "hello", enter: true },
		"request",
	);
}

beforeEach(() => {
	mocks.claim.mockReset().mockResolvedValue(true);
	const receipt = {
		terminalEpoch: fence.terminalEpoch,
		text: { recordId: "1", state: "written_to_pty" },
	};
	mocks.input.mockReset().mockResolvedValue(receipt);
	mocks.remoteInput.mockReset().mockResolvedValue(receipt);
	mocks.remoteController.mockReset();
	mocks.chat.mockReset().mockResolvedValue({ delivery: "sent" });
	useStore.setState({
		activeSpaceId: "unrelated",
		agents: ["historical", "current"].map((id) =>
			managedAgentFixture({
				id,
				name: id,
				runtimeBinding: binding,
			}),
		),
		projects: [],
		sshHosts: [],
		layouts: {},
	});
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	useStore.setState({ agents: [], layouts: {}, sshHosts: [] });
});

describe.each(
	["mounted", "saved", "restored"].flatMap((location) =>
		["exact", "named", "chat"].map((route) => ({ location, route })),
	),
)("$location pane $route input", ({ location, route }) => {
	it.each([
		"pane-stable",
		"launcher:original",
		"term:original",
		"agent:historical",
	])(
		"uses the current Agent reference behind %s without changing focus",
		async (panelId) => {
			if (route === "chat") installChatAgents();
			const api = mounted();
			addAgent(api, panelId, "current");
			api.addPanel({ id: "editor", component: "editor" });
			const saved = JSON.parse(JSON.stringify(api.toJSON()));
			if (location === "saved") {
				useStore.setState({ layouts: { target: saved } });
				unregisterDockview("target", api);
			} else if (location === "restored") {
				api.fromJSON(saved);
			}
			const editor = document.createElement("input");
			document.body.append(editor);
			editor.focus();
			try {
				await expect(
					route === "exact"
						? exact(panelId)
						: route === "chat"
							? submitted(panelId, "current")
							: named(panelId, "current"),
				).resolves.toMatchObject({
					ok: true,
					input: { agentId: "current", panelId },
				});
				if (route === "chat") {
					expect(mocks.chat).toHaveBeenCalledExactlyOnceWith({
						agentId: "current",
						profile: chatProfile("current"),
						text: "hello",
					});
					expect(mocks.input).not.toHaveBeenCalled();
				} else {
					expect(mocks.input).toHaveBeenCalledExactlyOnceWith({
						sessionId: binding.sessionId,
						workspaceId: binding.workspaceId,
						expectedFence: fence,
						text: "draft",
						submit: false,
					});
				}
				expect(document.activeElement).toBe(editor);
				expect(api.activePanel?.id).toBe("editor");
				expect(useStore.getState().activeSpaceId).toBe("unrelated");
			} finally {
				editor.remove();
			}
		},
	);
});

it.each(["launcher", "terminal", "ssh", "editor"])(
	"never interprets a %s pane as an Agent because of its historical ID",
	async (component) => {
		mounted().addPanel({
			id: "agent:historical",
			component,
			params: { agentRef: { agentId: "historical" }, binding },
		});
		await expect(exact()).resolves.toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expectUnwritten();
	},
);

it.each([null, {}, { agentId: "" }, { agentId: "missing" }])(
	"does not replace an explicit Agent reference %j with the ID alias",
	async (agentRef) => {
		mounted().addPanel({
			id: "agent:historical",
			component: "agent",
			params: { agentRef },
		});
		await expect(exact()).resolves.toMatchObject({ ok: false });
		expectUnwritten();
	},
);

it("uses current mounted parameters instead of the earlier saved reference", async () => {
	const api = mounted();
	const panel = addAgent(api);
	useStore.setState({ layouts: { target: api.toJSON() } });
	panel.api.updateParameters({ agentRef: { agentId: "current" } });
	await expect(exact()).resolves.toMatchObject({
		ok: true,
		input: { agentId: "current" },
	});
});

it.each(["exact", "named"])(
	"dispatches %s input once with the referenced Agent's own runtime",
	async (route) => {
		const currentBinding = managedBindingFixture({
			sessionId: "current-session",
			workspaceId: "current-workspace",
			stopFence: { ...fence, terminalEpoch: "current-terminal" },
		});
		useStore.setState({
			agents: useStore.getState().agents.map((agent) =>
				agent.id === "current"
					? {
							...agent,
							sessionId: currentBinding.sessionId,
							runtimeBinding: currentBinding,
						}
					: agent,
			),
		});
		addAgent(mounted(), "agent:historical", "current");
		mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const send = () =>
			route === "exact"
				? exact("agent:historical", "local", currentBinding)
				: named("agent:historical", "current");
		await expect(send()).resolves.toMatchObject({
			ok: true,
			input: {
				agentId: "current",
				panelId: "agent:historical",
				sessionId: currentBinding.sessionId,
			},
		});
		await expect(send()).resolves.toBeNull();
		expect(mocks.input).toHaveBeenCalledExactlyOnceWith({
			sessionId: currentBinding.sessionId,
			workspaceId: currentBinding.workspaceId,
			expectedFence: currentBinding.stopFence,
			text: "draft",
			submit: false,
		});
	},
);

it("retains the legacy Agent layout ingress when no reference was persisted", async () => {
	const api = mounted();
	api.addPanel({ id: "agent:historical", component: "agent" });
	api.fromJSON(
		normalizePersistedPaneLayout(api.toJSON()) as ReturnType<typeof api.toJSON>,
	);
	await expect(exact()).resolves.toMatchObject({
		ok: true,
		input: { agentId: "historical" },
	});
});

it("does not send input through a missing mounted reference", async () => {
	mounted().addPanel({ id: "agent:historical", component: "agent" });
	await expect(exact()).resolves.toMatchObject({
		ok: false,
		error: { code: "pane_changed" },
	});
	expectUnwritten();
});

it("does not infer a saved pane component from its ID", async () => {
	useStore.setState({
		layouts: { cold: { panels: { "agent:historical": { params: {} } } } },
	});
	await expect(exact()).resolves.toMatchObject({
		ok: false,
		error: { code: "pane_changed" },
	});
	expectUnwritten();
});

it("refuses duplicate pane IDs across Spaces instead of choosing a writer", async () => {
	addAgent(mounted("one"));
	addAgent(mounted("two"));
	await expect(exact()).resolves.toMatchObject({
		ok: false,
		error: { code: "pane_ambiguous" },
	});
	expectUnwritten();
});

it.each(["name", "legacy-v1"])(
	"preserves headless %s Agent input",
	async (kind) => {
		const result =
			kind === "name"
				? handleManagedHmuxInput(
						{ name: "historical", text: "draft", enter: false },
						"request",
					)
				: exact();
		await expect(result).resolves.toMatchObject({
			ok: true,
			input: { agentId: "historical" },
		});
		expect(mocks.input).toHaveBeenCalledTimes(1);
	},
);

it("keeps a named Agent independent of a pane reusing the historical ID", async () => {
	mounted().addPanel({ id: "agent:historical", component: "terminal" });
	await expect(
		handleManagedHmuxInput(
			{ name: "historical", text: "draft", enter: false },
			"request",
		),
	).resolves.toMatchObject({ ok: true, input: { agentId: "historical" } });
});

it("checks an explicit named-input pane without changing the named Agent", async () => {
	addAgent(mounted(), "agent:historical", "current");
	await expect(
		handleManagedHmuxInput(
			{
				name: "historical",
				targetPanelId: "agent:historical",
				text: "draft",
				enter: false,
			},
			"request",
		),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expectUnwritten();
});

it.each(["retarget", "clear", "remove", "replace", "generation"])(
	"keeps named input unwritten when its selected target changes during claim: %s",
	async (change) => {
		const api = mounted();
		const panel = addAgent(api, "pane-stable");
		useStore.setState({ layouts: { target: api.toJSON() } });
		mocks.claim.mockImplementationOnce(async () => {
			if (change === "retarget")
				panel.api.updateParameters({ agentRef: { agentId: "current" } });
			else if (change === "clear")
				panel.api.updateParameters({ agentRef: null });
			else if (change === "generation") {
				useStore.setState({
					agents: useStore.getState().agents.map((agent) => ({
						...agent,
						runtimeBinding: {
							...binding,
							stopFence: { ...fence, terminalEpoch: "replacement" },
						},
					})),
				});
			} else {
				api.removePanel(panel);
				if (change === "replace")
					api.addPanel({ id: panel.id, component: "terminal" });
			}
			return true;
		});
		await expect(named(panel.id)).resolves.toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		expectUnwritten();
		// A fresh, explicit request may use the new current reference/generation.
		if (change === "retarget" || change === "generation") {
			await expect(
				named(
					panel.id,
					change === "retarget" ? "current" : "historical",
					"fresh-request",
				),
			).resolves.toMatchObject({ ok: true });
			expect(mocks.input).toHaveBeenCalledTimes(1);
		}
	},
);

it("does not replay named input after an uncertain Host response", async () => {
	const panel = addAgent(mounted(), "pane-stable");
	mocks.input.mockRejectedValueOnce({
		code: "input_response_lost",
		message: "Host response lost",
		deliveryState: "unknown",
	});
	await expect(
		handleManagedHmuxInput(
			{
				name: "historical",
				targetPanelId: panel.id,
				text: "한글\nsecond line",
				enter: true,
			},
			"request",
		),
	).resolves.toMatchObject({
		ok: false,
		error: { code: "input_response_lost", message: "Host response lost" },
	});
	expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("request");
	expect(mocks.input).toHaveBeenCalledExactlyOnceWith({
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		expectedFence: fence,
		text: "한글\nsecond line",
		submit: true,
	});
	expect(mocks.remoteInput).not.toHaveBeenCalled();
});

it("preserves named input when its neutral pane moves to another Space during claim", async () => {
	const source = mounted("source");
	const panel = addAgent(source, "pane-stable");
	const destination = mounted("destination");
	mocks.claim.mockImplementationOnce(async () => {
		source.removePanel(panel);
		addAgent(destination, panel.id);
		return true;
	});
	await expect(named(panel.id)).resolves.toMatchObject({
		ok: true,
		input: { agentId: "historical", panelId: panel.id },
	});
	expect(mocks.input).toHaveBeenCalledTimes(1);
});

it.each(["binding", "session alias"])(
	"reports a changed recipient when its %s disappears during claim",
	async (field) => {
		addAgent(mounted());
		mocks.claim.mockImplementationOnce(async () => {
			useStore.setState({
				agents: useStore.getState().agents.map((agent) => ({
					...agent,
					...(field === "binding"
						? { runtimeBinding: undefined }
						: { sessionId: "replaced" }),
				})),
			});
			return true;
		});
		await expect(exact()).resolves.toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expectUnwritten();
	},
);

it.each(["retarget", "clear", "remove", "replace"])(
	"refuses a selected pane changed during claim: %s",
	async (change) => {
		const api = mounted();
		const panel = addAgent(api);
		useStore.setState({ layouts: { target: api.toJSON() } });
		mocks.claim.mockImplementationOnce(async () => {
			if (change === "retarget")
				panel.api.updateParameters({ agentRef: { agentId: "current" } });
			else if (change === "clear")
				panel.api.updateParameters({ agentRef: null });
			else {
				api.removePanel(panel);
				if (change === "replace")
					api.addPanel({ id: panel.id, component: "terminal" });
			}
			return true;
		});
		await expect(exact()).resolves.toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		expectUnwritten();
	},
);

it("keeps direct Agent selection when a pane appears while claiming", async () => {
	mocks.claim.mockImplementationOnce(async () => {
		addAgent(mounted(), "agent:historical", "current");
		return true;
	});
	await expect(exact()).resolves.toMatchObject({
		ok: true,
		input: { agentId: "historical" },
	});
});

it("preserves input when the same pane moves to another Space during claim", async () => {
	const source = mounted("source");
	const panel = addAgent(source);
	const destination = mounted("destination");
	mocks.claim.mockImplementationOnce(async () => {
		source.removePanel(panel);
		addAgent(destination);
		return true;
	});
	await expect(exact()).resolves.toMatchObject({
		ok: true,
		input: { agentId: "historical" },
	});
	expect(mocks.input).toHaveBeenCalledTimes(1);
});

it.each(
	["exact", "named"].flatMap((route) =>
		["unchanged", "retarget"].map((change) => ({ route, change })),
	),
)(
	"$route remote input after $change during controller resolution",
	async ({ route, change }) => {
		const remoteBinding = {
			...binding,
			source: "ssh" as const,
			hostId: "remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge",
		};
		useStore.setState({
			agents: useStore.getState().agents.map((agent) => ({
				...agent,
				sessionKind: "ssh",
				runtimeBinding: remoteBinding,
			})),
			sshHosts: [
				{
					id: "remote",
					name: "Remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
		});
		const panel = addAgent(mounted(), "pane-stable");
		const resolution = {
			target: { hostId: "remote" },
			session: {
				...fence,
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				sessionClass: "managed",
				lifecycle: "ready",
			},
		};
		mocks.remoteController.mockImplementationOnce(async () => {
			if (change === "retarget")
				panel.api.updateParameters({ agentRef: { agentId: "current" } });
			return resolution;
		});
		const result =
			route === "exact" ? exact(panel.id, "remote") : named(panel.id);
		if (change === "retarget") {
			await expect(result).resolves.toMatchObject({
				ok: false,
				error: { code: "pane_changed" },
			});
			expectUnwritten();
		} else {
			await expect(result).resolves.toMatchObject({
				ok: true,
				input: { agentId: "historical", panelId: panel.id, hostId: "remote" },
			});
			expect(mocks.remoteInput).toHaveBeenCalledExactlyOnceWith({
				...resolution,
				text: "draft",
				submit: false,
			});
			expect(mocks.input).not.toHaveBeenCalled();
		}
		expect(mocks.remoteController).toHaveBeenCalledTimes(1);
	},
);

describe("submitted structured chat pane selection", () => {
	beforeEach(installChatAgents);

	it.each(submittedChatPaneSelectionCases)(
		"shares the native WebView admission observation: %s",
		(scenario) => {
			expect(probeSubmittedChatPaneSelection(scenario)).toMatchObject({
				scenario,
				preserved: true,
			});
			expectUnwritten();
		},
	);

	it.each(["retarget", "clear", "remove", "replace"])(
		"does not submit when its pane changes during claim: %s",
		async (change) => {
			const api = mounted();
			const panel = addAgent(api);
			useStore.setState({ layouts: { target: api.toJSON() } });
			mocks.claim.mockImplementationOnce(async () => {
				if (change === "retarget")
					panel.api.updateParameters({ agentRef: { agentId: "current" } });
				else if (change === "clear")
					panel.api.updateParameters({ agentRef: null });
				else {
					api.removePanel(panel);
					if (change === "replace")
						api.addPanel({ id: panel.id, component: "terminal" });
				}
				return true;
			});
			await expect(submitted(panel.id)).resolves.toMatchObject({
				ok: false,
				error: { code: "pane_changed" },
			});
			expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("request");
			expectUnwritten();
		},
	);

	it("keeps headless selection when a historical pane appears during claim", async () => {
		mocks.claim.mockImplementationOnce(async () => {
			addAgent(mounted(), "agent:historical", "current");
			return true;
		});
		await expect(submitted()).resolves.toMatchObject({
			ok: true,
			input: { agentId: "historical", sessionId: "conversation-historical" },
		});
		expect(mocks.chat).toHaveBeenCalledExactlyOnceWith({
			agentId: "historical",
			profile: chatProfile("historical"),
			text: "hello",
		});
	});

	it("keeps an admitted pane when it moves to another Space during claim", async () => {
		const source = mounted("source");
		const pane = addAgent(source, "pane-stable");
		const destination = mounted("destination");
		mocks.claim.mockImplementationOnce(async () => {
			source.removePanel(pane);
			addAgent(destination, pane.id);
			return true;
		});
		await expect(submitted(pane.id)).resolves.toMatchObject({
			ok: true,
			input: { agentId: "historical", panelId: pane.id },
		});
		expect(mocks.chat).toHaveBeenCalledTimes(1);
	});

	it("does not send twice when the request is already claimed", async () => {
		const pane = addAgent(mounted(), "pane-stable");
		mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(submitted(pane.id)).resolves.toMatchObject({ ok: true });
		await expect(submitted(pane.id)).resolves.toBeNull();
		expect(mocks.chat).toHaveBeenCalledTimes(1);
	});

	it("preserves the accepted receipt after a pane changes during delivery", async () => {
		const pane = addAgent(mounted(), "pane-stable");
		mocks.chat.mockImplementationOnce(async () => {
			pane.api.updateParameters({ agentRef: { agentId: "current" } });
			return { delivery: "sent" };
		});
		await expect(submitted(pane.id)).resolves.toMatchObject({
			ok: true,
			input: {
				agentId: "historical",
				panelId: pane.id,
				sessionId: "conversation-historical",
				receipt: { delivery: "sent" },
			},
		});
		expect(mocks.chat).toHaveBeenCalledExactlyOnceWith({
			agentId: "historical",
			profile: chatProfile("historical"),
			text: "hello",
		});
	});

	it("does not retry or misreport an uncertain submission", async () => {
		const pane = addAgent(mounted(), "pane-stable");
		mocks.chat.mockRejectedValueOnce(new Error("submission outcome unknown"));
		await expect(submitted(pane.id)).resolves.toMatchObject({
			ok: false,
			error: {
				code: "hmux_input_failed",
				message: "submission outcome unknown",
			},
		});
		expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("request");
		expect(mocks.chat).toHaveBeenCalledTimes(1);
	});
});

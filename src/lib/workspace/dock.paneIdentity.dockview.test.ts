// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hmuxStandaloneBinding,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { onDesktopPrewarmRequest } from "@/lib/workspace/desktop/desktopPrewarm";
import {
	createTerminalPaneRelativeToSession,
	resolvePaneById,
	resolvePaneReference,
} from "@/lib/workspace/dock";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

const cleanups: Array<() => void> = [];
const creation = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }));

vi.mock("@/lib/hmux/remote/remoteHmuxTerminalSession", async (original) => ({
	...(await original<object>()),
	openRemoteHmuxTerminal: creation.remote,
}));
vi.mock("@/lib/workspace/dock/standaloneShellTerminal", async (original) => ({
	...(await original<object>()),
	createHmuxStandaloneTerminalOn: creation.local,
}));
vi.mock("@/lib/hmux/standalone/hmuxStandaloneRollout", async (original) => ({
	...(await original<object>()),
	hmuxManagedShellReady: async () => false,
	hmuxStandaloneReady: async () => true,
}));

function mounted(desktopId = "target"): DockviewApi {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(desktopId, api);
	cleanups.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
	});
	return api;
}

function persistAndUnmount(api: DockviewApi, desktopId = "target") {
	const saved = JSON.parse(JSON.stringify(api.toJSON()));
	unregisterDockview(desktopId, api);
	useStore.setState({ layouts: { [desktopId]: saved } });
	return saved;
}

beforeEach(() => {
	useStore.setState({
		activeSpaceId: "other",
		agents: [],
		layouts: {},
		sessionCwd: {},
		sshHosts: [],
	});
	creation.local.mockReset().mockResolvedValue({
		sessionId: "local-created",
		workspaceId: "workspace",
	});
	creation.remote.mockReset().mockResolvedValue({
		panelId: "ssh:created",
		sessionId: "remote-created",
		binding: remoteHmuxManagedBinding(
			"remote-created",
			"workspace",
			"remote",
			"bridge",
		),
	});
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
	useStore.setState({ agents: [], layouts: {}, sessionCwd: {}, sshHosts: [] });
});

describe("Agent presentation references", () => {
	it("interprets a historical ID only when restoring saved content, not during mounted lookup", async () => {
		const api = mounted();
		useStore.setState({ agents: [agentFixture({ id: "current" })] });
		const pane = api.addPanel({ id: "agent:current", component: "agent", params: {} });
		await expect(resolvePaneReference({ agentId: "current" }, pane.id))
			.rejects.toMatchObject({ code: "pane_not_found" });
		const saved = api.toJSON();
		const beforeRestore = structuredClone(saved);
		api.fromJSON(normalizePersistedPaneLayout(saved) as typeof saved);
		await expect(resolvePaneReference({ agentId: "current" }, pane.id))
			.resolves.toMatchObject({ panelId: "agent:current", desktopId: "target" });
		expect(saved).toEqual(beforeRestore);
		expect(api.getPanel(pane.id)?.params).toEqual({ agentRef: { agentId: "current" } });
		expect(creation.local).not.toHaveBeenCalled();
		expect(creation.remote).not.toHaveBeenCalled();
		expect(useStore.getState().activeSpaceId).toBe("other");
	});

	it("uses an exact pane constraint without deriving its spelling or session", async () => {
		const api = mounted();
		useStore.setState({ agents: [agentFixture({ id: "current" })] });
		for (const id of ["pane:first", "launcher:second"]) {
			api.addPanel({
				id,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			});
		}
		await expect(resolvePaneReference({ agentId: "current" }, "launcher:second"))
			.resolves.toMatchObject({ panelId: "launcher:second", desktopId: "target" });
		await expect(resolvePaneReference({ agentId: "current" }, "agent:current"))
			.rejects.toMatchObject({ code: "pane_not_found" });
		api.getPanel("launcher:second")?.api.updateParameters({
			agentRef: { agentId: "other" },
		});
		await expect(resolvePaneReference({ agentId: "current" }, "launcher:second"))
			.rejects.toMatchObject({ code: "pane_not_found" });
		await expect(resolvePaneReference({ agentId: "current" }))
			.resolves.toMatchObject({ panelId: "pane:first" });
		expect(useStore.getState().activeSpaceId).toBe("other");
	});
});

describe("relative split consumes the selected pane reference", () => {
	function remoteAgent() {
		return agentFixture({
			id: "current",
			sessionId: "source",
			worktreePath: "/remote",
			runtimeBinding: remoteHmuxManagedBinding(
				"source",
				"workspace",
				"remote",
				"bridge",
			),
		});
	}

	beforeEach(() => {
		useStore.setState({
			agents: [remoteAgent()],
			sshHosts: [
				{
					id: "remote",
					name: "Remote",
					host: "example.test",
					port: 22,
					user: "fixture",
					auth: "auto",
				},
			],
		});
	});

	it("uses the explicit Agent reference for the host and cwd", async () => {
		const api = mounted();
		api.addPanel({
			id: "agent:current",
			component: "agent",
			params: { agentRef: { agentId: "current" }, cwd: "/stale" },
		});
		await createTerminalPaneRelativeToSession({
			referenceSessionId: "source",
			direction: "right",
		});
		expect(creation.remote).toHaveBeenCalledWith(
			expect.objectContaining({
				api,
				hostId: "remote",
				cwd: "/remote",
				position: { referencePanel: "agent:current", direction: "right" },
			}),
		);
		expect(creation.local).not.toHaveBeenCalled();
	});

	it("does not borrow an Agent's execution location for terminal content", async () => {
		const api = mounted();
		api.addPanel({
			id: "agent:previous",
			component: "terminal",
			params: {
				sessionId: "source",
				cwd: "/local",
				binding: hmuxStandaloneBinding("source", "workspace"),
			},
		});
		await createTerminalPaneRelativeToSession({
			referenceSessionId: "source",
			direction: "below",
		});
		expect(creation.remote).not.toHaveBeenCalled();
		expect(creation.local).toHaveBeenCalledWith(
			api,
			"/local",
			{ referencePanel: "agent:previous", direction: "below" },
			undefined,
			"target",
			expect.any(Object),
		);
	});

	it("does not launch after the selected Agent reference changes during the claim", async () => {
		const api = mounted();
		const pane = api.addPanel({
			id: "agent:current",
			component: "agent",
			params: { agentRef: { agentId: "current" } },
		});
		const result = await createTerminalPaneRelativeToSession(
			{ referenceSessionId: "source", direction: "right" },
			async () => {
				pane.api.updateParameters({ agentRef: null });
				return true;
			},
		).catch((error: unknown) => error);
		expect(creation.remote).not.toHaveBeenCalled();
		expect(creation.local).not.toHaveBeenCalled();
		expect(result).toMatchObject({ code: "pane_changed" });
	});

	it.each(["expired", "closed", "replaced"])(
		"keeps the creation boundary closed when the source is %s",
		async (change) => {
			const api = mounted();
			const pane = api.addPanel({
				id: "pane:source",
				component: "terminal",
				params: { sessionId: "source" },
			});
			const before = api.toJSON();
			const result = await createTerminalPaneRelativeToSession(
				{ referenceSessionId: "source", direction: "right" },
				async () => {
					if (change === "expired") return false;
					api.removePanel(pane);
					if (change === "replaced") api.fromJSON(before);
					return true;
				},
			).catch((error: unknown) => error);
			expect(result).toMatchObject({
				code:
					change === "expired"
						? "request_expired"
						: change === "closed"
							? "pane_not_found"
							: "pane_changed",
			});
			expect(creation.local).not.toHaveBeenCalled();
			expect(creation.remote).not.toHaveBeenCalled();
		},
	);
});

describe("pane lookup through actual Dockview", () => {
	it("retains the empty, missing and detached target distinctions", async () => {
		await expect(resolvePaneById("  ")).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(resolvePaneById("absent")).rejects.toMatchObject({
			code: "pane_not_found",
		});
		await expect(resolvePaneReference(" ")).rejects.toMatchObject({
			code: "invalid_request",
		});
		const api = mounted();
		const pane = api.addPanel({
			id: "pane:detached",
			component: "terminal",
			params: { sessionId: "detached" },
		});
		pane.group.element.remove();
		await expect(resolvePaneById(pane.id)).rejects.toMatchObject({
			code: "pane_not_found",
		});
		await expect(resolvePaneReference("detached")).rejects.toMatchObject({
			code: "pane_not_found",
		});
	});

	it("reads native Agent binding updates without depending on a lagging session alias", async () => {
		const api = mounted();
		const agent = agentFixture({
			id: "current",
			sessionId: "old",
			runtimeBinding: managedBindingFixture({ sessionId: "new" }),
		});
		useStore.setState({ agents: [agent] });
		api.addPanel({
			id: "agent:current",
			component: "agent",
			params: { agentRef: { agentId: "current" } },
		});
		await expect(resolvePaneReference("old")).rejects.toMatchObject({
			code: "pane_not_found",
		});
		await expect(resolvePaneReference("new")).resolves.toMatchObject({
			panelId: "agent:current",
		});
	});

	it("uses an SSH binding-only reference through mounted and saved content", async () => {
		const api = mounted();
		api.addPanel({
			id: "pane:ssh",
			component: "ssh",
			params: {
				binding: remoteHmuxManagedBinding(
					"remote-session",
					"workspace",
					"remote",
					"bridge",
				),
			},
		});
		await expect(resolvePaneReference("remote-session")).resolves.toMatchObject(
			{ panelId: "pane:ssh" },
		);
		const saved = persistAndUnmount(api);
		cleanups.push(
			onDesktopPrewarmRequest((desktopId) =>
				mounted(desktopId).fromJSON(saved),
			),
		);
		await expect(resolvePaneReference("remote-session")).resolves.toMatchObject(
			{ panelId: "pane:ssh" },
		);
	});

	it.each(["opaque-id", "pane:opaque", "launcher:previous", "agent:previous"])(
		"resolves the stable ID %s independently of its current content",
		async (id) => {
			const api = mounted();
			const pane = api.addPanel({
				id,
				component: "launcher",
				params: { cwd: "/chosen" },
			});
			await expect(resolvePaneById(id)).resolves.toEqual({
				desktopId: "target",
				api,
				panelId: id,
				cwd: "/chosen",
			});
			expect(api.getPanel(id)).toBe(pane);
			expect(useStore.getState().activeSpaceId).toBe("other");
		},
	);

	it.each([
		"opaque-id",
		"launcher:previous",
		"agent:previous",
		"term:previous",
	])(
		"finds the terminal session in %s before and after cold restore",
		async (id) => {
			const api = mounted();
			api.addPanel({
				id,
				component: "terminal",
				params: { sessionId: "current", cwd: "/repo" },
			});
			await expect(resolvePaneReference("current")).resolves.toMatchObject({
				panelId: id,
				cwd: "/repo",
			});
			const saved = persistAndUnmount(api);
			cleanups.push(
				onDesktopPrewarmRequest((desktopId) =>
					mounted(desktopId).fromJSON(saved),
				),
			);
			await expect(resolvePaneReference("current")).resolves.toMatchObject({
				desktopId: "target",
				panelId: id,
			});
			expect(useStore.getState().layouts.target).toEqual(saved);
			expect(useStore.getState().activeSpaceId).toBe("other");
		},
	);

	it.each(["opaque-id", "agent:previous"])(
		"resolves the current Agent reference in %s, ignoring copied runtime params",
		async (id) => {
			const api = mounted();
			useStore.setState({
				agents: [
					agentFixture({ id: "previous", sessionId: "old" }),
					agentFixture({
						id: "current",
						sessionId: "current",
						worktreePath: "/current",
					}),
				],
			});
			api.addPanel({
				id,
				component: "agent",
				params: {
					agentRef: { agentId: "current" },
					sessionId: "old",
					cwd: "/old",
					binding: managedBindingFixture({ sessionId: "old" }),
				},
			});
			await expect(resolvePaneReference("current")).resolves.toMatchObject({
				panelId: id,
				cwd: "/current",
			});
			await expect(resolvePaneReference("old")).rejects.toMatchObject({
				code: "pane_not_found",
			});
			const saved = persistAndUnmount(api);
			cleanups.push(
				onDesktopPrewarmRequest((desktopId) =>
					mounted(desktopId).fromJSON(saved),
				),
			);
			await expect(resolvePaneReference("current")).resolves.toMatchObject({
				panelId: id,
				cwd: "/current",
			});
		},
	);

	it.each(["launcher", "browser", "unknown"])(
		"does not discover a session from copied parameters on %s content",
		async (component) => {
			const api = mounted();
			api.addPanel({
				id: "term:old",
				component,
				params: {
					sessionId: "old",
					binding: managedBindingFixture({ sessionId: "old" }),
				},
			});
			await expect(resolvePaneReference("old")).rejects.toMatchObject({
				code: "pane_not_found",
			});
		},
	);

	it("does not let a cleared Agent reference fall back to its historical ID", async () => {
		const api = mounted();
		useStore.setState({
			agents: [agentFixture({ id: "previous", sessionId: "old" })],
		});
		api.addPanel({
			id: "agent:previous",
			component: "agent",
			params: { agentRef: null, sessionId: "old" },
		});
		await expect(resolvePaneReference("old")).rejects.toMatchObject({
			code: "pane_not_found",
		});
	});

	it("does not match the previous binding after current session parameters change", async () => {
		const api = mounted();
		api.addPanel({
			id: "term:old",
			component: "terminal",
			params: {
				sessionId: "current",
				binding: managedBindingFixture({ sessionId: "old" }),
			},
		});
		await expect(resolvePaneReference("old")).rejects.toMatchObject({
			code: "pane_not_found",
		});
		await expect(resolvePaneReference("current")).resolves.toMatchObject({
			panelId: "term:old",
		});
	});

	it("reads the current Agent generation after a prewarm boundary", async () => {
		vi.useFakeTimers();
		const api = mounted();
		useStore.setState({
			agents: [agentFixture({ id: "same", sessionId: "old" })],
		});
		api.addPanel({
			id: "agent:same",
			component: "agent",
			params: { agentRef: { agentId: "same" } },
		});
		const saved = persistAndUnmount(api);
		cleanups.push(
			onDesktopPrewarmRequest((desktopId) => {
				useStore.setState({
					agents: [agentFixture({ id: "same", sessionId: "new" })],
				});
				mounted(desktopId).fromJSON(saved);
			}),
		);
		const pending = resolvePaneReference("old").catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await pending).toMatchObject({ code: "pane_not_found" });
		await expect(resolvePaneReference("new")).resolves.toMatchObject({
			panelId: "agent:same",
		});
	});

	it("looks up a cold pane catalog entry, not a nested metadata ID", async () => {
		const api = mounted();
		api.addPanel({
			id: "term:current",
			component: "terminal",
			params: { sessionId: "current" },
		});
		const saved = persistAndUnmount(api);
		useStore.setState({
			layouts: {
				target: saved,
				unrelated: { metadata: { id: "term:current" } },
			},
		});
		const prepare = vi.fn((desktopId: string) =>
			mounted(desktopId).fromJSON(saved),
		);
		cleanups.push(onDesktopPrewarmRequest(prepare));
		await expect(resolvePaneById("term:current")).resolves.toMatchObject({
			desktopId: "target",
		});
		expect(prepare).toHaveBeenCalledExactlyOnceWith("target");
	});

	it("keeps ambiguity and exact-pane filtering for two views of the same session", async () => {
		const first = mounted("first");
		const second = mounted("second");
		first.addPanel({
			id: "term:one",
			component: "terminal",
			params: { sessionId: "shared" },
		});
		second.addPanel({
			id: "term:two",
			component: "terminal",
			params: { sessionId: "shared" },
		});
		await expect(resolvePaneReference("shared")).rejects.toMatchObject({
			code: "pane_ambiguous",
		});
		await expect(
			resolvePaneReference("shared", "term:two"),
		).resolves.toMatchObject({ desktopId: "second", panelId: "term:two" });
		await expect(
			resolvePaneReference("different", "term:two"),
		).rejects.toMatchObject({ code: "pane_not_found" });
	});

	it("keeps exact-ID ambiguity across mounted and cold spaces", async () => {
		const first = mounted("first");
		const second = mounted("second");
		for (const api of [first, second])
			api.addPanel({
				id: "term:duplicate",
				component: "terminal",
				params: { sessionId: "same" },
			});
		await expect(resolvePaneById("term:duplicate")).rejects.toMatchObject({
			code: "pane_ambiguous",
		});
		const saved = persistAndUnmount(first, "first");
		unregisterDockview("second", second);
		useStore.setState({ layouts: { first: saved, second: saved } });
		await expect(resolvePaneById("term:duplicate")).rejects.toMatchObject({
			code: "pane_ambiguous",
		});
	});
});

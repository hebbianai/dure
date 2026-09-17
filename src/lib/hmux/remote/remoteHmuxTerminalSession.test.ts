import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	remoteHmuxKnownHostTrust: vi.fn(),
	remoteHmuxStandaloneCreate: vi.fn(),
	remoteHmuxCommandInput: vi.fn(),
	departGracefully: vi.fn(),
	planRemoteHmuxCatalogTarget: vi.fn(),
	planRemoteHmuxTerminalOpen: vi.fn(),
	hasDurablePaneReference: vi.fn(),
	registerPane: vi.fn(),
	mountedPaneApplies: vi.fn(),
	registrationApplies: vi.fn(),
	recoverProjection: vi.fn(),
	rehydrate: vi.fn(),
	waitForDesktopDockview: vi.fn(),
	getDockview: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	remoteHmuxKnownHostTrust: mocks.remoteHmuxKnownHostTrust,
	remoteHmuxStandaloneCreate: mocks.remoteHmuxStandaloneCreate,
	remoteHmuxCommandInput: mocks.remoteHmuxCommandInput,
	remoteHmuxDepartGracefully: mocks.departGracefully,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxBroker", () => ({
	planRemoteHmuxCatalogTarget: mocks.planRemoteHmuxCatalogTarget,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxTerminalOpen", () => ({
	planRemoteHmuxTerminalOpen: mocks.planRemoteHmuxTerminalOpen,
}));
vi.mock("@/lib/hmux/remote/remoteHmuxPaneRegistration", () => ({
	hasDurableRemoteHmuxPaneReference: mocks.hasDurablePaneReference,
	registerRemoteHmuxPaneDurably: mocks.registerPane,
	remoteHmuxMountedPaneApplies: mocks.mountedPaneApplies,
	remoteHmuxPaneRegistrationApplies: mocks.registrationApplies,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	waitForDesktopDockview: mocks.waitForDesktopDockview,
	getDockview: mocks.getDockview,
}));
vi.mock("@/lib/persistence/durableStoreRehydration", () => ({
	rehydrateDurableStore: mocks.rehydrate,
}));
vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection: mocks.recoverProjection,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import type { DockviewApi } from "dockview-react";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import type { RemoteHmuxCatalogSessionV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import { openRemoteHmuxTerminal } from "@/lib/hmux/remote/remoteHmuxTerminalSession";
import { useStore } from "@/store";

const session = {
	sessionId: "standalone_x",
	workspaceId: "workspace-remote",
	terminalEpoch: "epoch-1",
	lifecycle: "ready",
} satisfies Pick<
	RemoteHmuxCatalogSessionV1,
	"sessionId" | "workspaceId" | "terminalEpoch" | "lifecycle"
>;

function fakeApi() {
	const addPanel = vi.fn();
	const setActive = vi.fn();
	const getPanel = vi.fn(() => ({ params: {}, api: { setActive } }));
	const toJSON = vi.fn(() => ({
		grid: {
			root: { type: "branch", data: [], size: 400 },
			width: 600,
			height: 400,
			orientation: "HORIZONTAL",
		},
		panels: {},
	}));
	const api = {
		addPanel,
		getPanel,
		toJSON,
		panels: [],
		groups: [],
		api: undefined,
	} as unknown as DockviewApi & {
		addPanel: ReturnType<typeof vi.fn>;
		getPanel: ReturnType<typeof vi.fn>;
		setActive: ReturnType<typeof vi.fn>;
		toJSON: ReturnType<typeof vi.fn>;
	};
	api.setActive = setActive;
	mocks.waitForDesktopDockview.mockResolvedValue(api);
	mocks.getDockview.mockReturnValue(api);
	return api;
}

beforeEach(() => {
	mocks.remoteHmuxKnownHostTrust.mockReset().mockResolvedValue("trusted");
	mocks.planRemoteHmuxCatalogTarget
		.mockReset()
		.mockReturnValue({ schemaVersion: 1, hostId: "host-1" });
	mocks.planRemoteHmuxTerminalOpen.mockReset().mockReturnValue({
		targetSessionId: "standalone_x",
		create: { requestId: "req-1" },
	});
	mocks.remoteHmuxStandaloneCreate
		.mockReset()
		.mockResolvedValue({ session, bridgeNonce: "nonce-1" });
	mocks.remoteHmuxCommandInput.mockReset().mockResolvedValue({
		terminalEpoch: session.terminalEpoch,
	});
	mocks.departGracefully.mockReset().mockResolvedValue(undefined);
	mocks.registerPane
		.mockReset()
		.mockImplementation(async () =>
			useStore.getState().sshHosts.some((host) => host.id === "host-1"),
		);
	mocks.registrationApplies.mockReset().mockReturnValue(true);
	mocks.mountedPaneApplies.mockReset().mockReturnValue(true);
	mocks.hasDurablePaneReference.mockReset().mockResolvedValue(true);
	mocks.waitForDesktopDockview.mockReset();
	mocks.recoverProjection.mockReset().mockImplementation(async () => {
		await mocks.rehydrate();
		return true;
	});
	mocks.rehydrate.mockReset().mockResolvedValue(undefined);
	useStore.setState({
		spaces: [{ id: "desktop-1", name: "Main" }],
		sshHosts: [
			{
				id: "host-1",
				name: "remote",
				host: "example.test",
				port: 22,
				user: "tester",
				auth: "auto",
			},
		],
	});
});

describe("openRemoteHmuxTerminal command panes", () => {
	it("allocates independent view identities before remote creation and carries each owner into its receipt", async () => {
		const { planRemoteHmuxTerminalOpen } = await vi.importActual<
			typeof import("./remoteHmuxTerminalOpen")
		>("./remoteHmuxTerminalOpen");
		mocks.planRemoteHmuxTerminalOpen.mockImplementation(
			planRemoteHmuxTerminalOpen,
		);
		mocks.remoteHmuxStandaloneCreate.mockImplementation(async (create) => ({
			session: { ...session, sessionId: create.targetSessionId },
			bridgeNonce: create.bridgeNonce,
		}));
		const api = fakeApi();
		const receipts = [];
		for (let index = 0; index < 2; index += 1) {
			const receipt = await openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
			});
			receipts.push(receipt);
			const [create, owner] =
				mocks.remoteHmuxStandaloneCreate.mock.calls[index];
			expect(receipt.panelId).not.toMatch(/^(agent|term|terminal|launcher):/);
			expect(receipt.panelId).not.toBe(receipt.sessionId);
			expect(owner).toBe(hmuxPaneOwnerId("main", "desktop-1", receipt.panelId));
			expect(receipt.sessionId).toBe(create.targetSessionId);
			expect(receipt.binding).toMatchObject({
				sessionId: create.targetSessionId,
				commandBridgeNonce: create.bridgeNonce,
				hostId: "host-1",
				workspaceId: session.workspaceId,
			});
			expect(mocks.registerPane.mock.calls[index][0]).toMatchObject({
				panelId: receipt.panelId,
				definition: {
					id: receipt.panelId,
					contentComponent: "terminal",
					params: { sessionId: receipt.sessionId, binding: receipt.binding },
				},
			});
		}
		expect(receipts[0].panelId).not.toBe(receipts[1].panelId);
		expect(receipts[0].sessionId).not.toBe(receipts[1].sessionId);
		expect(mocks.remoteHmuxStandaloneCreate).toHaveBeenCalledTimes(2);
		expect(mocks.departGracefully).not.toHaveBeenCalled();
	});

	it.each(["slot", "launcher:previous", "agent:previous"])(
		"keeps %s as the remote pending owner and presentation receipt",
		async (panelId) => {
			const api = fakeApi();
			const params = { cwd: "/repo", hostId: "host-1" };
			const replacement = {
				id: panelId,
				component: "launcher",
				getParameters: () => params,
				setActive: api.setActive,
			};
			api.getPanel.mockReturnValue({ id: panelId, params, api: replacement });
			const position = {
				replacement: replacement as unknown as NonNullable<
					Parameters<typeof openRemoteHmuxTerminal>[0]["position"]
				>["replacement"],
			};
			const receipt = await openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				position,
			});
			expect(receipt.panelId).toBe(panelId);
			expect(mocks.remoteHmuxStandaloneCreate).toHaveBeenCalledWith(
				expect.anything(),
				hmuxPaneOwnerId("main", "desktop-1", panelId),
			);
			expect(mocks.registerPane).toHaveBeenCalledWith(
				expect.objectContaining({
					panelId,
					definition: expect.objectContaining({ id: panelId }),
					replacement: {
						pane: { id: panelId, component: "launcher", params },
						isCurrent: expect.any(Function),
					},
					position: undefined,
				}),
			);
		},
	);
	it.each([undefined, "/srv/plain folder"])(
		"reports durable mount and only the known cwd: %s",
		async (cwd) => {
			const receipt = await openRemoteHmuxTerminal({
				api: fakeApi(),
				desktopId: "desktop-1",
				hostId: "host-1",
				cwd,
			});
			expect(receipt).toMatchObject({
				sessionId: session.sessionId,
				workspaceId: session.workspaceId,
				cwd: cwd ?? null,
				readiness: { pane: "mounted", session: "ready" },
			});
			expect(mocks.registerPane).toHaveBeenCalledWith(
				expect.objectContaining({
					definition: expect.objectContaining({ title: "remote" }),
				}),
			);
			expect(receipt).not.toHaveProperty("attachment");
		},
	);

	it("returns registration guidance before any remote side effect for an unknown host", async () => {
		await expect(
			openRemoteHmuxTerminal({
				api: fakeApi(),
				desktopId: "desktop-1",
				hostId: "missing",
			}),
		).rejects.toMatchObject({
			code: "remote_hmux_host_not_registered",
			nextAction: "Register the SSH host in Dure, then use its ID with --host.",
		});
		expect(mocks.remoteHmuxKnownHostTrust).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxStandaloneCreate).not.toHaveBeenCalled();
	});

	it("delivers the one-shot command to the remote shell before exposing the pane", async () => {
		const api = fakeApi();

		await openRemoteHmuxTerminal({
			api,
			desktopId: "desktop-1",
			hostId: "host-1",
			hostName: "remote",
			commandLine: "codex login",
			title: "로그인 · work",
		});

		expect(mocks.remoteHmuxCommandInput).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "codex login",
				submit: true,
				session: expect.objectContaining(session),
			}),
		);
		expect(mocks.registerPane).toHaveBeenCalledWith(
			expect.objectContaining({
				definition: expect.objectContaining({ title: "로그인 · work" }),
			}),
		);
		const inputOrder = mocks.remoteHmuxCommandInput.mock.invocationCallOrder[0];
		const paneOrder = api.setActive.mock.invocationCallOrder[0];
		expect(inputOrder).toBeLessThan(paneOrder);
		expect(api.addPanel).not.toHaveBeenCalled();
	});

	it("departs and never exposes a pane when the command cannot be delivered", async () => {
		const api = fakeApi();
		mocks.remoteHmuxCommandInput.mockRejectedValue(
			new Error("input unavailable"),
		);

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
				commandLine: "codex login",
			}),
		).rejects.toThrow("input unavailable");

		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("departs when the Host is removed while remote creation is in flight", async () => {
		const api = fakeApi();
		mocks.remoteHmuxStandaloneCreate.mockImplementationOnce(async () => {
			useStore.setState({ sshHosts: [] });
			return { session, bridgeNonce: "nonce-1" };
		});

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("SSH host changed before pane commit");

		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("does not mount after Host removal supersedes a committed pane registration", async () => {
		const api = fakeApi();
		mocks.hasDurablePaneReference.mockResolvedValue(false);
		mocks.rehydrate.mockImplementationOnce(async () => {
			useStore.setState({ sshHosts: [] });
		});
		mocks.registrationApplies.mockImplementationOnce(() =>
			useStore.getState().sshHosts.some((host) => host.id === "host-1"),
		);

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("changed before pane mount");

		expect(mocks.registerPane).toHaveBeenCalledOnce();
		expect(mocks.rehydrate).toHaveBeenCalledOnce();
		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("retains the remote session when its durable registration is superseded", async () => {
		const api = fakeApi();
		mocks.registrationApplies.mockReturnValue(false);

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("changed before pane mount");

		expect(mocks.departGracefully).not.toHaveBeenCalled();
	});

	it("does not mount when current-WebView projection recovery fails", async () => {
		const api = fakeApi();
		mocks.recoverProjection.mockResolvedValue(false);

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("projection failed before pane mount");

		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).not.toHaveBeenCalled();
	});

	it("departs when layout capture fails after remote creation", async () => {
		const api = fakeApi();
		api.toJSON.mockImplementation(() => {
			throw new Error("layout unavailable");
		});

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("layout unavailable");

		expect(mocks.registerPane).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("captures and mounts through the current Dockview after a remount", async () => {
		const staleApi = fakeApi();
		const currentApi = fakeApi();

		await openRemoteHmuxTerminal({
			api: staleApi,
			desktopId: "desktop-1",
			hostId: "host-1",
			hostName: "remote",
		});

		expect(staleApi.toJSON).not.toHaveBeenCalled();
		expect(staleApi.addPanel).not.toHaveBeenCalled();
		expect(currentApi.toJSON).toHaveBeenCalledOnce();
		expect(currentApi.setActive).toHaveBeenCalledOnce();
		expect(currentApi.addPanel).not.toHaveBeenCalled();
	});

	it("does not focus a pane superseded while waiting for its final mount", async () => {
		const api = fakeApi();
		mocks.registrationApplies.mockImplementation(() =>
			useStore.getState().sshHosts.some((host) => host.id === "host-1"),
		);
		mocks.hasDurablePaneReference.mockResolvedValue(false);
		mocks.waitForDesktopDockview
			.mockResolvedValueOnce(api)
			.mockImplementationOnce(async () => {
				useStore.setState({ sshHosts: [] });
				return api;
			});

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("changed before pane focus");

		expect(api.setActive).not.toHaveBeenCalled();
		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("departs when the target desktop disappears after remote creation", async () => {
		const api = fakeApi();
		mocks.waitForDesktopDockview.mockResolvedValue(undefined);

		await expect(
			openRemoteHmuxTerminal({
				api,
				desktopId: "desktop-1",
				hostId: "host-1",
				hostName: "remote",
			}),
		).rejects.toThrow("target desktop is no longer available");

		expect(api.addPanel).not.toHaveBeenCalled();
		expect(mocks.departGracefully).toHaveBeenCalledOnce();
	});

	it("opens a plain shell pane untouched when no command is requested", async () => {
		const api = fakeApi();

		const receipt = await openRemoteHmuxTerminal({
			api,
			desktopId: "desktop-1",
			hostId: "host-1",
			hostName: "remote",
		});

		expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
		expect(mocks.recoverProjection).toHaveBeenCalledWith({
			forceProjectionDesktopIds: ["desktop-1"],
		});
		expect(mocks.registerPane).toHaveBeenCalledWith(
			expect.objectContaining({
				definition: {
					id: receipt.panelId,
					contentComponent: "terminal",
					title: "remote",
					params: {
						sessionId: "standalone_x",
						binding: expect.objectContaining({ sessionId: "standalone_x" }),
					},
				},
			}),
		);
		expect(mocks.rehydrate.mock.invocationCallOrder[0]).toBeLessThan(
			api.setActive.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(api.addPanel).not.toHaveBeenCalled();
	});

	it("passes the split cwd into the remote Host creation plan", async () => {
		const api = fakeApi();

		await openRemoteHmuxTerminal({
			api,
			desktopId: "desktop-1",
			hostId: "host-1",
			hostName: "remote",
			cwd: "/home/tester/project",
		});

		expect(mocks.planRemoteHmuxTerminalOpen).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/home/tester/project" }),
		);
		expect(mocks.registerPane).toHaveBeenCalledWith(
			expect.objectContaining({
				definition: expect.objectContaining({
					params: expect.objectContaining({ cwd: "/home/tester/project" }),
				}),
			}),
		);
	});
});

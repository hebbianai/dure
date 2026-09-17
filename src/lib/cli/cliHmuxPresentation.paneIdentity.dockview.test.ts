// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CliHmuxAttachDependencies,
	handleCliHmuxAttach,
} from "./cliHmuxAttach";
import {
	type CliHmuxCreateDependencies,
	handleCliHmuxCreate,
} from "./cliHmuxCreate";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import {
	isDockviewProjectionOnly,
	movingPanels,
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openAndCommitHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { preparePaneProjectionRemoval } from "@/lib/workspace/pane/paneCloseCoordinator";
import { useStore } from "@/store";

const fixtures: {
	api: DockviewApi;
	desktopId: string;
	element: HTMLElement;
}[] = [];
const initialLayouts = useStore.getState().layouts;
let sequence = 0;
const session = { sessionId: "runtime", workspaceId: "workspace" };

function setup() {
	const desktopId = `cli-pane-receipt-${++sequence}`;
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(desktopId, api);
	fixtures.push({ api, desktopId, element });
	const shared = {
		claim: vi.fn(async () => true),
		resolvePlacement: vi.fn(async () => undefined),
		activeSpaceId: () => desktopId,
		getDockview: () => api,
		openAndCommit: openAndCommitHmuxStandaloneTerminalOn,
		preparePaneRemoval: preparePaneProjectionRemoval,
		waitForActivation: vi.fn<CliHmuxAttachDependencies["waitForActivation"]>(
			async (identity) => ({
				ownerId: `fixture:${identity.panelId}`,
				...session,
				state: "attached",
				observerAttached: true,
				controllerAttached: true,
			}),
		),
	};
	const abandon = vi.fn(async () => undefined);
	const attach: CliHmuxAttachDependencies = {
		...shared,
		resolveSession: async () => session,
		retarget: vi.fn(),
	};
	const create: CliHmuxCreateDependencies = {
		...shared,
		routeToSpaceOwner: async () => ({ kind: "local", spaceId: desktopId }),
		spaceExists: () => true,
		homeDir: async () => "/fixture",
		terminalDefaultColors: () => ({
			foregroundRgb: 0xffffff,
			backgroundRgb: 0,
		}),
		createStandalone: vi.fn(async () => session),
		openRemote: vi.fn(),
		abandonUnpresentedCreation: abandon,
	};
	const run = (kind: "attach" | "create") =>
		kind === "attach"
			? handleCliHmuxAttach({}, `request-${desktopId}`, attach)
			: handleCliHmuxCreate({}, `request-${desktopId}`, create);
	return { api, desktopId, shared, abandon, run };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const { api, desktopId, element } of fixtures.splice(0)) {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	}
	useStore.setState({ layouts: initialLayouts });
});

describe.each(["attach", "create"] as const)(
	"CLI %s with actual standalone presentation",
	(kind) => {
		it.each(["slot", "launcher:previous", "agent:previous"])(
			"acknowledges and reports the actual reused pane %s",
			async (panelId) => {
				const fixture = setup();
				const pane = fixture.api.addPanel({
					id: panelId,
					component: "terminal",
					params: {
						sessionId: session.sessionId,
						binding: hmuxStandaloneBinding(
							session.sessionId,
							session.workspaceId,
						),
					},
				});
				const peer = fixture.api.addPanel({
					id: "peer",
					component: "launcher",
				});
				const result = await fixture.run(kind);
				expect(result).toMatchObject({
					ok: true,
					pane: { panelId, ...session, paneOwnership: "pre_existing" },
				});
				expect(
					fixture.shared.waitForActivation,
				).toHaveBeenCalledExactlyOnceWith({
					desktopId: fixture.desktopId,
					panelId,
					...session,
				});
				expect(fixture.api.getPanel(panelId)).toBe(pane);
				expect(fixture.api.getPanel(peer.id)).toBe(peer);
				expect(fixture.api.panels).toHaveLength(2);
				expect(fixture.abandon).not.toHaveBeenCalled();
			},
		);

		it.each(["replace", "retarget", "reopen"] as const)(
			"does not remove newer content after delayed attachment failure (%s)",
			async (change) => {
				const fixture = setup();
				let replacement: ReturnType<DockviewApi["replacePanel"]>;
				fixture.shared.waitForActivation.mockImplementationOnce(
					async ({ panelId }) => {
						const source = fixture.api.getPanel(panelId)!;
						if (change === "replace") {
							replacement = fixture.api.replacePanel(source.api, {
								component: "launcher",
								params: { cwd: "/new-user-work" },
							});
						} else if (change === "retarget") {
							source.api.updateParameters({
								sessionId: "new-runtime",
								binding: hmuxStandaloneBinding("new-runtime", "new-workspace"),
							});
							replacement = source;
						} else {
							fixture.api.removePanel(source);
							replacement = fixture.api.addPanel({
								id: panelId,
								component: "launcher",
								params: { cwd: "/new-user-work" },
							});
						}
						useStore
							.getState()
							.saveLayout(fixture.desktopId, fixture.api.toJSON());
						throw new Error("injected attachment failure");
					},
				);
				const result = await fixture.run(kind);
				expect(result).toMatchObject({ ok: false });
				expect(replacement).toBeDefined();
				expect(fixture.api.getPanel(replacement!.id)).toBe(replacement);
				expect(fixture.api.toJSON()).toEqual(
					useStore.getState().layouts[fixture.desktopId],
				);
			},
		);

		it("removes only its newly created view and commits that projection", async () => {
			const fixture = setup();
			const peer = fixture.api.addPanel({ id: "peer", component: "launcher" });
			const removals: {
				id: string;
				projectionOnly: boolean;
				sessionTeardownSuppressed: boolean;
			}[] = [];
			fixture.api.onDidRemovePanel((panel) =>
				removals.push({
					id: panel.id,
					projectionOnly: isDockviewProjectionOnly(fixture.api),
					sessionTeardownSuppressed: movingPanels.has(panel.id),
				}),
			);
			fixture.shared.waitForActivation.mockRejectedValueOnce(
				new Error("injected attachment failure"),
			);
			expect(await fixture.run(kind)).toMatchObject({ ok: false });
			expect(fixture.api.panels).toEqual([peer]);
			expect(fixture.api.toJSON()).toEqual(
				useStore.getState().layouts[fixture.desktopId],
			);
			expect(fixture.abandon).toHaveBeenCalledTimes(kind === "create" ? 1 : 0);
			expect(removals).toEqual([
				{
					id: fixture.shared.waitForActivation.mock.calls[0]![0].panelId,
					projectionOnly: true,
					sessionTeardownSuppressed: true,
				},
			]);
		});

		it("leaves an already closed view absent after attachment failure", async () => {
			const fixture = setup();
			const peer = fixture.api.addPanel({ id: "peer", component: "launcher" });
			fixture.shared.waitForActivation.mockImplementationOnce(
				async ({ panelId }) => {
					fixture.api.removePanel(fixture.api.getPanel(panelId)!);
					useStore
						.getState()
						.saveLayout(fixture.desktopId, fixture.api.toJSON());
					throw new Error("injected attachment failure");
				},
			);
			expect(await fixture.run(kind)).toMatchObject({ ok: false });
			expect(fixture.api.panels).toEqual([peer]);
			expect(fixture.api.toJSON()).toEqual(
				useStore.getState().layouts[fixture.desktopId],
			);
		});
	},
);

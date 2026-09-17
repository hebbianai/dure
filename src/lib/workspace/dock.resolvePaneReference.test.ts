import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneReference } from "@/lib/workspace/dock";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { onDesktopPrewarmRequest } from "@/lib/workspace/desktop/desktopPrewarm";
import { openAndCommitHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { useStore } from "@/store";

const registered: { desktopId: string; api: DockviewApi }[] = [];

function registerLiveTerminal(
	desktopId: string,
	sessionId: string,
): DockviewApi {
	const group = {
		element: { isConnected: true },
	};
	const params = { sessionId, cwd: "/repo" };
	const panel = {
		id: `term:${sessionId}`,
		params,
		api: { component: "terminal", getParameters: () => params },
		group,
	};
	const api = {
		panels: [panel],
		groups: [group],
		getPanel: (panelId: string) => (panelId === panel.id ? panel : undefined),
	} as unknown as DockviewApi;
	registerDockview(desktopId, api);
	registered.push({ desktopId, api });
	return api;
}

afterEach(() => {
	for (const entry of registered.splice(0)) {
		unregisterDockview(entry.desktopId, entry.api);
	}
	useStore.setState({
		activeSpaceId: "desktop-1",
		agents: [],
		layouts: {},
		sessionCwd: {},
	});
	vi.restoreAllMocks();
});

describe("resolvePaneReference", () => {
	it("resolves an inactive warm-mounted desktop without activating it", async () => {
		const api = registerLiveTerminal("desktop-target", "standalone-target");
		useStore.setState({
			activeSpaceId: "desktop-other",
			agents: [],
			layouts: {},
			sessionCwd: {},
		});

		const resolved = await resolvePaneReference("standalone-target");

		expect(resolved).toEqual({
			desktopId: "desktop-target",
			api,
			panelId: "term:standalone-target",
			cwd: "/repo",
		});
		expect(useStore.getState().activeSpaceId).toBe("desktop-other");
	});

	it("prepares an inactive cold desktop without activating it", async () => {
		const stop = onDesktopPrewarmRequest((desktopId) => {
			if (desktopId === "desktop-cold") {
				registerLiveTerminal(desktopId, "cold-target");
			}
		});
		useStore.setState({
			activeSpaceId: "desktop-other",
			agents: [],
			layouts: {
				"desktop-cold": {
					panels: {
						"term:cold-target": {
							id: "term:cold-target",
							contentComponent: "terminal",
							params: { sessionId: "cold-target", cwd: "/repo" },
						},
					},
				},
			},
			sessionCwd: {},
		});

		try {
			await expect(resolvePaneReference("cold-target")).resolves.toMatchObject({
				desktopId: "desktop-cold",
				panelId: "term:cold-target",
			});
			expect(useStore.getState().activeSpaceId).toBe("desktop-other");
		} finally {
			stop();
		}
	});
});

describe("openAndCommitHmuxStandaloneTerminalOn", () => {
	it("commits an explicitly mounted pane even when its desktop is inactive", () => {
		const desktopId = "desktop-target";
		const sessionId = "standalone-created";
		const group = {
			element: { isConnected: true },
		};
		const panels: Array<Record<string, unknown>> = [];
		const api = {
			panels,
			groups: [group],
			getPanel: (panelId: string) =>
				panels.find((panel) => panel.id === panelId),
			addPanel: (options: Record<string, unknown>) => {
				const panel = { ...options, group };
				panels.push(panel);
				return panel;
			},
			toJSON: () => ({
				panels: Object.fromEntries(
					panels.map((panel) => [
						panel.id,
						{
							id: panel.id,
							params: panel.params,
						},
					]),
				),
			}),
		} as unknown as DockviewApi;
		registerDockview(desktopId, api);
		registered.push({ desktopId, api });
		useStore.setState({
			activeSpaceId: "desktop-other",
			layouts: {},
		});

		const { panel } = openAndCommitHmuxStandaloneTerminalOn(
			desktopId,
			api,
			sessionId,
			"workspace-created",
			"/repo",
		);

		expect(useStore.getState().layouts[desktopId]).toEqual({
			panels: {
				[panel.id]: {
					id: panel.id,
					params: expect.objectContaining({
						sessionId,
						cwd: "/repo",
					}),
				},
			},
		});
	});

	it("rolls back the live Dockview when persistence fails", () => {
		const desktopId = "desktop-target";
		const before = { panels: {} };
		const addPanel = vi.fn();
		const fromJSON = vi.fn();
		const api = {
			panels: [],
			groups: [],
			getPanel: () => undefined,
			addPanel,
			toJSON: () => before,
			fromJSON,
		} as unknown as DockviewApi;
		registerDockview(desktopId, api);
		registered.push({ desktopId, api });
		vi.spyOn(useStore.getState(), "saveLayout").mockImplementationOnce(() => {
			throw new Error("persistence failed");
		});

		expect(() =>
			openAndCommitHmuxStandaloneTerminalOn(
				desktopId,
				api,
				"standalone-created",
				"workspace-created",
				"/repo",
			),
		).toThrow("persistence failed");

		expect(addPanel).toHaveBeenCalledOnce();
		expect(fromJSON).toHaveBeenCalledExactlyOnceWith(before, {
			reuseExistingPanels: true,
		});
	});
});

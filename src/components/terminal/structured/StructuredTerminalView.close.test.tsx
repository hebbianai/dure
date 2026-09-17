// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { removeDesktopWithSessions } from "@/lib/workspace/desktop/desktopLifecycle";
import {
	hmuxPaneBinding as binding,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	installAttachMock,
	installDeferredAttachMock,
	deliverViewportFrame,
	mocks,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	restoreStructuredTerminalHarness,
	structuredObserverId,
} from "./structuredTerminalTestHarness";
const fixture = vi.hoisted(() => ({
	layouts: {} as Record<string, unknown>,
	departure: vi.fn(),
	restoreSpaces: undefined as (() => void) | undefined,
}));
vi.mock("@/lib/workspace/pane/paneClose", () => ({
	prepareExplicitHmuxPaneClose: fixture.departure,
}));
vi.mock("@/lib/workspace/pane/paneMutationSizing", () => ({
	removePanePreservingSizes: (api: DockviewApi, panel: Parameters<DockviewApi["removePanel"]>[0]) =>
		api.removePanel(panel),
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).workspaceRuntimeContextMockFactory(),
);

vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).largeViewReturnSourceRuntimeMockFactory(),
);

vi.mock("@/lib/workspace/window/currentWindowFocus", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).currentWindowFocusMockFactory(),
);

vi.mock("@/lib/ipc", async () =>
	(await import("./structuredTerminalTestHarness")).ipcMockFactory(),
);

vi.mock("@/store", async () => {
	const result = (
		await import("./structuredTerminalTestHarness")
	).storeMockFactory();
	Object.assign(result.useStore.getState(), {
		layouts: fixture.layouts,
		spaces: [{ id: "close-desktop" }],
		saveLayout: (id: string, layout: unknown) => {
			fixture.layouts[id] = layout;
		},
		forgetSessionRuntime: vi.fn(),
		removeSpace: () => {
			Object.assign(result.useStore.getState(), { spaces: [] });
		},
	});
	fixture.restoreSpaces = () => {
		Object.assign(result.useStore.getState(), {
			spaces: [{ id: "close-desktop" }],
		});
	};
	return result;
});

vi.mock("@tauri-apps/plugin-clipboard-manager", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).clipboardManagerMockFactory(),
);

vi.mock("@/lib/toast", async () =>
	(await import("./structuredTerminalTestHarness")).toastMockFactory(),
);

vi.mock("@/components/terminal/TerminalViewChrome", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalViewChromeMockFactory(),
);

vi.mock("./TerminalCanvasRenderer", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalCanvasRendererMockFactory(),
);

registerStructuredTerminalView(StructuredTerminalView);

beforeEach(() => {
	localStorage.clear();
	dockviewRegistry.clear();
	fixture.departure.mockReset();
	resetStructuredTerminalHarness();
	mocks.desktopId = "close-desktop";
	fixture.restoreSpaces?.();
});

afterEach(() => {
	restoreStructuredTerminalHarness();
	dockviewRegistry.clear();
	localStorage.clear();
});

function mountedPane() {
	const subscribe = () => ({ dispose: () => {} });
	const panel = {
		id: "term:session-a",
		params: { sessionId: "session-a", binding: binding("session-a") },
		api: {
			id: "term:session-a",
			component: "terminal",
			group: { api: { onWillFocus: subscribe } },
			onDidGroupChange: subscribe,
			onDidActiveChange: subscribe,
			onDidVisibilityChange: subscribe,
			onDidActiveGroupChange: subscribe,
		},
	};
	const panels = new Map([[panel.id, panel]]);
	const api = {
		getPanel: (id: string) => panels.get(id),
		toJSON: () => ({
			panels: Object.fromEntries(
				[...panels].map(([id, p]) => [
					id,
					{ contentComponent: p.api.component, params: p.params },
				]),
			),
		}),
		removePanel: (p: typeof panel) => {
			panels.delete(p.id);
		},
	};
	dockviewRegistry.set("close-desktop", api as unknown as DockviewApi);
	fixture.layouts["close-desktop"] = api.toJSON();
	return {
		panel,
		panels,
		api,
		paneApi: panel.api as unknown as IDockviewPanelProps["api"],
	};
}

describe("explicit close and structured attachment lifetime", () => {
	for (const scope of ["pane", "desktop"] as const) {
		it(`${scope} retires the observer before native departure, without recovery`, async () => {
			const { panel, paneApi } = mountedPane();
			const onRecords = installAttachMock();
			const view = renderTerminalView({ paneApi });
			let complete!: () => void;
			const departure = new Promise<void>((resolve) => {
				complete = resolve;
			});
			const detachedAtDeparture: number[] = [];
			fixture.departure.mockImplementation(() => {
				detachedAtDeparture.push(mocks.detach.mock.calls.length);
				for (const waiter of mocks.pullWaiters.get(structuredObserverId(1)) ??
					[])
					waiter.reject(new Error("hmux_structured_pull_retired"));
				return departure;
			});
			try {
				await waitFor(() => expect(onRecords).toHaveLength(1));
				await deliverViewportFrame(onRecords[0], { texts: ["before close"] });
				let closing!: Promise<unknown>;
				await act(async () => {
					closing =
						scope === "pane"
							? closePanelById(panel.id, "close-desktop")
							: removeDesktopWithSessions("close-desktop");
				});
				await waitFor(() => expect(fixture.departure).toHaveBeenCalledTimes(1));
				expect(detachedAtDeparture).toEqual([1]);
				expect(mocks.attach).toHaveBeenCalledTimes(1);
				await act(async () => {
					complete();
					await closing;
				});
			} finally {
				complete?.();
				view.unmount();
			}
		});
	}
	it("waits for an already invoked attach to settle before departure", async () => {
		const { panel, paneApi } = mountedPane();
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView({ paneApi });
		try {
			await waitFor(() => expect(onRecords).toHaveLength(1));
			let closing!: Promise<unknown>;
			await act(async () => {
				closing = closePanelById(panel.id, "close-desktop");
			});
			expect(fixture.departure).not.toHaveBeenCalled();
			expect(mocks.detach).toHaveBeenCalledWith(structuredObserverId(1));
			await act(async () => {
				resolveAttach();
				await closing;
			});
			expect(fixture.departure).toHaveBeenCalledTimes(1);
			expect(mocks.attach).toHaveBeenCalledTimes(1);
		} finally {
			resolveAttach();
			view.unmount();
		}
	});

	it("recovers a retired pull when no explicit close was requested", async () => {
		const { paneApi } = mountedPane();
		const records = installAttachMock((ordinal, request) => {
			if (ordinal > 1)
				request.onRecord(viewportFrameRecord({ texts: ["recovered seed"] }));
			return undefined;
		});
		const view = renderTerminalView({ paneApi });
		try {
			await waitFor(() => expect(records).toHaveLength(1));
			await deliverViewportFrame(records[0], { texts: ["working connection"] });
			await act(async () => {
				for (const waiter of mocks.pullWaiters.get(structuredObserverId(1)) ??
					[])
					waiter.reject(new Error("hmux_structured_pull_retired"));
			});
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
			await deliverViewportFrame(records[1], {
				texts: ["recovered connection"],
			});
			expect(fixture.departure).not.toHaveBeenCalled();
		} finally {
			view.unmount();
		}
	});
	it("does not attach a freshly mounted view while its close departure is pending", async () => {
		const { panel, paneApi } = mountedPane();
		const records = installAttachMock((ordinal, request) => {
			if (ordinal > 1)
				request.onRecord(viewportFrameRecord({ texts: ["recovered seed"] }));
			return undefined;
		});
		const first = renderTerminalView({ paneApi });
		let complete!: () => void;
		fixture.departure.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		await waitFor(() => expect(records).toHaveLength(1));
		await deliverViewportFrame(records[0], { texts: ["before remount"] });
		let closing!: Promise<unknown>;
		await act(async () => {
			closing = closePanelById(panel.id, "close-desktop");
		});
		await waitFor(() => expect(fixture.departure).toHaveBeenCalledTimes(1));
		first.unmount();
		const replacement = renderTerminalView({ paneApi });
		try {
			await act(async () => {});
			expect(mocks.attach).toHaveBeenCalledTimes(1);
			await act(async () => {
				complete();
				await closing;
			});
			expect(mocks.attach).toHaveBeenCalledTimes(1);
		} finally {
			complete();
			replacement.unmount();
		}
	});
	it("restores the normal attachment path when the close CAS preserves updated pane params", async () => {
		const { panel, paneApi } = mountedPane();
		const records = installAttachMock((ordinal, request) => {
			if (ordinal > 1)
				request.onRecord(viewportFrameRecord({ texts: ["recovered seed"] }));
			return undefined;
		});
		const view = renderTerminalView({ paneApi });
		let complete!: () => void;
		fixture.departure.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		try {
			await waitFor(() => expect(records).toHaveLength(1));
			await deliverViewportFrame(records[0], { texts: ["before update"] });
			let closing!: Promise<unknown>;
			await act(async () => {
				closing = closePanelById(panel.id, "close-desktop").catch(
					(error) => error,
				);
			});
			await waitFor(() => expect(fixture.departure).toHaveBeenCalledTimes(1));
			Object.assign(panel.params, { title: "updated while pending" });
			await act(async () => {
				complete();
				expect(await closing).toMatchObject({ code: "pane_changed" });
			});
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
			expect(dockviewRegistry.get("close-desktop")?.getPanel(panel.id)).toBe(
				panel,
			);
		} finally {
			complete?.();
			view.unmount();
		}
	});
	it("does not depart a replacement that appeared while detachment was pending", async () => {
		const { panel, paneApi } = mountedPane();
		const records = installAttachMock((ordinal, request) => {
			if (ordinal > 1)
				request.onRecord(viewportFrameRecord({ texts: ["recovered seed"] }));
			return undefined;
		});
		const view = renderTerminalView({ paneApi });
		let complete!: () => void;
		mocks.detach.mockReturnValueOnce(
			new Promise<undefined>((resolve) => {
				complete = () => resolve(undefined);
			}),
		);
		try {
			await waitFor(() => expect(records).toHaveLength(1));
			await deliverViewportFrame(records[0], { texts: ["old generation"] });
			let closing!: Promise<unknown>;
			await act(async () => {
				closing = closePanelById(panel.id, "close-desktop").catch(
					(error) => error,
				);
			});
			await waitFor(() => expect(mocks.detach).toHaveBeenCalledTimes(1));
			panel.params = {
				sessionId: "replacement",
				binding: binding("replacement"),
			};
			await act(async () => {
				complete();
				expect(await closing).toMatchObject({ code: "pane_changed" });
			});
			expect(fixture.departure).not.toHaveBeenCalled();
			expect(
				dockviewRegistry.get("close-desktop")?.getPanel(panel.id)?.params?.sessionId,
			).toBe("replacement");
		} finally {
			complete?.();
			view.unmount();
		}
	});

	it("waits for a hidden view's retiring attach before closing its retained pane", async () => {
		const { panel, paneApi } = mountedPane();
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView({ paneApi });
		await waitFor(() => expect(onRecords).toHaveLength(1));
		view.unmount();
		try {
			let closing!: Promise<unknown>;
			await act(async () => {
				closing = closePanelById(panel.id, "close-desktop");
			});
			expect(fixture.departure).not.toHaveBeenCalled();
			await act(async () => {
				resolveAttach();
				await closing;
			});
			expect(fixture.departure).toHaveBeenCalledTimes(1);
		} finally {
			resolveAttach();
		}
	});
});

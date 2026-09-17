import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPaneTransferPayload,
	createPaneWindowDropRequest,
	PANE_TRANSFER_MIME,
	PANE_WINDOW_DROP_EVENT,
	serializePaneTransferPayload,
} from "@/lib/workspace/pane/paneWindowTransfer";

const mocks = vi.hoisted(() => ({
	dropPosition: vi.fn(),
	movePanelToDesktopDrop: vi.fn(),
	recoverProjection: vi.fn(),
	listen: vi.fn(),
	unlisten: vi.fn(),
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

const REALM_EVENT_AUTHORITY_KEY = "__dureTauriWebviewEventAuthorityV1";

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		label: "win-target",
		innerPosition: async () => ({ x: 0, y: 0 }),
		scaleFactor: async () => 1,
	}),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: mocks.listen,
}));

vi.mock("@/lib/workspace/pane/panePlacement", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/pane/panePlacement")>()),
	dropPosition: mocks.dropPosition,
}));
vi.mock("@/lib/workspace/pane/paneDropCoordinator", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/pane/paneDropCoordinator")>()),
	movePanelToDesktopDrop: mocks.movePanelToDesktopDrop,
}));

vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection: mocks.recoverProjection,
}));

import {
	handlePaneWindowDataDrop,
	installPaneWindowDropTarget,
} from "@/lib/workspace/pane/paneWindowTransferRuntime";

function dataTransfer(raw: string) {
	return {
		dropEffect: "none",
		getData: (type: string) => (type === PANE_TRANSFER_MIME ? raw : ""),
	};
}

function dropEvent(raw: string, position = "right", group?: unknown) {
	return {
		nativeEvent: {
			dataTransfer: dataTransfer(raw),
		} as unknown as DragEvent,
		position,
		group,
	};
}

beforeEach(() => {
	delete (globalThis as unknown as Record<string, unknown>)[
		REALM_EVENT_AUTHORITY_KEY
	];
	mocks.dropPosition.mockReset();
	mocks.dropPosition.mockImplementation((group, position) => ({
		referenceGroup: group,
		direction: position,
	}));
	mocks.movePanelToDesktopDrop.mockReset();
	mocks.movePanelToDesktopDrop.mockResolvedValue({});
	mocks.recoverProjection.mockReset();
	mocks.recoverProjection.mockResolvedValue(true);
	mocks.unlisten.mockReset();
	mocks.handlers.clear();
	mocks.listen.mockReset();
	mocks.listen.mockImplementation(
		async (event: string, handler: (event: { payload: unknown }) => void) => {
			mocks.handlers.set(event, handler);
			return mocks.unlisten;
		},
	);
});

describe("handlePaneWindowDataDrop", () => {
	it("accepts another window's pane as a move and keeps a stable group id", async () => {
		const payload = createPaneTransferPayload(
			{
				panelId: "term:moved",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "main",
			},
			"direct-request",
		);
		const group = { id: "group-target" };
		const event = dropEvent(
			serializePaneTransferPayload(payload),
			"right",
			group,
		);

		expect(handlePaneWindowDataDrop(event, "desk-target")).toBe(true);
		expect(event.nativeEvent.dataTransfer?.dropEffect).toBe("move");
		await vi.waitFor(() =>
			expect(mocks.movePanelToDesktopDrop).toHaveBeenCalledWith(
				{
					panelId: "term:moved",
					fromDesktopId: "desk-source",
				},
				"desk-target",
				{ referenceGroup: "group-target", direction: "right" },
			),
		);
	});

	it("leaves same-window, file, and forbidden center drops to existing handlers", () => {
		const sameWindow = createPaneTransferPayload(
			{
				panelId: "term:same",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "win-target",
			},
			"same-request",
		);
		expect(
			handlePaneWindowDataDrop(
				dropEvent(serializePaneTransferPayload(sameWindow)),
				"desk-target",
			),
		).toBe(false);
		expect(handlePaneWindowDataDrop(dropEvent(""), "desk-target")).toBe(false);

		const otherWindow = createPaneTransferPayload(
			{
				panelId: "term:center",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "main",
			},
			"center-request",
		);
		expect(
			handlePaneWindowDataDrop(
				dropEvent(serializePaneTransferPayload(otherWindow), "center"),
				"desk-target",
			),
		).toBe(false);
		expect(mocks.movePanelToDesktopDrop).not.toHaveBeenCalled();
	});

	it("does not move through a stale target projection", async () => {
		mocks.recoverProjection.mockResolvedValueOnce(false);
		const payload = createPaneTransferPayload(
			{
				panelId: "term:stale",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "main",
			},
			"stale-projection-request",
		);

		expect(
			handlePaneWindowDataDrop(
				dropEvent(serializePaneTransferPayload(payload)),
				"desk-target",
			),
		).toBe(true);

		await vi.waitFor(() =>
			expect(mocks.recoverProjection).toHaveBeenCalledWith({
				forceProjectionDesktopIds: ["desk-target"],
			}),
		);
		expect(mocks.movePanelToDesktopDrop).not.toHaveBeenCalled();
	});
});

describe("installPaneWindowDropTarget", () => {
	it("retires local routes without tearing down realm-retained native callbacks", async () => {
		const nativeStops = new Map<string, ReturnType<typeof vi.fn>>();
		mocks.listen.mockImplementation(
			async (event: string, handler: (event: { payload: unknown }) => void) => {
				mocks.handlers.set(event, handler);
				const nativeStop = vi.fn(() => {
					throw new TypeError(
						"Cannot read properties of undefined (reading 'handlerId')",
					);
				});
				nativeStops.set(event, nativeStop);
				return nativeStop;
			},
		);

		const stop = installPaneWindowDropTarget({
			desktopId: "desk-target",
			isActive: () => true,
			api: () => undefined,
			element: () => null,
		});
		await vi.waitFor(() => expect(nativeStops.size).toBe(2));

		expect(() => stop()).not.toThrow();
		expect(() => stop()).not.toThrow();
		for (const nativeStop of nativeStops.values()) {
			expect(nativeStop).not.toHaveBeenCalled();
		}
	});

	it("maps a native dragend request to the active target group edge", async () => {
		const api = {
			groups: [
				{
					id: "group-target",
					api: {
						boundingBox: {
							left: 100,
							top: 100,
							width: 500,
							height: 400,
						},
					},
				},
			],
		};
		const element = {
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				width: 800,
				height: 600,
			}),
		};
		const stop = installPaneWindowDropTarget({
			desktopId: "desk-target",
			isActive: () => true,
			api: () => api as never,
			element: () => element as never,
		});
		await vi.waitFor(() => expect(mocks.handlers.size).toBe(2));
		expect([...mocks.handlers.keys()]).toEqual([
			PANE_WINDOW_DROP_EVENT,
			"hebbian:pane-window-drop-v1",
		]);

		const payload = createPaneTransferPayload(
			{
				panelId: "term:fallback",
				fromDesktopId: "desk-source",
				sourceWindowLabel: "main",
			},
			"fallback-request",
		);
		mocks.handlers.get("hebbian:pane-window-drop-v1")?.({
			payload: createPaneWindowDropRequest(payload, "win-target", {
				x: 105,
				y: 300,
			}),
		});

		await vi.waitFor(() =>
			expect(mocks.movePanelToDesktopDrop).toHaveBeenCalledWith(
				{
					panelId: "term:fallback",
					fromDesktopId: "desk-source",
				},
				"desk-target",
				{ referenceGroup: "group-target", direction: "left" },
			),
		);
		expect(mocks.recoverProjection).toHaveBeenCalledWith({
			forceProjectionDesktopIds: ["desk-target"],
		});
		stop();
		expect(mocks.unlisten).not.toHaveBeenCalled();
	});
});

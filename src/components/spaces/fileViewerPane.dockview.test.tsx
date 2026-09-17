// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiddenFilePaneRows } from "@/components/spaces/HiddenFilePaneRows";
import { withDesktopDockview } from "@/lib/workspace/dock";
import {
	dockviewRegistry,
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	markFilePaneHidden,
	useHiddenFilePanes,
} from "@/lib/workspace/pane/hiddenFilePanesStore";
import { useRecentFileOpens } from "@/lib/files/recentFileOpensStore";
import { useStore } from "@/store";
import { fileDraftKey, type FileTarget } from "@/lib/files/fileTarget";
import {
	openFileViewer,
	openFileViewerOn,
	restoreHiddenFilePaneOn,
} from "@/lib/files/fileViewerPane";

vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	withDesktopDockview: vi.fn(),
}));

const local = { path: "/repo/notes.md", source: "local" as const };
const mockup = {
	path: "/repo/design/mockups/workspace/Pane/default.html",
	source: "local" as const,
};
const disposals: (() => void)[] = [];
let sequence = 0;

function fixture() {
	const desktopId = `file-space-${++sequence}`;
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
	disposals.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	});
	return { api, desktopId };
}

function rememberHidden(
	desktopId: string,
	id: string,
	file: FileTarget = local,
) {
	markFilePaneHidden(id, {
		desktopId,
		file,
		anchor: { floating: { x: 23, y: 34, width: 500, height: 400 } },
	});
	return useHiddenFilePanes.getState().hidden[id];
}

beforeEach(() => {
	useHiddenFilePanes.setState({ hidden: {} });
	useRecentFileOpens.setState({ entries: [] });
	useStore.setState({ fileDrafts: {} });
	vi.mocked(withDesktopDockview).mockImplementation((desktopId, action) => {
		const api = dockviewRegistry.get(desktopId);
		if (api) action(api);
	});
});

afterEach(() => {
	cleanup();
	for (const dispose of disposals.splice(0)) dispose();
	vi.restoreAllMocks();
});

describe("file and mockup view identity", () => {
	it.each([
		{ target: local, component: "fileviewer" },
		{
			target: { ...local, source: "ssh" as const, hostId: "host" },
			component: "fileviewer",
		},
		{ target: mockup, component: "mockup" },
	])(
		"allocates independent neutral $component IDs and reuses the current document",
		({ target, component }) => {
			const first = fixture();
			const second = fixture();
			openFileViewer(first.desktopId, target);
			openFileViewer(second.desktopId, target);
			const pane = first.api.activePanel!;
			expect(pane.id).toMatch(/^pane-/);
			expect(pane.api.component).toBe(component);
			expect(second.api.activePanel?.id).not.toBe(pane.id);
			openFileViewerOn(first.api, target);
			expect(first.api.panels).toEqual([pane]);
		},
	);

	it.each(["pane-file", "agent:previous", `file:${fileDraftKey(local)}`])(
		"reuses the actual file content in restored pane %s without renaming it",
		(id) => {
			const { api } = fixture();
			api.addPanel({ id, component: "fileviewer", params: local });
			const saved = api.toJSON();
			api.fromJSON(saved);
			const pane = api.getPanel(id)!;
			openFileViewerOn(api, local);
			expect(api.panels).toEqual([pane]);
			expect(api.activePanel).toBe(pane);
			expect(api.toJSON()).toEqual(saved);
		},
	);

	it.each([
		{ component: "terminal", params: local },
		{ component: "fileviewer", params: { ...local, path: "/repo/changed.md" } },
		{
			component: "fileviewer",
			params: { ...local, source: "ssh", hostId: "host" },
		},
		{ component: "fileviewer", params: { ...local, source: "unknown" } },
	])(
		"does not reuse a historical ID with different current content: $component $params",
		({ component, params }) => {
			const { api } = fixture();
			const previous = api.addPanel({
				id: `file:${fileDraftKey(local)}`,
				component,
				params,
			});
			openFileViewerOn(api, local);
			expect(api.panels).toHaveLength(2);
			expect(api.getPanel(previous.id)).toBe(previous);
			expect(previous.params).toEqual(params);
			expect(api.activePanel?.params).toEqual(local);
			expect(api.activePanel?.id).not.toBe(previous.id);
		},
	);

	it("preserves an existing editor and its draft when a path now defaults to mockup preview", () => {
		const { api } = fixture();
		const pane = api.addPanel({
			id: "old-editor",
			component: "fileviewer",
			params: mockup,
		});
		useStore.getState().setFileDraft(fileDraftKey(mockup), "unsaved edits");
		openFileViewerOn(api, mockup);
		expect(api.panels).toEqual([pane]);
		expect(pane.api.component).toBe("fileviewer");
		expect(useStore.getState().fileDrafts[fileDraftKey(mockup)]).toBe(
			"unsaved edits",
		);
	});

	it("finds neutral mockup content without using its historical path-shaped ID", () => {
		const { api } = fixture();
		const pane = api.addPanel({
			id: "pane-preview",
			component: "mockup",
			params: { path: mockup.path },
		});
		const old = api.addPanel({
			id: `mockup:${mockup.path}`,
			component: "terminal",
		});
		openFileViewerOn(api, mockup);
		expect(api.activePanel).toBe(pane);
		expect(api.panels).toEqual([pane, old]);
	});

	it("preserves a replacement slot and does not allocate another pane on replay", () => {
		const { api } = fixture();
		const slot = api.addPanel({
			id: "launcher:historical",
			component: "launcher",
		});
		const position = { replacement: slot.api };
		openFileViewerOn(api, local, position);
		const pane = api.getPanel(slot.id)!;
		expect(pane.api.component).toBe("fileviewer");
		openFileViewerOn(api, local, position);
		expect(api.panels).toEqual([pane]);
	});

	it("keeps same-path SSH files on different hosts distinct without changing draft keys", () => {
		const { api } = fixture();
		for (const hostId of ["one", "two"]) {
			openFileViewerOn(api, { ...local, source: "ssh", hostId });
		}
		expect(api.panels).toHaveLength(2);
		expect(new Set(api.panels.map((pane) => pane.id)).size).toBe(2);
		expect(api.panels.map((pane) => pane.params?.hostId)).toEqual([
			"one",
			"two",
		]);
	});

	it("restores the same hidden grid slot when opening its document", () => {
		const { api, desktopId } = fixture();
		const pane = api.addPanel({
			id: "pane-grid",
			component: "fileviewer",
			params: local,
		});
		const saved = api.toJSON().grid;
		pane.group.api.setVisible(false);
		rememberHidden(desktopId, pane.id);
		openFileViewerOn(api, local);
		expect(api.panels).toEqual([pane]);
		expect(api.toJSON().grid).toEqual(saved);
		expect(useHiddenFilePanes.getState().hidden[pane.id]).toBeUndefined();
	});

	it("does not clear another Space's hidden record for the same document", () => {
		const first = fixture();
		const second = fixture();
		const id = `file:${fileDraftKey(local)}`;
		const record = rememberHidden(first.desktopId, id);
		openFileViewerOn(second.api, local);
		expect(useHiddenFilePanes.getState().hidden[id]).toBe(record);
		openFileViewerOn(first.api, local);
		expect(first.api.activePanel?.id).toBe(id);
		expect(second.api.activePanel?.id).not.toBe(id);
		expect(useHiddenFilePanes.getState().hidden[id]).toBeUndefined();
	});
});

describe("exact hidden file row restoration", () => {
	it("preserves the selected record if creating its replacement view fails", () => {
		const { api, desktopId } = fixture();
		const record = rememberHidden(desktopId, "pane-hidden");
		const add = vi.spyOn(api, "addPanel").mockImplementationOnce(() => {
			throw new Error("injected view creation failure");
		});
		expect(() => restoreHiddenFilePaneOn(api, "pane-hidden", record)).toThrow(
			"injected view creation failure",
		);
		expect(useHiddenFilePanes.getState().hidden["pane-hidden"]).toBe(record);
		expect(api.panels).toEqual([]);
		expect(useRecentFileOpens.getState().entries).toEqual([]);
		add.mockRestore();
		expect(restoreHiddenFilePaneOn(api, "pane-hidden", record)?.id).toBe(
			"pane-hidden",
		);
		expect(useHiddenFilePanes.getState().hidden["pane-hidden"]).toBeUndefined();
	});

	it("keeps an exact delayed restore valid when another hidden record changes", () => {
		const { api, desktopId } = fixture();
		const record = rememberHidden(desktopId, "pane-hidden");
		let deliver!: (api: DockviewApi) => void;
		vi.mocked(withDesktopDockview).mockImplementation((_id, action) => {
			deliver = action;
		});
		render(<HiddenFilePaneRows desktopId={desktopId} />);
		fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
		act(() => rememberHidden("another-space", "unrelated"));
		expect(useHiddenFilePanes.getState().hidden["pane-hidden"]).toBe(record);
		act(() => deliver(api));
		expect(api.activePanel?.id).toBe("pane-hidden");
		expect(useHiddenFilePanes.getState().hidden["pane-hidden"]).toBeUndefined();
		expect(useHiddenFilePanes.getState().hidden.unrelated).toBeDefined();
	});

	it("restores the selected floating view even when another view shows the same document", () => {
		const { api, desktopId } = fixture();
		const visible = api.addPanel({
			id: "visible",
			component: "fileviewer",
			params: local,
		});
		rememberHidden(desktopId, "pane-hidden");
		render(<HiddenFilePaneRows desktopId={desktopId} />);
		fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
		expect(api.panels).toHaveLength(2);
		expect(api.getPanel(visible.id)).toBe(visible);
		expect(api.activePanel?.id).toBe("pane-hidden");
		expect(api.activePanel?.group.api.location.type).toBe("floating");
		expect(useHiddenFilePanes.getState().hidden["pane-hidden"]).toBeUndefined();
	});

	it("restores a legacy hidden editor as its original content, not a new mockup preview", () => {
		const { api, desktopId } = fixture();
		const id = `file:${fileDraftKey(mockup)}`;
		rememberHidden(desktopId, id, mockup);
		render(<HiddenFilePaneRows desktopId={desktopId} />);
		fireEvent.click(screen.getByRole("button", { name: /default.html/ }));
		expect(api.activePanel?.id).toBe(id);
		expect(api.activePanel?.api.component).toBe("fileviewer");
		expect(api.activePanel?.params).toEqual(mockup);
	});

	it("retires only an obsolete hidden record when its pane already has other content", () => {
		const { api, desktopId } = fixture();
		const current = api.addPanel({
			id: "pane-hidden",
			component: "terminal",
			params: { sessionId: "preserved" },
		});
		rememberHidden(desktopId, current.id);
		const before = api.toJSON();
		render(<HiddenFilePaneRows desktopId={desktopId} />);
		fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
		expect(api.toJSON()).toEqual(before);
		expect(api.getPanel(current.id)).toBe(current);
		expect(useHiddenFilePanes.getState().hidden[current.id]).toBeUndefined();
	});

	it.each(["removed", "hidden-again", "moved"])(
		"does not retarget a delayed row restore after the record is %s",
		(change) => {
			const { api, desktopId } = fixture();
			rememberHidden(desktopId, "pane-hidden");
			let deliver!: (api: DockviewApi) => void;
			vi.mocked(withDesktopDockview).mockImplementation((_id, action) => {
				deliver = action;
			});
			render(<HiddenFilePaneRows desktopId={desktopId} />);
			fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
			act(() => {
				if (change === "removed")
					useHiddenFilePanes.getState().clearHidden("pane-hidden");
				else
					rememberHidden(
						change === "moved" ? "other-space" : desktopId,
						"pane-hidden",
					);
			});
			const latest = useHiddenFilePanes.getState().hidden;
			act(() => deliver(api));
			expect(api.panels).toEqual([]);
			expect(useHiddenFilePanes.getState().hidden).toBe(latest);
		},
	);
});

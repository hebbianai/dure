import { beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import {
	type PaneWindowCollector,
	resolveMountedPaneWindow,
	revalidateMountedPaneWindow,
} from "./mountedPaneWindow";

const native = vi.hoisted(() => ({
	mounts: vi.fn(),
	moving: new Set<string>(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
	getAllWebviewWindows: vi.fn(),
}));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	mountedDockviewEntries: native.mounts,
	movingPanels: native.moving,
	getDockview: vi.fn(),
}));

const paneId = "agent:chat";
function sample(windowLabel: string, active = true) {
	return {
		paneId,
		windowLabel,
		windowGeneration: `${windowLabel}-generation`,
		moving: false,
		mounts: [{ paneId, desktopId: "chat-space", dockviewId: "dock-1", active }],
	};
}
function collector(
	observations: ReturnType<typeof sample>[],
	missing = false,
): PaneWindowCollector {
	let listener: ((payload: unknown) => void) | undefined;
	return {
		currentWindowLabel: () => "main",
		listWindowLabels: async () => observations.map((item) => item.windowLabel),
		readLocal: () =>
			observations.find((item) => item.windowLabel === "main") ?? {
				...sample("main"),
				mounts: [],
			},
		listenResponse: async (receive) => {
			listener = receive;
			return () => {
				listener = undefined;
			};
		},
		emitRequest: async (windowLabel, request) => {
			if (!missing)
				listener?.({
					requestId: request.requestId,
					sample: observations.find((item) => item.windowLabel === windowLabel),
				});
		},
	};
}

beforeEach(() => {
	native.mounts.mockReset();
	native.moving.clear();
});

it("resolves the active mounted pane in another window without assuming main owns it", async () => {
	await expect(
		resolveMountedPaneWindow(
			paneId,
			undefined,
			collector([sample("main", false), sample("win-100-2")]),
		),
	).resolves.toEqual({
		schemaVersion: 1,
		paneId,
		desktopId: "chat-space",
		dockviewId: "dock-1",
		windowLabel: "win-100-2",
		windowGeneration: "win-100-2-generation",
	});
});
it("refuses two active owners unless the caller explicitly selects a window", async () => {
	const samples = [sample("main"), sample("win-100-2")];
	await expect(
		resolveMountedPaneWindow(paneId, undefined, collector(samples)),
	).rejects.toMatchObject({ code: "pane_ambiguous" });
	await expect(
		resolveMountedPaneWindow(paneId, "win-100-2", collector(samples)),
	).resolves.toMatchObject({ windowLabel: "win-100-2" });
});

it("reads legacy exact-pane replies with the pane ID only on the sample", async () => {
	const transport = collector([sample("win-100-2")]);
	const listen = transport.listenResponse;
	transport.listenResponse = (receive) =>
		listen((payload) => {
			const old = payload as { sample: { mounts: Array<{ paneId?: string }> } };
			for (const mount of old.sample.mounts) delete mount.paneId;
			receive(payload);
		});
	await expect(
		resolveMountedPaneWindow(paneId, undefined, transport),
	).resolves.toMatchObject({ paneId, windowLabel: "win-100-2" });
});

it.each([null, "pane:other"])(
	"does not replace explicit mount ID %j with the query ID",
	async (id) => {
		const transport = collector([sample("win-100-2")]);
		const listen = transport.listenResponse;
		transport.listenResponse = (receive) =>
			listen((payload) => {
				const packet = payload as {
					sample: { mounts: Array<{ paneId: unknown }> };
				};
				packet.sample.mounts[0].paneId = id;
				receive(payload);
			});
		await expect(
			resolveMountedPaneWindow(paneId, undefined, transport, 5),
		).rejects.toThrow("did not report");
	},
);

it("retains the parsed Agent query across asynchronous window discovery", async () => {
	const target = { agentId: "selected" };
	const transport: PaneWindowCollector = {
		currentWindowLabel: () => "main",
		listWindowLabels: async () => {
			target.agentId = "replacement";
			return [];
		},
		readLocal: (query) => {
			expect(query).toEqual({ agentId: "selected" });
			return {
				agentId: "selected",
				windowLabel: "main",
				windowGeneration: "boot",
				moving: false,
				mounts: [
					{
						paneId: "pane:slot",
						desktopId: "chat-space",
						dockviewId: "dock-1",
						active: true,
					},
				],
			};
		},
		listenResponse: async () => () => {},
		emitRequest: async () => {},
	};
	await expect(
		resolveMountedPaneWindow(target, undefined, transport),
	).resolves.toMatchObject({ paneId: "pane:slot" });
});
it("does not treat an unanswered live window as absent", async () => {
	await expect(
		resolveMountedPaneWindow(
			paneId,
			undefined,
			collector([sample("main"), sample("win-100-2")], true),
			5,
		),
	).rejects.toMatchObject({ code: "pane_not_found" });
});
it("refuses a pane while a move is in progress", async () => {
	await expect(
		resolveMountedPaneWindow(
			paneId,
			undefined,
			collector([{ ...sample("main"), moving: true }]),
		),
	).rejects.toMatchObject({ code: "pane_changed" });
});
it("refuses an unmounted pane without writing a hidden draft", async () => {
	await expect(
		resolveMountedPaneWindow(
			paneId,
			undefined,
			collector([{ ...sample("main"), mounts: [] }]),
		),
	).rejects.toMatchObject({ code: "pane_not_found" });
});
it("revalidates the actual window generation and mounted Dockview before writing", async () => {
	useStore.setState({
		spaces: [{ id: "chat-space", name: "Chat" }],
		activeSpaceId: "chat-space",
		layouts: {
			"chat-space": {
				panels: { [paneId]: { component: "agent", params: {} } },
			},
		},
	});
	native.mounts.mockReturnValue([
		[
			"chat-space",
			{
				id: "dock-real",
				getPanel: (id: string) => (id === paneId ? { id } : undefined),
			},
		],
	]);
	// Resolve through the production local observation, including its boot generation.
	const { getAllWebviewWindows } = await import(
		"@tauri-apps/api/webviewWindow"
	);
	vi.mocked(getAllWebviewWindows).mockResolvedValue([]);
	const actual = await resolveMountedPaneWindow(paneId, "main");
	expect(() => revalidateMountedPaneWindow(actual)).not.toThrow();
	expect(() =>
		revalidateMountedPaneWindow({
			...actual,
			windowGeneration: "old-generation",
		}),
	).toThrowError(expect.objectContaining({ code: "pane_changed" }));
	native.mounts.mockReturnValue([
		[
			"chat-space",
			{ id: "replacement-dock", getPanel: () => ({ id: paneId }) },
		],
	]);
	expect(() => revalidateMountedPaneWindow(actual)).toThrowError(
		expect.objectContaining({ code: "pane_changed" }),
	);
});

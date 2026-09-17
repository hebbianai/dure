// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpaces } from "@/components/spaces/useSpaces";
import { spaceRowDetail } from "@/lib/spaces/spaceRowDetail";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

vi.mock("@/lib/spaces/spaceRowDetail", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spaceRowDetail")>();
	return { spaceRowDetail: vi.fn(original.spaceRowDetail) };
});

const initial = useStore.getState();
const disposers: (() => void)[] = [];
const calls = () => vi.mocked(spaceRowDetail).mock.calls.length;
const params = (sessionId: string, cwd = "/repo") => ({ sessionId, cwd });
const layout = (width: number) => ({
	grid: { width, height: 800 },
	panels: {
		"term:one": { contentComponent: "terminal", params: params("one") },
		"term:two": { contentComponent: "terminal", params: params("two") },
	},
});

function seed() {
	useStore.setState({
		spaces: [
			{ id: "one", name: "One" },
			{ id: "two", name: "Two" },
		],
		activeSpaceId: "one",
		projects: [
			{ id: "repo", name: "Repo", path: "/repo", kind: "local", isRepo: true },
		],
		layouts: { one: layout(1200) },
	});
}

function mounted(): DockviewApi {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1200, 800);
	api.addPanel({
		id: "term:one",
		component: "terminal",
		params: params("one"),
	});
	api.addPanel({
		id: "term:two",
		component: "terminal",
		params: params("two"),
		position: { referencePanel: "term:one", direction: "right" },
	});
	registerDockview("one", api);
	disposers.push(() => {
		unregisterDockview("one", api);
		api.dispose();
		container.remove();
	});
	return api;
}

afterEach(() => {
	cleanup();
	for (const dispose of disposers.splice(0)) dispose();
	useStore.setState(initial, true);
	vi.clearAllMocks();
});

describe("Spaces pane layout publications", () => {
	it("follows an Agent reference change in the same slot before layout persistence", async () => {
		seed();
		const api = mounted();
		useStore.setState({
			agents: [
				agentFixture({
					id: "previous",
					projectId: "repo",
					sessionId: "previous-runtime",
				}),
				agentFixture({
					id: "current",
					projectId: "repo",
					sessionId: "current-runtime",
				}),
			],
		});
		const pane = api.addPanel({
			id: "slot",
			component: "agent",
			params: { agentRef: { agentId: "previous" } },
		});
		useStore.getState().saveLayout("one", api.toJSON());
		const hook = renderHook(() => useSpaces());
		expect(hook.result.current.find((row) => row.key === "slot")?.agentId).toBe(
			"previous",
		);
		await act(async () => {
			pane.api.updateParameters({ agentRef: { agentId: "current" } });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(hook.result.current.find((row) => row.key === "slot")).toMatchObject(
			{ agentId: "current", sessionId: "current-runtime" },
		);
		expect(api.getPanel("slot")).toBe(pane);
		await act(async () => {
			pane.api.updateParameters({ agentRef: null });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			hook.result.current.find((row) => row.key === "slot"),
		).toBeUndefined();
	});

	it("observes a Dockview registered after the Spaces subscription", async () => {
		seed();
		const hook = renderHook(() => useSpaces());
		await act(async () => {
			const api = mounted();
			api.addPanel({
				id: "term:late",
				component: "terminal",
				params: params("late"),
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(hook.result.current.map((row) => row.key).sort()).toEqual([
			"term:late",
			"term:one",
			"term:two",
		]);
	});

	it("converges after a durable move projects into the active Dockview", async () => {
		seed();
		const api = mounted();
		useStore.getState().saveLayout("one", api.toJSON());
		const hook = renderHook(() => useSpaces());
		expect(
			hook.result.current.find((row) => row.key === "term:one")?.desktopId,
		).toBe("one");
		await act(async () => {
			const receipt = await movePanelsToDesktop(
				[{ panelId: "term:one", fromDesktopId: "one" }],
				"two",
			);
			expect(receipt.movedPanelIds).toEqual(["term:one"]);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(api.getPanel("term:one")).toBeUndefined();
		expect(
			hook.result.current.find((row) => row.key === "term:one")?.desktopId,
		).toBe("two");
		expect(hook.result.current.map((row) => row.key).sort()).toEqual([
			"term:one",
			"term:two",
		]);
	});

	it("does not rederive rows for persisted geometry-only publications", () => {
		seed();
		let renders = 0;
		const hook = renderHook(() => {
			renders += 1;
			return useSpaces();
		});
		const rendersBefore = renders;
		const before = calls();
		const rows = hook.result.current;
		for (let index = 0; index < 32; index += 1) {
			act(() => useStore.getState().saveLayout("one", layout(1201 + index)));
		}
		expect(hook.result.current).toBe(rows);
		expect(calls() - before).toBe(0);
		expect(renders - rendersBefore).toBe(0);
	});

	it("does not rederive rows after real Dockview geometry publications", async () => {
		seed();
		const api = mounted();
		let renders = 0;
		const hook = renderHook(() => {
			renders += 1;
			return useSpaces();
		});
		let publications = 0;
		const subscription = api.onDidLayoutChange(() => {
			publications += 1;
			useStore.getState().saveLayout("one", api.toJSON());
		});
		disposers.unshift(() => subscription.dispose());
		await act(async () => {
			await Promise.resolve();
		});
		const before = calls();
		const rendersBefore = renders;
		const publishedBefore = publications;
		const rows = hook.result.current;
		for (let index = 0; index < 16; index += 1) {
			await act(async () => {
				api
					.getPanel("term:one")!
					.group.api.setSize({ width: 350 + index * 10 });
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}
		expect(publications - publishedBefore).toBeGreaterThan(0);
		expect(hook.result.current).toBe(rows);
		expect(calls() - before).toBe(0);
		expect(renders - rendersBefore).toBe(0);
	});

	it("reads changed live parameters on a parent render before a layout publication", () => {
		seed();
		const api = mounted();
		const hook = renderHook(() => useSpaces());
		act(() => {
			api
				.getPanel("term:one")!
				.api.updateParameters(params("replacement", "/repo/new"));
			hook.rerender();
		});
		expect(
			hook.result.current.find((row) => row.key === "term:one"),
		).toMatchObject({
			sessionId: "replacement",
			cwd: "/repo/new",
		});
	});

	it("keeps active Dockview ahead of persisted panels and converges add, rebind, remove and desktop changes", () => {
		seed();
		const api = mounted();
		const hook = renderHook(() => useSpaces());
		act(() => {
			api.addPanel({
				id: "term:live",
				component: "terminal",
				params: params("live", "/repo/live"),
			});
			useStore.getState().saveLayout("one", layout(1200));
		});
		expect(hook.result.current.map((row) => row.key)).toContain("term:live");
		act(() => {
			api
				.getPanel("term:one")!
				.api.updateParameters(params("replacement", "/repo/new"));
			useStore.getState().setSessionCwd("replacement", "/repo/latest");
			useStore.getState().saveLayout("one", api.toJSON());
		});
		expect(
			hook.result.current.find((row) => row.key === "term:one"),
		).toMatchObject({ sessionId: "replacement", cwd: "/repo/latest" });
		act(() => {
			api.getPanel("term:two")!.api.close();
			useStore.getState().saveLayout("one", api.toJSON());
			useStore.getState().saveLayout("two", {
				panels: {
					"term:other": {
						contentComponent: "terminal",
						params: params("other"),
					},
				},
			});
		});
		expect(hook.result.current.map((row) => row.key)).not.toContain("term:two");
		expect(
			hook.result.current.find((row) => row.key === "term:other")?.desktopId,
		).toBe("two");
		act(() => useStore.getState().setActiveSpace("two"));
		expect(hook.result.current.map((row) => row.key)).toEqual([
			"term:one",
			"term:live",
			"term:other",
		]);
	});
});

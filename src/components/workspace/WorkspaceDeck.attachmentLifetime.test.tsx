// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createDockview } from "dockview-react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	getDockview,
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { DEFAULT_TERMINAL_MODEL_BYTES } from "@/lib/workspace/performance/terminalResourceBudget";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { useStore } from "@/store";
import { WorkspaceDeck } from "./WorkspaceDeck";

const fixture = vi.hoisted(() => ({
	counts: { active: 11, neighbor: 9 } as Record<string, number>,
	prefix: "",
	component: "terminal",
	neighborLayout: "split" as "split" | "stacked" | "hidden",
	attachmentsPending: false,
	starts: {} as Record<string, number>,
	measure: undefined as (() => void) | undefined,
	queue: [] as Array<{ run: () => void; cancelled: boolean }>,
}));

vi.mock("@/lib/workspace/performance/workspaceHardwareProfile", () => ({
	readSystemHardwareProfile: async () => ({
		logicalCores: 16,
		physicalMemoryBytes: 48 * 1024 ** 3,
	}),
	mergeWorkspaceHardwareProfiles: (browser: object, native: object) => ({
		...browser,
		...native,
	}),
}));

vi.mock(
	"@/lib/workspace/performance/tierReconcileScheduler",
	async (original) => {
		const actual =
			await original<
				typeof import("@/lib/workspace/performance/tierReconcileScheduler")
			>();
		return {
			...actual,
			TierReconcileScheduler: class extends actual.TierReconcileScheduler {
				constructor(
					run: ConstructorParameters<typeof actual.TierReconcileScheduler>[0],
				) {
					super(run, (run) => {
						const unit = { run, cancelled: false };
						fixture.queue.push(unit);
						return () => {
							unit.cancelled = true;
						};
					});
				}
			},
		};
	},
);

vi.mock("@/components/workspace/Workspace", () => ({
	Workspace: ({
		desktopId,
		frozen,
	}: {
		desktopId: string;
		frozen: boolean;
	}) => {
		useLayoutEffect(() => {
			const host = document.createElement("div");
			document.body.append(host);
			const api = createDockview(host, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			api.layout(1200, 800);
			for (let index = 0; index < fixture.counts[desktopId]; index++) {
				const stacked =
					desktopId === "neighbor" &&
					fixture.neighborLayout === "stacked" &&
					index > 0;
				api.addPanel({
					id: `${fixture.prefix}${desktopId}-${index}`,
					component: fixture.component,
					position: stacked
						? {
								referencePanel: `${fixture.prefix}${desktopId}-0`,
								direction: "within",
							}
						: { direction: "right" },
				});
			}
			if (desktopId === "neighbor" && fixture.neighborLayout === "hidden") {
				for (const panel of api.panels.slice(1))
					panel.group.api.setVisible(false);
			}
			registerDockview(desktopId, api);
			const unmount = workspacePerformance.mountWorkspace(desktopId);
			return () => {
				unmount();
				unregisterDockview(desktopId, api);
				api.dispose();
				host.remove();
			};
		}, [desktopId]);
		useLayoutEffect(() => {
			if (frozen) return;
			fixture.starts[desktopId] = (fixture.starts[desktopId] ?? 0) + 1;
			if (fixture.attachmentsPending) return;
			const surfaces =
				getDockview(desktopId)
					?.panels.filter((panel) => panel.api.isVisible)
					.map((panel) =>
						workspacePerformance.registerTerminal({
							id: panel.id,
							desktopId,
							runtime: "hmux",
							renderer: "dom",
							modelBytes: DEFAULT_TERMINAL_MODEL_BYTES,
							gpuViewportBytes: 0,
							visible: true,
						}),
					) ?? [];
			if (desktopId === "active")
				fixture.measure = () =>
					surfaces[0].updateModelBytes(DEFAULT_TERMINAL_MODEL_BYTES + 1);
			return () => {
				for (const surface of surfaces) surface.dispose();
			};
		}, [desktopId, frozen]);
		return <div data-testid={desktopId} data-frozen={String(frozen)} />;
	},
}));

beforeEach(() => {
	fixture.counts = { active: 11, neighbor: 9 };
	fixture.prefix = "";
	fixture.component = "terminal";
	fixture.neighborLayout = "split";
	fixture.attachmentsPending = false;
});

afterEach(() => {
	cleanup();
	fixture.queue.length = 0;
	fixture.starts = {};
	fixture.measure = undefined;
});

function openDeck() {
	const spaces = Object.keys(fixture.counts).map((id) => ({ id, name: id }));
	useStore.setState({
		spaces,
		activeSpaceId: "active",
		layouts: Object.fromEntries(
			spaces.map(({ id }) => [
				id,
				{
					panels: Object.fromEntries(
						Array.from({ length: fixture.counts[id] }, (_, i) => [
							`${fixture.prefix}${id}-${i}`,
							{ contentComponent: fixture.component },
						]),
					),
				},
			]),
		),
	});
	const view = render(<WorkspaceDeck spaces={spaces} activeSpaceId="active" />);
	return { ...view, spaces };
}

async function reconcileFrames() {
	await act(async () => {
		await Promise.resolve();
	});
	for (let frame = 0; frame < 12; frame++) {
		await act(async () => {
			const batch = fixture.queue.splice(0);
			for (const unit of batch) if (!unit.cancelled) unit.run();
		});
		// One ordinary model measurement starts reconciliation; subsequent
		// work must settle without attachment release/recreation driving itself.
		if (frame === 0)
			await act(async () => {
				fixture.measure?.();
			});
	}
}

it.each([
	{ prefix: "term:", component: "terminal" },
	{ prefix: "agent:", component: "agent" },
	{ prefix: "", component: "terminal" },
])(
	"does not repeatedly thaw a frozen $component desktop when its attachments are released (prefix '$prefix')",
	async ({ prefix, component }) => {
		fixture.prefix = prefix;
		fixture.component = component;
		openDeck();
		await reconcileFrames();
		expect.soft(fixture.starts.neighbor ?? 0).toBe(0);
		expect(screen.getByTestId("neighbor").dataset.frozen).toBe("true");
		expect(
			getDockview("neighbor")?.panels.filter(
				(p) => p.api.isVisible && p.api.component === component,
			),
		).toHaveLength(9);
		expect(fixture.starts.active).toBe(1);
		expect(fixture.queue.filter((unit) => !unit.cancelled)).toHaveLength(0);
	},
);

it("keeps both desktops warm when their activation costs fit", async () => {
	fixture.counts.neighbor = 3;
	openDeck();
	await reconcileFrames();
	expect(screen.getByTestId("neighbor").dataset.frozen).toBe("false");
	expect(fixture.starts).toEqual({ active: 1, neighbor: 1 });
});

it.each(["hidden", "stacked"] as const)(
	"does not charge %s terminal panes as visible renderers",
	async (layout) => {
		fixture.neighborLayout = layout;
		openDeck();
		await reconcileFrames();
		expect(
			getDockview("neighbor")?.panels.filter((panel) => panel.api.isVisible),
		).toHaveLength(1);
		expect(screen.getByTestId("neighbor").dataset.frozen).toBe("false");
		expect(fixture.starts).toEqual({ active: 1, neighbor: 1 });
	},
);

it("prices pending attachments before they register a renderer", async () => {
	fixture.attachmentsPending = true;
	openDeck();
	await reconcileFrames();
	expect(screen.getByTestId("neighbor").dataset.frozen).toBe("true");
	expect(fixture.starts).toEqual({ active: 1 });
});

it("thaws only the requested desktop and retains the same Dockview shells on a round trip", async () => {
	const view = openDeck();
	await reconcileFrames();
	const activeDockview = getDockview("active");
	const neighborDockview = getDockview("neighbor");
	for (const activeSpaceId of ["neighbor", "active"]) {
		act(() => {
			useStore.setState({ activeSpaceId });
			view.rerender(
				<WorkspaceDeck spaces={view.spaces} activeSpaceId={activeSpaceId} />,
			);
		});
		await reconcileFrames();
		expect(screen.getByTestId(activeSpaceId).dataset.frozen).toBe("false");
	}
	expect(getDockview("active")).toBe(activeDockview);
	expect(getDockview("neighbor")).toBe(neighborDockview);
	expect(fixture.starts).toEqual({ active: 2, neighbor: 1 });
	expect(screen.getByTestId("neighbor").dataset.frozen).toBe("true");
});

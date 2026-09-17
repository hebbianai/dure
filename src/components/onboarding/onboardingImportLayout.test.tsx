// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OnboardingImportLayoutPreview } from "@/components/onboarding/OnboardingImportLayoutPreview";
import {
	buildOnboardingImportDraft,
	type OnboardingImportProjection,
} from "@/lib/onboarding/onboardingImportDraft";
import { serializeOnboardingImportLayout } from "@/lib/onboarding/onboardingImportLayout";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

function draft(count: number) {
	const projection: OnboardingImportProjection = {
		total: count,
		groups: [
			{
				id: "repo:dure",
				name: "HebbianIDE",
				cwd: "/repo",
				items: Array.from({ length: count }, (_, index) => ({
					key: `codex:${index}`,
					conversationId: `conversation-${index}`,
					title: `Session ${index}`,
					mtime: 100 - index,
					provider: "codex" as const,
					cwd: "/repo",
					workspaceRoot: "/repo",
					groupIdentity: "repo:dure",
					defaultSelected: true,
					executionLocation: "local" as const,
				})),
			},
		],
	};
	return buildOnboardingImportDraft(projection).desktops[0];
}

function agent(index: number): Agent {
	const id = `agent-${index}`;
	return managedAgentFixture({
		id,
		name: `Session ${index}`,
		worktreePath: "/repo",
		branch: "",
		sessionId: id,
		runtimeBinding: managedBindingFixture({
			sessionId: id,
			workspaceId: "project-1",
			createIdempotencyKey: id,
		}),
		conversationId: `conversation-${index}`,
	});
}

function dataTransfer() {
	const values = new Map<string, string>();
	return {
		effectAllowed: "none",
		dropEffect: "none",
		types: [] as string[],
		setData(type: string, value: string) {
			values.set(type, value);
			if (!this.types.includes(type)) this.types.push(type);
		},
		getData(type: string) {
			return values.get(type) ?? "";
		},
		setDragImage: vi.fn(),
	};
}

describe("serializeOnboardingImportLayout", () => {
	it.each([1, 3, 7, 10])(
		"restores %i exact view IDs and explicit Agent references, including overflow tabs",
		(count) => {
			const desktop = draft(1);
			desktop.panes = Array.from({ length: count }, (_, index) => ({
				...desktop.panes[0],
				key: `codex:${index}`,
				conversationId: `conversation-${index}`,
			}));
			const panes = desktop.panes.map((pane, index) => ({
				paneKey: pane.key,
				paneId:
					index % 2 ? `agent:historical-slot-${index}` : `pane-slot-${index}`,
				agent: agent(index),
			}));
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
					dispose() {},
				}),
			});
			try {
				api.layout(1200, 800);
				api.fromJSON(serializeOnboardingImportLayout(desktop, panes) as never);
				expect(api.panels.map((pane) => pane.id).sort()).toEqual(
					panes.map((pane) => pane.paneId).sort(),
				);
				for (const expected of panes) {
					const actual = api.getPanel(expected.paneId);
					expect(actual?.params).toEqual({
						agentRef: { agentId: expected.agent.id },
					});
					expect(
						actual &&
							agentIdFromPane({
								id: actual.id,
								component: actual.api.component,
								params: actual.params,
							}),
					).toBe(expected.agent.id);
				}
				const saved = api.toJSON();
				api.fromJSON(saved);
				expect(api.toJSON()).toEqual(saved);
			} finally {
				api.dispose();
				container.remove();
			}
		},
	);

	it("uses the schematic as a drag and keyboard pane editor", () => {
		const desktop = draft(3);
		const onDragStart = vi.fn();
		const onDropTargetChange = vi.fn();
		const onMovePane = vi.fn();
		const onNudgePane = vi.fn();
		const preview = render(
			<OnboardingImportLayoutPreview
				desktop={desktop}
				canReorderOrMove
				onDragStart={onDragStart}
				onDropTargetChange={onDropTargetChange}
				onMovePane={onMovePane}
				onNudgePane={onNudgePane}
			/>,
		);
		const cells =
			preview.container.querySelectorAll<HTMLElement>("[data-layout-cell]");
		const transfer = dataTransfer();

		expect(cells).toHaveLength(3);
		fireEvent.keyDown(cells[1], { key: "ArrowLeft" });
		expect(onNudgePane).toHaveBeenCalledWith(desktop.panes[1].key, "previous");

		fireEvent.dragStart(cells[0], { dataTransfer: transfer });
		expect(onDragStart).toHaveBeenCalledWith({
			schemaVersion: 1,
			paneKey: desktop.panes[0].key,
			fromDesktopId: desktop.id,
		});
		fireEvent.dragOver(cells[2], { dataTransfer: transfer });
		expect(onDropTargetChange).toHaveBeenCalledWith(desktop.panes[2].key);
		fireEvent.drop(cells[2], { dataTransfer: transfer });
		expect(onMovePane).toHaveBeenCalledWith(
			{
				schemaVersion: 1,
				paneKey: desktop.panes[0].key,
				fromDesktopId: desktop.id,
			},
			desktop.panes[2].key,
		);
	});

	it("empties the lifted card's own slot while it is being dragged", () => {
		const desktop = draft(3);
		const dragged = desktop.panes[1];
		const preview = render(
			<OnboardingImportLayoutPreview
				desktop={desktop}
				canReorderOrMove
				draggedPaneKey={dragged.key}
			/>,
		);
		const cells =
			preview.container.querySelectorAll<HTMLElement>("[data-layout-cell]");

		// 자리는 그대로 두고 내용만 비운다 — 어디로 되돌아갈지 보여야 한다.
		expect(cells).toHaveLength(3);
		const lifted = preview.container.querySelector<HTMLElement>(
			`[data-layout-pane-key="${dragged.key}"]`,
		);
		expect(lifted?.textContent).toBe("2");
		expect(lifted?.textContent).not.toContain(dragged.title);
		// 나머지 카드는 그대로 보인다.
		const others = Array.from(cells).filter((cell) => cell !== lifted);
		expect(others.map((cell) => cell.textContent)).toEqual([
			expect.stringContaining(desktop.panes[0].title),
			expect.stringContaining(desktop.panes[2].title),
		]);
		preview.unmount();
	});

	it("loads one managed pane as one Dockview group", () => {
		const desktop = draft(1);
		const layout = serializeOnboardingImportLayout(desktop, [
			{ paneKey: desktop.panes[0].key, paneId: "pane-one", agent: agent(0) },
		]);
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(1200, 800);

		expect(() => api.fromJSON(layout as never)).not.toThrow();
		expect(api.groups).toHaveLength(1);
		expect(api.panels).toHaveLength(1);
		api.dispose();
		container.remove();
	});

	it("loads three managed panes as three equal horizontal groups", () => {
		const desktop = draft(3);
		const layout = serializeOnboardingImportLayout(
			desktop,
			desktop.panes.map((pane, index) => ({
				paneKey: pane.key,
				paneId: `pane-${index}`,
				agent: agent(index),
			})),
		) as {
			grid: { root: { type: string; data: Array<{ size: number }> } };
			panels: Record<string, unknown>;
		};

		expect(layout.grid.root.type).toBe("branch");
		expect(layout.grid.root.data.map((column) => column.size)).toEqual([
			400, 400, 400,
		]);

		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(1200, 800);
		expect(() => api.fromJSON(layout as never)).not.toThrow();
		expect(api.groups).toHaveLength(3);
		expect(api.panels).toHaveLength(3);
		api.dispose();
		container.remove();
	});

	it("fills the final column in a seven-pane preview and Dockview layout", () => {
		const desktop = draft(7);
		const preview = render(<OnboardingImportLayoutPreview desktop={desktop} />);
		const previewCells =
			preview.container.querySelectorAll<HTMLElement>("[data-layout-cell]");
		expect(previewCells).toHaveLength(7);
		expect(previewCells[6].style.gridColumn).toBe("4 / span 1");
		expect(previewCells[6].style.gridRow).toBe("1 / span 2");
		preview.unmount();

		const layout = serializeOnboardingImportLayout(
			desktop,
			desktop.panes.map((pane, index) => ({
				paneKey: pane.key,
				paneId: `pane-${index}`,
				agent: agent(index),
			})),
		) as {
			grid: {
				orientation: string;
				root: {
					type: string;
					data: Array<{
						type: string;
						size: number;
						data: Array<{ size: number }>;
					}>;
				};
			};
		};

		expect(layout.grid.orientation).toBe("HORIZONTAL");
		expect(layout.grid.root.data).toMatchObject([
			{ type: "branch", size: 300, data: [{ size: 400 }, { size: 400 }] },
			{ type: "branch", size: 300, data: [{ size: 400 }, { size: 400 }] },
			{ type: "branch", size: 300, data: [{ size: 400 }, { size: 400 }] },
			{ type: "leaf", size: 300 },
		]);

		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(1200, 800);
		expect(() => api.fromJSON(layout as never)).not.toThrow();
		expect(api.groups).toHaveLength(7);
		expect(api.panels).toHaveLength(7);
		api.dispose();
		container.remove();
	});
});

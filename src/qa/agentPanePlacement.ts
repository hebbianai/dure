import { createDockview } from "dockview-react";
import { qaLog } from "@/lib/qa/qaLog";
import { registerDockview } from "@/lib/workspace/dock/dockRegistry";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import "dockview-react/dist/styles/dockview.css";
import "@/index.css";

export function runAgentPanePlacementFixture(
	root: HTMLElement,
	proof: string,
): void {
	root.style.height = "100vh";
	root.style.width = "100vw";
	// Production placement and real Dockview, with disposable content and no PTYs.
	const desktopId = `agent-placement-${proof}`;
	root.className = "dockview-theme-abyss";
	const api = createDockview(root, {
		createComponent: () => {
			const element = document.createElement("textarea");
			element.className =
				"size-full resize-none bg-surface-pane p-6 font-mono text-sm text-text-primary outline-none";
			element.setAttribute("aria-label", "Agent working draft");
			element.value =
				"Inspect the current implementation and its callers.\n\nRun the focused regression checks and preserve existing work.\n\nReady for the next task.";
			return { element, init() {} };
		},
	});
	registerDockview(desktopId, api);
	api.layout(root.clientWidth, root.clientHeight);
	const observer = new ResizeObserver(() =>
		api.layout(root.clientWidth, root.clientHeight),
	);
	observer.observe(root);
	const add = (id: string, preferredPanelId?: string) => {
		const panelId = openAgentPanelOnDockview({
			api,
			desktopId,
			agent: agentFixture({ id, name: id }),
			preferredPanelId,
		});
		if (!panelId) throw new Error(`Failed to open ${id}`);
		return api.getPanel(panelId)!;
	};
	const parent = add("Lead agent");
	const firstElement = parent.view.content.element;
	const draft = firstElement as HTMLTextAreaElement;
	draft.value =
		"Keep this working draft while child agents are added.\n\nReview progress and collect the final results.";
	const parentWidth = api.width / 2;
	const parentHeight = api.height / 2;
	add("Research agent");
	const child = add("Implementation agent", parent.id);
	const nearby =
		Math.abs(parent.group.api.height - parentHeight) <= 1 &&
		Math.abs(child.group.api.height - parentHeight) <= 1;
	add("Review agent", parent.id);

	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			const groups = api.groups.map((group) => ({
				width: group.api.width,
				height: group.api.height,
				panels: group.panels.length,
				visible: group.api.isVisible,
			}));
			const identityPreserved =
				api.getPanel(parent.id) === parent &&
				parent.view.content.element === firstElement &&
				draft.value.startsWith("Keep this working draft");
			const saved = useStore.getState().layouts[desktopId] as ReturnType<
				typeof api.toJSON
			>;
			const persisted =
				JSON.stringify(saved.grid) === JSON.stringify(api.toJSON().grid);
			const passed =
				nearby &&
				identityPreserved &&
				persisted &&
				groups.length === 4 &&
				groups.every(
					(group) =>
						group.panels === 1 &&
						group.visible &&
						Math.abs(group.width - parentWidth) <= 1 &&
						Math.abs(group.height - parentHeight) <= 1,
				);
			const receipt = {
				proof,
				passed,
				nearby,
				identityPreserved,
				persisted,
				groups,
				userAgent: navigator.userAgent,
			};
			Object.assign(window, { __AGENT_PLACEMENT_FIXTURE__: { api, receipt } });
			qaLog("agent-pane-placement", receipt);
		}),
	);
}

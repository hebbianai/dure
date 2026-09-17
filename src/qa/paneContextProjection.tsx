import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Workspace } from "@/components/workspace/Workspace";
import { resolveQuickDispatchProject } from "@/lib/agents/quickDispatch/quickDispatchDefaults";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { hidePaneWithRecord } from "@/lib/workspace/pane/paneHideActions";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

async function observe(description: string, matches: () => boolean) {
	const deadline = performance.now() + 3_000;
	while (!matches()) {
		if (performance.now() >= deadline) {
			const headers = [...document.querySelectorAll("[data-pane-title]")].map(
				(node) => node.textContent,
			);
			throw new Error(
				`Pane context: ${description}; ${JSON.stringify({ context: useStore.getState().focusCtx, headers })}`,
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
}

/** Shared real Workspace/header journey for Vitest and an isolated WebView.
 * These retired-legacy Agent fixtures have no runtime binding: no process or
 * conversation is created, resumed or stopped by mounting their views. */
export async function probePaneContextProjection(panelId: string) {
	const previous = useStore.getState();
	const previousHidden = useHiddenPanes.getState().hidden;
	const container = document.createElement("div");
	container.style.cssText =
		"position:fixed;width:1000px;height:650px;visibility:hidden";
	document.body.append(container);
	const root = createRoot(container);
	const desktopId = "qa-current-pane-context";
	const first = agentFixture({
		id: "qa-current",
		displayName: "First QA target",
		projectId: "qa-first-project",
		worktreePath: "/outside",
		started: true,
	});
	const second = agentFixture({
		id: "qa-second",
		displayName: "Second QA target",
		projectId: "qa-second-project",
		worktreePath: "/outside",
		started: true,
	});
	try {
		useHiddenPanes.setState({ hidden: {} });
		useStore.setState({
			agents: [first, second],
			projects: [],
			spaces: [{ id: desktopId, name: "QA pane context" }],
			// A persisted empty workspace does not launch the first-use shell.
			// The probe adds its Agent view below without creating any runtime.
			layouts: {
				[desktopId]: {
					grid: {
						root: { type: "branch", data: [], size: 650 },
						width: 1000,
						height: 650,
						orientation: "HORIZONTAL",
					},
					panels: {},
				},
			},
			activeSpaceId: desktopId,
			focusCtx: null,
			sessionCwd: {},
			uiPrefs: { ...previous.uiPrefs, onboardingDismissed: true },
		});
		flushSync(() => root.render(<Workspace desktopId={desktopId} active />));
		const api = getDockview(desktopId);
		if (!api) throw new Error("Pane context: Workspace did not mount");
		api.layout(1000, 650);
		api.addPanel({
			id: panelId,
			component: "launcher",
		});
		const launcher = api.getPanel(panelId)!;
		const position = { replacement: launcher.api };
		const openedId = openAgentPanelOnDockview({
			desktopId,
			api,
			agent: first,
			position,
		});
		if (
			openedId !== panelId ||
			api.panels.length !== 1 ||
			api.getPanel(panelId) === launcher
		)
			throw new Error(
				"Pane context: launcher completion changed the pane identity",
			);
		const panel = api.getPanel(panelId)!;
		const title = () =>
			panel.group.element.querySelector("[data-pane-title]")?.textContent;
		const target = () => useStore.getState().focusCtx?.agentId;
		await observe(
			"initial target/header did not converge",
			() => target() === first.id && title() === first.displayName,
		);
		openAgentPanelOnDockview({ desktopId, api, agent: first, position });
		if (api.getPanel(panelId) !== panel || api.panels.length !== 1)
			throw new Error(
				"Pane context: completion replay replaced the current content",
			);
		panel.api.updateParameters({ agentRef: { agentId: second.id } });
		await observe(
			"same-pane target/header did not converge",
			() => target() === second.id && title() === second.displayName,
		);
		const project = resolveQuickDispatchProject({
			focusCtx: useStore.getState().focusCtx,
			agents: [first, second],
			projects: [first, second].map((agent) => ({
				id: agent.projectId,
				name: agent.projectId,
				path: `/${agent.projectId}`,
				kind: "local",
				isRepo: true,
			})),
		});
		if (project?.id !== second.projectId)
			throw new Error(
				"Pane context: Quick Dispatch selected a historical target",
			);
		panel.api.updateParameters({ agentRef: null });
		await observe(
			"invalid reference retained the previous target",
			() =>
				useStore.getState().focusCtx === null && title() !== second.displayName,
		);
		panel.api.updateParameters({ agentRef: { agentId: first.id } });
		panel.api.updateParameters({ agentRef: { agentId: second.id } });
		await observe(
			"rapid retarget restored an older context",
			() => target() === second.id && title() === second.displayName,
		);
		if (
			api.getPanel(panelId) !== panel ||
			api.activePanel !== panel ||
			useStore.getState().agents[0] !== first ||
			useStore.getState().agents[1] !== second
		) {
			throw new Error(
				"Pane context: projection changed the pane or Agent owner",
			);
		}
		api.addFloatingGroup(panel, { x: 70, y: 80, width: 400, height: 300 });
		hidePaneWithRecord({ desktopId, panelId, agentId: second.id });
		const hidden = useHiddenPanes.getState().hidden[second.id];
		if (
			api.getPanel(panelId) ||
			hidden?.paneId !== panelId ||
			!hidden.anchor ||
			!("floating" in hidden.anchor)
		)
			throw new Error(
				"Pane context: floating hide lost its pane identity or anchor",
			);
		openAgentPanelOnDockview({ desktopId, api, agent: second });
		await observe(
			"hidden pane did not restore its current target",
			() =>
				api.getPanel(panelId)?.group.api.location.type === "floating" &&
				api.activePanel?.id === panelId &&
				target() === second.id &&
				!useHiddenPanes.getState().hidden[second.id],
		);
		const overlay = api
			.getPanel(panelId)
			?.group.element.closest(".dv-resize-container");
		const bounds = hidden.anchor.floating;
		if (
			!(overlay instanceof HTMLElement) ||
			Number.parseFloat(overlay.style.left) !== bounds.x ||
			Number.parseFloat(overlay.style.top) !== bounds.y ||
			Number.parseFloat(overlay.style.width) !== bounds.width ||
			Number.parseFloat(overlay.style.height) !== bounds.height
		)
			throw new Error("Pane context: restore changed the floating anchor");
		if (api.panels.length !== 1 || useStore.getState().agents[1] !== second)
			throw new Error(
				"Pane context: restore duplicated the pane or changed its Agent",
			);
		return {
			panelId,
			contentReplaced: true,
			retargeted: true,
			invalidated: true,
			preserved: true,
			projectId: project.id,
			hiddenRestored: true,
		};
	} finally {
		flushSync(() => root.unmount());
		container.remove();
		useStore.setState(previous, true);
		useHiddenPanes.setState({ hidden: previousHidden });
	}
}

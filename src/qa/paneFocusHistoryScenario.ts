import { createDockview, type IDockviewPanelProps } from "dockview-react";
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useStructuredTerminalPaneFocus } from "@/components/terminal/structured/useStructuredTerminalPaneFocus";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { recordPaneFocus } from "@/lib/workspace/pane/paneFocusHistory";
import { installPaneShortcuts } from "@/lib/workspace/pane/paneShortcuts";
import { useStore } from "@/store";

function PaneInput({ paneApi }: { paneApi: IDockviewPanelProps["api"] }) {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	useStructuredTerminalPaneFocus({
		paneApi,
		inputRef,
		inputReady: true,
		surfaceId: paneApi.id,
	});
	return createElement("textarea", {
		ref: inputRef,
		"aria-label": "QA pane focus target",
		style: { width: "100%", height: "100%", resize: "none" },
	});
}

const SPACE = "qa-pane-focus-history";
const PANES = ["qa:first", "qa:second", "qa:third"] as const;
type Pane = (typeof PANES)[number];

export type PaneWindowActivation = (
	requestFocus: () => void,
	input: HTMLTextAreaElement,
) => Promise<void>;

export interface PaneFocusObservation {
	step: string;
	panel: string | undefined;
	focusInsidePane: boolean;
	consumed: boolean | null;
}

/** The native and runtime-free checks run this exact DOM/Dockview journey. */
export async function runPaneFocusHistoryScenario(
	container: HTMLElement,
	checkpoint: () => Promise<void>,
	activateWindow?: PaneWindowActivation,
): Promise<PaneFocusObservation[]> {
	const previous = useStore.getState();
	const observations: PaneFocusObservation[] = [];
	const api = createDockview(container, {
		createComponent: () => {
			const element = document.createElement("textarea");
			element.readOnly = true;
			element.setAttribute("aria-label", "QA pane focus target");
			element.style.cssText = "width:100%;height:100%;resize:none";
			return { element, init() {}, dispose() {} };
		},
	});
	let stopShortcuts = () => {};
	let stopHistory = () => {};
	try {
		api.layout(900, 600);
		api.addPanel({ id: PANES[0], component: "qa", title: "First" });
		api.addPanel({
			id: PANES[1],
			component: "qa",
			title: "Second",
			position: { referencePanel: PANES[0], direction: "right" },
		});
		api.addPanel({
			id: PANES[2],
			component: "qa",
			title: "Third",
			position: { referencePanel: PANES[0], direction: "below" },
		});
		useStore.setState({ activeSpaceId: SPACE, shortcutOverrides: {} });
		registerDockview(SPACE, api);
		// Begin after construction, so restored layout order is not visit history.
		api.getPanel(PANES[0])?.group.element.querySelector("textarea")?.focus();
		const subscription = api.onDidActivePanelChange(() =>
			recordPaneFocus(api, api.activePanel?.id),
		);
		stopHistory = () => subscription.dispose();
		stopShortcuts = installPaneShortcuts(SPACE);
		await checkpoint();

		const observe = (
			step: string,
			expected: Pane,
			consumed: boolean | null,
		) => {
			const panel = api.activePanel;
			const observation = {
				step,
				panel: panel?.id,
				focusInsidePane:
					panel?.group.element.contains(document.activeElement) === true,
				consumed,
			};
			observations.push(observation);
			if (observation.panel !== expected || !observation.focusInsidePane) {
				throw new Error(
					`${step}: expected focused ${expected}; ${JSON.stringify(observation)}`,
				);
			}
		};
		const visit = async (pane: Pane, step: string) => {
			const input = api.getPanel(pane)?.group.element.querySelector("textarea");
			if (!input) throw new Error(`missing focus target ${pane}`);
			// Native DOM focus must drive Dockview activation; do not setActive here.
			input.focus();
			await checkpoint();
			observe(step, pane, null);
		};
		const bracket = async (
			key: "[" | "]",
			expected: Pane,
			consumed: boolean,
			step: string,
		) => {
			const event = new KeyboardEvent("keydown", {
				key,
				code: key === "[" ? "BracketLeft" : "BracketRight",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			const target = document.activeElement;
			if (!target || !container.contains(target))
				throw new Error(`${step}: focus escaped fixture`);
			target.dispatchEvent(event);
			await checkpoint();
			observe(step, expected, event.defaultPrevented);
			if (event.defaultPrevented !== consumed)
				throw new Error(`${step}: incorrect shortcut consumption`);
		};

		await visit(PANES[0], "initial");
		await bracket("[", PANES[0], false, "back at beginning");
		await bracket("]", PANES[0], false, "forward without history");
		// This differs from panel insertion order (first, second, third).
		await visit(PANES[2], "visit third");
		await visit(PANES[1], "visit second");
		await bracket("]", PANES[1], false, "forward at end");
		await bracket("[", PANES[2], true, "back follows visit order");
		await bracket("[", PANES[0], true, "back to first");
		await bracket("[", PANES[0], false, "back does not wrap");
		await bracket("]", PANES[2], true, "forward to third");
		await bracket("]", PANES[1], true, "forward to second");
		await bracket("[", PANES[2], true, "back before new visit");
		await visit(PANES[0], "new visit discards forward branch");
		await bracket("]", PANES[0], false, "discarded forward is unavailable");
		await bracket("[", PANES[2], true, "new branch preserves back history");
		await bracket("]", PANES[0], true, "new branch forwards to first");
		stopShortcuts();
		observations.push(
			...(await runDirectionalInputScenario(
				container,
				checkpoint,
				activateWindow,
			)),
		);
		return observations;
	} finally {
		stopShortcuts();
		stopHistory();
		unregisterDockview(SPACE, api);
		api.dispose();
		useStore.setState({
			activeSpaceId: previous.activeSpaceId,
			shortcutOverrides: previous.shortcutOverrides,
		});
	}
}

/** Directional input uses the production terminal focus owner, independently
 * of the retained history journey's simple read-only pane targets. */
async function runDirectionalInputScenario(
	parent: HTMLElement,
	checkpoint: () => Promise<void>,
	activateWindow?: PaneWindowActivation,
): Promise<PaneFocusObservation[]> {
	const container = document.createElement("div");
	container.style.cssText =
		"position:absolute;inset:0;width:900px;height:600px";
	parent.append(container);
	const desktopId = "qa-pane-directional-input";
	const previous = useStore.getState();
	const observations: PaneFocusObservation[] = [];
	const api = createDockview(container, {
		createComponent: () => {
			const element = document.createElement("div");
			const root = createRoot(element);
			return {
				element,
				init(parameters) {
					flushSync(() =>
						root.render(createElement(PaneInput, { paneApi: parameters.api })),
					);
				},
				dispose() {
					root.unmount();
				},
			};
		},
	});
	let stop = () => {};
	try {
		api.layout(900, 600);
		const first = api.addPanel({
			id: "direction:first",
			component: "qa",
			title: "First",
		});
		const right = api.addPanel({
			id: "direction:right",
			component: "qa",
			title: "Second",
			position: { referencePanel: first, direction: "right" },
		});
		const below = api.addPanel({
			id: "direction:below",
			component: "qa",
			title: "Third",
			position: { referencePanel: first, direction: "below" },
		});
		useStore.setState({ activeSpaceId: desktopId, shortcutOverrides: {} });
		registerDockview(desktopId, api);
		stop = installPaneShortcuts(desktopId);
		first.api.setActive();
		first.group.element.querySelector("textarea")?.focus();
		for (const [key, expected] of [
			["ArrowRight", right],
			["ArrowLeft", first],
			["ArrowDown", below],
			["ArrowUp", first],
		] as const) {
			const event = new KeyboardEvent("keydown", {
				key,
				code: key,
				metaKey: true,
				altKey: true,
				bubbles: true,
				cancelable: true,
			});
			document.activeElement?.dispatchEvent(event);
			const observation = {
				step: `immediate ${key}`,
				panel: api.activePanel?.id,
				focusInsidePane:
					expected.group.element.querySelector("textarea") ===
					document.activeElement,
				consumed: event.defaultPrevented,
			};
			observations.push(observation);
			// No task/frame wait before checking the next character's receiver.
			if (
				observation.panel !== expected.id ||
				!observation.focusInsidePane ||
				!observation.consumed
			) {
				throw new Error(
					`${key}: input focus was not transferred synchronously: ${JSON.stringify(observation)}`,
				);
			}
			await checkpoint();
		}
		if (activateWindow) {
			const input = right.group.element.querySelector("textarea");
			if (!input) throw new Error("missing activation input target");
			await activateWindow(() => {
				right.api.setActive();
				api.focus();
			}, input);
			const focusInsidePane = document.activeElement === input;
			if (!focusInsidePane)
				throw new Error("window activation lost pane input focus");
			observations.push({
				step: "single window activation and native first input",
				panel: api.activePanel?.id,
				focusInsidePane,
				consumed: null,
			});
			await checkpoint();
		}
		return observations;
	} finally {
		stop();
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
		useStore.setState({
			activeSpaceId: previous.activeSpaceId,
			shortcutOverrides: previous.shortcutOverrides,
		});
	}
}

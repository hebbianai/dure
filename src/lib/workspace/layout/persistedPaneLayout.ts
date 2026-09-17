import {
	type AgentPaneParameters,
	agentIdFromAgentPanelId,
	agentIdFromPaneParameters,
} from "./agentPaneParameters";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

/** Read current content at the layout boundary, never from an identity's spelling. */
export function paneContentComponent(value: unknown): string | undefined {
	const panel = record(value);
	return typeof panel?.contentComponent === "string"
		? panel.contentComponent
		: typeof panel?.component === "string"
			? panel.component
			: undefined;
}

/** Dockview's serialized `panels` entry names its view `contentComponent`;
 * `addPanel` options spell the same thing `component`. An entry written with
 * the latter deserializes as the "unknown" component, and `fromJSON` then
 * clears every pane of the Space. The normal form therefore never carries
 * `component`: it becomes `contentComponent` in place when that key is
 * missing, and is dropped otherwise. */
function serializedPanel(panel: UnknownRecord): UnknownRecord {
	if (!("component" in panel)) return panel;
	const rename =
		typeof panel.contentComponent !== "string" &&
		typeof panel.component === "string";
	return Object.fromEntries(
		Object.entries(panel).flatMap(([key, value]) => {
			if (key !== "component") return [[key, value]];
			return rename ? [["contentComponent", value]] : [];
		}),
	);
}

/** Decode one saved definition before its references enter a projection.
 * Mounted pane readers never perform this historical interpretation. */
export function normalizePersistedPaneDefinition(
	panelId: string,
	value: unknown,
): unknown {
	const stored = record(value);
	if (!stored) return value;
	let panel = serializedPanel(stored);
	const component = paneContentComponent(panel);
	if (component === "agent") {
		const params = record(panel.params);
		const agentId =
			params && "agentRef" in params
				? agentIdFromPaneParameters(params)
				: agentIdFromAgentPanelId(panelId);
		const ref = record(params?.agentRef);
		const normalizedRef = agentId
			? ref?.agentId === agentId && Object.keys(ref).length === 1
			: params?.agentRef === null;
		if (!params || Object.keys(params).length !== 1 || !normalizedRef) {
			const next: AgentPaneParameters = {
				agentRef: agentId ? { agentId } : null,
			};
			panel = { ...panel, params: next };
		}
	} else if (component === "browser" && panelId === "browser:main") {
		const params = record(panel.params) ?? {};
		if (!("browserPurpose" in params)) {
			panel = { ...panel, params: { ...params, browserPurpose: "workspace" } };
		}
	}
	return panel;
}

/** Normalize saved content references without changing pane identity.
 * Agent runtime authority stays in its registry, not copied view parameters. */
export function normalizePersistedPaneLayout(layout: unknown): unknown {
	const candidate = record(layout);
	const panels = record(candidate?.panels);
	if (!candidate || !panels) return layout;
	let nextPanels: UnknownRecord | undefined;
	for (const [panelId, value] of Object.entries(panels)) {
		const panel = normalizePersistedPaneDefinition(panelId, value);
		if (panel === value) continue;
		nextPanels ??= { ...panels };
		nextPanels[panelId] = panel;
	}
	return nextPanels ? { ...candidate, panels: nextPanels } : layout;
}

export function normalizePersistedPaneLayouts(
	layouts: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	let next: Record<string, unknown> | undefined;
	for (const [spaceId, layout] of Object.entries(layouts)) {
		const normalized = normalizePersistedPaneLayout(layout);
		if (normalized === layout) continue;
		next ??= { ...layouts };
		next[spaceId] = normalized;
	}
	return next ?? (layouts as Record<string, unknown>);
}

import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { normalizePersistedPaneDefinition, paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";

const DURE_CLIENT_PRESENTATION_SCHEMA_VERSION = 3;
const DURE_CLIENT_RUNTIME_BINDING_SCHEMA_VERSION = 1;
export const DURE_CLIENT_PRESENTATION_MAX_SPACES = 64;
export const DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE = 128;
const DURE_CLIENT_PRESENTATION_MAX_TOTAL_PANES = 512;

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const HMUX_RUNTIMES = new Set([
	"hmux_session_v1",
	"hmux_standalone_v1",
	"hmux_managed_v1",
]);

type RecordValue = Record<string, unknown>;

interface DureClientRuntimeBindingV1 {
	readonly schemaVersion: 1;
	readonly runtime: string;
	readonly source: "local" | "ssh";
	readonly hostId: string;
	readonly workspaceId: string;
	readonly sessionId: string;
}

export interface DureClientPaneProjectionV2 {
	readonly id: string;
	readonly type:
		| "agent"
		| "terminal"
		| "remote_terminal"
		| "editor"
		| "browser"
		| "tool"
		| "other";
	readonly component: string | null;
	readonly title: string | null;
	readonly agentId: string | null;
	readonly binding: DureClientRuntimeBindingV1 | null;
}

interface DureClientSpaceProjectionV3 {
	readonly id: string;
	readonly name: string;
	readonly kind: "desktop" | "popout";
	readonly windowLabel: string;
	readonly panes: readonly DureClientPaneProjectionV2[];
}

interface PresentationInput {
	readonly spaces: readonly {
		readonly id: string;
		readonly name: string;
		readonly kind?: "popout";
	}[];
	readonly layouts: Readonly<Record<string, unknown>>;
	readonly agents: readonly {
		readonly id: string;
		readonly runtimeBinding?: unknown;
	}[];
}

function record(value: unknown): RecordValue | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: null;
}

function boundedString(value: unknown, maximum = MAX_ID_LENGTH): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum
	) {
		return null;
	}
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return null;
	}
	return value;
}

function runtimeBinding(value: unknown): DureClientRuntimeBindingV1 | null {
	const candidate = record(value);
	if (!candidate || !HMUX_RUNTIMES.has(String(candidate.runtime))) return null;
	const source = candidate.source;
	const runtime = boundedString(candidate.runtime, 64);
	const hostId = boundedString(candidate.hostId, 256);
	const workspaceId = boundedString(candidate.workspaceId);
	const sessionId = boundedString(candidate.sessionId);
	if (
		(source !== "local" && source !== "ssh") ||
		!runtime ||
		!hostId ||
		!workspaceId ||
		!sessionId
	) {
		return null;
	}
	return {
		schemaVersion: DURE_CLIENT_RUNTIME_BINDING_SCHEMA_VERSION,
		runtime,
		source,
		hostId,
		workspaceId,
		sessionId,
	};
}

function paneType(component: string | null) {
	if (component === "agent") return "agent" as const;
	if (component === "ssh") {
		return "remote_terminal" as const;
	}
	if (component === "terminal") {
		return "terminal" as const;
	}
	if (component === "editor") {
		return "editor" as const;
	}
	if (component === "browser") {
		return "browser" as const;
	}
	if (
		component !== null &&
		[
			"diff",
			"git",
			"graph",
			"onboarding",
			"source-control",
			"mobileSimulator",
		].includes(component)
	) {
		return "tool" as const;
	}
	return "other" as const;
}

function paneProjection(
	id: string,
	value: unknown,
	agents: ReadonlyMap<string, PresentationInput["agents"][number]>,
): DureClientPaneProjectionV2 {
	const panel = record(normalizePersistedPaneDefinition(id, value)) ?? {};
	const params = record(panel.params) ?? panel;
	const component = boundedString(paneContentComponent(panel), 128);
	const agentId =
		component === "agent"
			? (agentIdFromPaneParameters(params) ?? null)
			: null;
	const agentBinding = agentId
		? runtimeBinding(agents.get(agentId)?.runtimeBinding)
		: null;
	return {
		id,
		type: paneType(component),
		component,
		title: boundedString(panel.title, MAX_LABEL_LENGTH),
		agentId,
		binding:
			component === "agent"
				? agentBinding
				: component === "terminal" || component === "ssh"
					? runtimeBinding(params.binding)
					: null,
	};
}

export function buildDureClientPresentation(input: PresentationInput) {
	const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
	const spaces: DureClientSpaceProjectionV3[] = [];
	let omittedSpaceCount = 0;
	let omittedPaneCount = 0;
	let totalPanes = 0;

	for (const desktop of input.spaces) {
		const id = boundedString(desktop.id);
		const name = boundedString(desktop.name, MAX_LABEL_LENGTH);
		if (!id || !name) {
			omittedSpaceCount += 1;
			continue;
		}
		if (spaces.length >= DURE_CLIENT_PRESENTATION_MAX_SPACES) {
			omittedSpaceCount += 1;
			continue;
		}
		let windowLabel: string;
		try {
			windowLabel = spaceWindowLabel(desktop);
		} catch {
			omittedSpaceCount += 1;
			continue;
		}
		const layout = record(input.layouts[id]);
		const panels = record(layout?.panels) ?? {};
		const panes: DureClientPaneProjectionV2[] = [];
		for (const [panelId, panel] of Object.entries(panels)) {
			const validPanelId = boundedString(panelId);
			if (!validPanelId) {
				omittedPaneCount += 1;
				continue;
			}
			if (
				panes.length >= DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE ||
				totalPanes >= DURE_CLIENT_PRESENTATION_MAX_TOTAL_PANES
			) {
				omittedPaneCount += 1;
				continue;
			}
			panes.push(paneProjection(validPanelId, panel, agents));
			totalPanes += 1;
		}
		spaces.push({
			id,
			name,
			kind: desktop.kind === "popout" ? "popout" : "desktop",
			windowLabel,
			panes,
		});
	}

	return {
		schemaVersion: DURE_CLIENT_PRESENTATION_SCHEMA_VERSION,
		complete: omittedSpaceCount === 0 && omittedPaneCount === 0,
		spaces,
		limits: {
			maxSpaces: DURE_CLIENT_PRESENTATION_MAX_SPACES,
			maxPanesPerSpace: DURE_CLIENT_PRESENTATION_MAX_PANES_PER_SPACE,
			maxTotalPanes: DURE_CLIENT_PRESENTATION_MAX_TOTAL_PANES,
		},
		truncation: {
			spaces: omittedSpaceCount > 0,
			panes: omittedPaneCount > 0,
			omittedSpaceCount,
			omittedPaneCount,
		},
	};
}

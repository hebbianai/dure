import { emitTo } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { isRecord } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { isDesktopWorkspaceWindowLabel } from "@/lib/workspace/desktop/desktopVisibilityLease";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import {
	mountedDockviewEntries,
	movingPanels,
} from "@/lib/workspace/dock/dockRegistry";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { isDurablePaneOwned } from "@/lib/workspace/pane/paneOwnership";
import {
	collectWindowSamples,
	type WindowSampleRequest,
} from "@/lib/workspace/window/windowSampleCollection";
import { useStore } from "@/store";
import type { MountedPaneWindow } from "./mountedWindowIdentity";
import {
	parseMountedWorkspaceWindow,
	MOUNTED_WINDOW_REQUEST_EVENT as REQUEST_EVENT,
	MOUNTED_WINDOW_RESPONSE_EVENT as RESPONSE_EVENT,
	mountedWindowGeneration as windowGeneration,
} from "./mountedWindowIdentity";
import { observeMountedWorkspaceWindow } from "./mountedWorkspaceWindow";

export type { MountedPaneWindow } from "./mountedWindowIdentity";

type PaneWindowQuery =
	| { paneId: string; agentId?: never }
	| { paneId?: never; agentId: string };
type PaneWindowTarget = string | { agentId: string };
type PaneWindowRequest = WindowSampleRequest & PaneWindowQuery;
type PaneWindowObservation = PaneWindowQuery & {
	windowLabel: string;
	windowGeneration: string;
	moving: boolean;
	mounts: Array<{
		paneId: string;
		desktopId: string;
		dockviewId: string;
		active: boolean;
	}>;
};

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function parseQuery(value: unknown): PaneWindowQuery | undefined {
	if (!isRecord(value)) return undefined;
	if (identifier(value.paneId) && value.agentId === undefined)
		return { paneId: value.paneId };
	if (identifier(value.agentId) && value.paneId === undefined)
		return { agentId: value.agentId };
	return undefined;
}

export function parseMountedPaneWindow(
	value: unknown,
): MountedPaneWindow | undefined {
	const workspace = parseMountedWorkspaceWindow(value);
	return workspace && isRecord(value) && identifier(value.paneId)
		? { ...workspace, paneId: value.paneId }
		: undefined;
}

function localObservation(target: PaneWindowTarget): PaneWindowObservation {
	const query = typeof target === "string" ? { paneId: target } : target;
	const state = useStore.getState();
	const mounts = mountedDockviewEntries().flatMap(([desktopId, api]) => {
		const panels =
			"paneId" in query ? [api.getPanel(query.paneId)] : api.panels;
		return panels.flatMap((panel) => {
			if (!panel) return [];
			if ("agentId" in query) {
				const ref = dockPanelReference(panel);
				if (
					ref.component !== "agent" ||
					agentIdFromPaneParameters(ref.params) !== query.agentId
				)
					return [];
			}
			if (!isDurablePaneOwned({ desktopId, panelId: panel.id })) return [];
			return [
				{
					paneId: panel.id,
					desktopId,
					dockviewId: api.id,
					active: state.activeSpaceId === desktopId,
				},
			];
		});
	});
	return {
		...query,
		windowLabel: getCurrentWebviewWindow().label,
		windowGeneration,
		moving:
			"paneId" in query
				? movingPanels.has(query.paneId)
				: mounts.some((mount) => movingPanels.has(mount.paneId)),
		mounts,
	};
}

function parseObservation(value: unknown): PaneWindowObservation | undefined {
	const query = parseQuery(value);
	if (
		!isRecord(value) ||
		!query ||
		!identifier(value.windowLabel) ||
		!identifier(value.windowGeneration) ||
		typeof value.moving !== "boolean" ||
		!Array.isArray(value.mounts) ||
		value.mounts.length > 512
	)
		return undefined;
	const mounts: PaneWindowObservation["mounts"] = [];
	for (const mount of value.mounts) {
		// Older exact-pane observations carry the ID only on the sample.
		const paneId: unknown = isRecord(mount)
			? "paneId" in mount
				? mount.paneId
				: query.paneId
			: undefined;
		if (
			!isRecord(mount) ||
			!identifier(paneId) ||
			(query.paneId !== undefined && paneId !== query.paneId) ||
			!identifier(mount.desktopId) ||
			!identifier(mount.dockviewId) ||
			typeof mount.active !== "boolean"
		)
			return undefined;
		mounts.push({
			paneId,
			desktopId: mount.desktopId,
			dockviewId: mount.dockviewId,
			active: mount.active,
		});
	}
	return {
		...query,
		windowLabel: value.windowLabel,
		windowGeneration: value.windowGeneration,
		moving: value.moving,
		mounts,
	};
}

export interface PaneWindowCollector {
	currentWindowLabel(): string;
	listWindowLabels(): Promise<string[]>;
	readLocal(target: PaneWindowTarget): PaneWindowObservation;
	listenResponse(listener: (payload: unknown) => void): Promise<() => void>;
	emitRequest(windowLabel: string, request: PaneWindowRequest): Promise<void>;
}

const collector: PaneWindowCollector = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	listWindowLabels: async () =>
		(await getAllWebviewWindows()).map((window) => window.label),
	readLocal: localObservation,
	listenResponse: (listener) =>
		listenWhenReady<unknown>(
			RESPONSE_EVENT,
			(event) => listener(event.payload),
			{
				target: {
					kind: "WebviewWindow",
					label: getCurrentWebviewWindow().label,
				},
			},
		),
	emitRequest: (windowLabel, request) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			REQUEST_EVENT,
			request,
		),
};

/** Observe the mounted Dockviews afresh; this retains no pane/window registry.
 * Explicit window selection disambiguates presentations, never their identity. */
export async function resolveMountedPaneWindow(
	target: PaneWindowTarget,
	selectedWindowLabel?: string,
	transport: PaneWindowCollector = collector,
	timeoutMs = 500,
): Promise<MountedPaneWindow> {
	const query = parseQuery(
		typeof target === "string" ? { paneId: target } : target,
	);
	if (
		!query ||
		(selectedWindowLabel !== undefined &&
			!isDesktopWorkspaceWindowLabel(selectedWindowLabel))
	) {
		throw new PaneCommandError(
			"invalid_request",
			"The pane or workspace window is invalid.",
		);
	}
	const { samples, expectedWindowLabels } = await collectWindowSamples(
		{
			currentWindowLabel: transport.currentWindowLabel,
			listWindowLabels: async () => {
				const labels = (await transport.listWindowLabels()).filter(
					isDesktopWorkspaceWindowLabel,
				);
				return selectedWindowLabel === undefined
					? labels
					: labels.filter((label) => label === selectedWindowLabel);
			},
			readLocal: () =>
				transport.readLocal(query.paneId ?? { agentId: query.agentId }),
			listenResponse: transport.listenResponse,
			emitRequest: transport.emitRequest,
		},
		(value) => {
			if (!isRecord(value) || !identifier(value.requestId)) return undefined;
			const sample = parseObservation(value.sample);
			return sample &&
				sample.paneId === query.paneId &&
				sample.agentId === query.agentId
				? { requestId: value.requestId, sample }
				: undefined;
		},
		timeoutMs,
		(requestId, replyWindowLabel) => ({
			requestId,
			replyWindowLabel,
			...query,
		}),
	);
	if (expectedWindowLabels.some((label) => !samples.has(label))) {
		throw new PaneCommandError(
			"pane_not_found",
			"A workspace window did not report its pane ownership.",
		);
	}
	const relevant = [...samples.values()].filter(
		(sample) =>
			selectedWindowLabel === undefined ||
			sample.windowLabel === selectedWindowLabel,
	);
	if (relevant.some((sample) => sample.moving))
		throw new PaneCommandError(
			"pane_changed",
			"The pane is moving between workspaces.",
		);
	const mounts = relevant.flatMap((sample) =>
		sample.mounts.map((mount) => ({
			schemaVersion: 1 as const,
			paneId: mount.paneId,
			desktopId: mount.desktopId,
			dockviewId: mount.dockviewId,
			windowLabel: sample.windowLabel,
			windowGeneration: sample.windowGeneration,
			active: mount.active,
		})),
	);
	const active = mounts.filter((mount) => mount.active);
	const candidates = active.length ? active : mounts;
	if (candidates.length !== 1)
		throw new PaneCommandError(
			candidates.length ? "pane_ambiguous" : "pane_not_found",
			candidates.length
				? "Select the window containing the intended chat pane."
				: "Open the chat pane before adding to its draft.",
		);
	const { active: _active, ...owner } = candidates[0];
	return owner;
}

export function revalidateMountedPaneWindow(owner: MountedPaneWindow): void {
	const current = localObservation(owner.paneId);
	if (
		owner.windowLabel !== current.windowLabel ||
		owner.windowGeneration !== current.windowGeneration ||
		current.moving ||
		!current.mounts.some(
			(mount) =>
				mount.desktopId === owner.desktopId &&
				mount.dockviewId === owner.dockviewId,
		)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"The chat pane owner changed before input delivery.",
		);
	}
}

export function installMountedPaneWindowReporter(): Promise<() => void> {
	return listenWhenReady<unknown>(
		REQUEST_EVENT,
		(event) => {
			const value = event.payload;
			const query = parseQuery(value);
			if (
				!isRecord(value) ||
				!identifier(value.requestId) ||
				!identifier(value.replyWindowLabel) ||
				(!query && !identifier(value.desktopId))
			)
				return;
			if (
				value.prepareWorkspace === true &&
				!query &&
				identifier(value.desktopId) &&
				useStore
					.getState()
					.spaces.some(
						(space) => space.id === value.desktopId && space.kind !== "popout",
					)
			)
				requestDesktopPrewarm(value.desktopId);
			void emitTo(
				{ kind: "WebviewWindow", label: value.replyWindowLabel },
				RESPONSE_EVENT,
				{
					requestId: value.requestId,
					sample: query
						? localObservation(query.paneId ?? { agentId: query.agentId })
						: observeMountedWorkspaceWindow(String(value.desktopId)),
				},
			).catch(() => undefined);
		},
		{
			target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label },
		},
	);
}

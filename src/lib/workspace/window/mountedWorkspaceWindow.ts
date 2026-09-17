import { emitTo } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { isRecord } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { isDesktopWorkspaceWindowLabel } from "@/lib/workspace/desktop/desktopVisibilityLease";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import {
	MOUNTED_WINDOW_REQUEST_EVENT,
	MOUNTED_WINDOW_RESPONSE_EVENT,
	type MountedWorkspaceWindow,
	mountedWindowGeneration,
	mountedWindowIdentifier,
	parseMountedWorkspaceWindow,
} from "./mountedWindowIdentity";
import { spaceWindowLabel } from "./windowLabel";
import {
	collectWindowSamples,
	type WindowSampleRequest,
} from "./windowSampleCollection";

export interface WorkspaceWindowObservation {
	desktopId: string;
	windowLabel: string;
	active: boolean;
	mount: MountedWorkspaceWindow | null;
}
interface WorkspaceWindowRequest extends WindowSampleRequest {
	desktopId: string;
}
export interface WorkspaceWindowCollector {
	currentWindowLabel(): string;
	listWindowLabels(): Promise<string[]>;
	readLocal(desktopId: string): WorkspaceWindowObservation;
	listenResponse(listener: (payload: unknown) => void): Promise<() => void>;
	emitRequest(
		windowLabel: string,
		request: WorkspaceWindowRequest,
	): Promise<void>;
}

export function observeMountedWorkspaceWindow(
	desktopId: string,
): WorkspaceWindowObservation {
	const state = useStore.getState();
	const api = getDockview(desktopId);
	const windowLabel = getCurrentWebviewWindow().label;
	return {
		desktopId,
		windowLabel,
		active: state.activeSpaceId === desktopId,
		mount:
			api && state.spaces.some((space) => space.id === desktopId)
				? {
						schemaVersion: 1,
						desktopId,
						dockviewId: api.id,
						windowLabel,
						windowGeneration: mountedWindowGeneration,
					}
				: null,
	};
}

const collector: WorkspaceWindowCollector = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	listWindowLabels: async () =>
		(await getAllWebviewWindows()).map((window) => window.label),
	readLocal: observeMountedWorkspaceWindow,
	listenResponse: (listener) =>
		listenWhenReady<unknown>(
			MOUNTED_WINDOW_RESPONSE_EVENT,
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
			MOUNTED_WINDOW_REQUEST_EVENT,
			request,
		),
};

export async function resolveMountedWorkspaceWindow(
	desktopId: string,
	selectedWindowLabel?: string,
	transport: WorkspaceWindowCollector = collector,
	timeoutMs = 500,
): Promise<MountedWorkspaceWindow> {
	if (
		!mountedWindowIdentifier(desktopId) ||
		(selectedWindowLabel !== undefined &&
			!isDesktopWorkspaceWindowLabel(selectedWindowLabel))
	) {
		throw new PaneCommandError(
			"invalid_request",
			"The destination workspace is invalid.",
		);
	}
	const { samples, expectedWindowLabels } = await collectWindowSamples(
		{
			currentWindowLabel: transport.currentWindowLabel,
			listWindowLabels: async () =>
				(await transport.listWindowLabels()).filter(
					(label) =>
						isDesktopWorkspaceWindowLabel(label) &&
						(selectedWindowLabel === undefined ||
							label === selectedWindowLabel),
				),
			readLocal: () => transport.readLocal(desktopId),
			listenResponse: transport.listenResponse,
			emitRequest: transport.emitRequest,
		},
		(value) => {
			if (
				!isRecord(value) ||
				!mountedWindowIdentifier(value.requestId) ||
				!isRecord(value.sample)
			)
				return undefined;
			const sample = value.sample;
			if (
				sample.desktopId !== desktopId ||
				!mountedWindowIdentifier(sample.windowLabel) ||
				typeof sample.active !== "boolean"
			)
				return undefined;
			const mount =
				sample.mount === null
					? null
					: parseMountedWorkspaceWindow(sample.mount);
			if (
				mount === undefined ||
				(mount &&
					(mount.desktopId !== desktopId ||
						mount.windowLabel !== sample.windowLabel))
			)
				return undefined;
			return {
				requestId: value.requestId,
				sample: {
					desktopId,
					windowLabel: sample.windowLabel,
					active: sample.active,
					mount,
				},
			};
		},
		timeoutMs,
		(requestId, replyWindowLabel) => ({
			requestId,
			replyWindowLabel,
			desktopId,
		}),
	);
	if (expectedWindowLabels.some((label) => !samples.has(label)))
		throw new PaneCommandError(
			"pane_not_found",
			"A destination window has not reported its mounted workspace.",
		);
	const mounts = [...samples.values()].filter(
		(sample) =>
			sample.mount &&
			(selectedWindowLabel === undefined ||
				sample.windowLabel === selectedWindowLabel),
	);
	const active = mounts.filter((sample) => sample.active);
	const candidates = active.length ? active : mounts;
	if (candidates.length !== 1)
		throw new PaneCommandError(
			candidates.length ? "pane_ambiguous" : "pane_not_found",
			"The destination workspace has no unique mounted window.",
		);
	return candidates[0].mount!;
}

/** Await observable frontend readiness before any transfer mutation. Repeated
 * samples are reads; an unanswered/new native window never authorizes a move. */
export async function waitForMountedWorkspaceWindow(
	desktopId: string,
	windowLabel: string,
): Promise<MountedWorkspaceWindow> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			return await resolveMountedWorkspaceWindow(
				desktopId,
				windowLabel,
				collector,
				Math.min(500, Math.max(1, deadline - Date.now())),
			);
		} catch (error) {
			if (
				!(error instanceof PaneCommandError) ||
				error.code !== "pane_not_found" ||
				Date.now() >= deadline
			)
				throw error;
		}
		await new Promise<void>((resolve) =>
			setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
		);
	}
}

export function revalidateMountedWorkspaceWindow(
	owner: MountedWorkspaceWindow,
): void {
	const current = observeMountedWorkspaceWindow(owner.desktopId).mount;
	if (
		!current ||
		current.windowLabel !== owner.windowLabel ||
		current.windowGeneration !== owner.windowGeneration ||
		current.dockviewId !== owner.dockviewId
	) {
		throw new PaneCommandError(
			"pane_changed",
			"The destination workspace owner changed.",
		);
	}
}

/** A cold normal Space uses WorkspaceDeck's existing admission policy. Read
 * every window again afterward; prewarming never resolves a missing peer. */
export async function resolveReadyWorkspaceWindow(
	desktopId: string,
): Promise<MountedWorkspaceWindow> {
	try {
		return await resolveMountedWorkspaceWindow(desktopId);
	} catch (error) {
		if (!(error instanceof PaneCommandError) || error.code !== "pane_not_found")
			throw error;
		const space = useStore
			.getState()
			.spaces.find((candidate) => candidate.id === desktopId);
		if (!space || space.kind === "popout") throw error;
		const current = getCurrentWebviewWindow().label;
		const label =
			current === "main" || /^win-\d+-\d+$/.test(current)
				? current
				: spaceWindowLabel(space);
		if (label === current) requestDesktopPrewarm(desktopId);
		else
			await emitTo(
				{ kind: "WebviewWindow", label },
				MOUNTED_WINDOW_REQUEST_EVENT,
				{
					requestId: crypto.randomUUID(),
					replyWindowLabel: current,
					desktopId,
					prepareWorkspace: true,
				},
			);
		await waitForMountedWorkspaceWindow(desktopId, label);
		return resolveMountedWorkspaceWindow(desktopId);
	}
}

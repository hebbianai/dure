import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DockviewApi } from "dockview-react";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { movePanelToDesktopDrop } from "@/lib/workspace/pane/paneDropCoordinator";
import { dropPosition, type PanelPosition } from "@/lib/workspace/pane/panePlacement";
import {
	PANE_TRANSFER_INPUT_MIMES,
	PANE_WINDOW_DROP_INPUT_EVENTS,
	type PaneTransferPayload,
	parsePaneTransferPayload,
	parsePaneWindowDropRequest,
	resolvePaneDropPosition,
} from "@/lib/workspace/pane/paneWindowTransfer";

const REQUEST_RETENTION_MS = 30_000;
const claimedRequests = new Map<string, number>();

function claimRequest(requestId: string): boolean {
	const now = Date.now();
	for (const [id, claimedAt] of claimedRequests) {
		if (now - claimedAt > REQUEST_RETENTION_MS) claimedRequests.delete(id);
	}
	if (claimedRequests.has(requestId)) return false;
	claimedRequests.set(requestId, now);
	return true;
}

function stablePosition(position: PanelPosition): PanelPosition {
	const group = position.referenceGroup as { id?: unknown } | undefined;
	return typeof group?.id === "string"
		? { ...position, referenceGroup: group.id }
		: position;
}

function recoverTargetDesktopProjection(desktopId: string): Promise<boolean> {
	return recoverCurrentDurableStoreProjection({
		forceProjectionDesktopIds: [desktopId],
	});
}

async function commitDrop(
	payload: PaneTransferPayload,
	targetDesktopId: string,
	position: PanelPosition,
): Promise<void> {
	if (!(await recoverTargetDesktopProjection(targetDesktopId))) return;
	await movePanelToDesktopDrop(
		{
			panelId: payload.panelId,
			fromDesktopId: payload.fromDesktopId,
		},
		targetDesktopId,
		position,
	);
}

export function handlePaneWindowDataDrop(
	event: {
		nativeEvent: DragEvent;
		position: string;
		group?: unknown;
	},
	targetDesktopId: string,
): boolean {
	const dataTransfer = event.nativeEvent.dataTransfer;
	const raw =
		PANE_TRANSFER_INPUT_MIMES.map(
			(mime) => dataTransfer?.getData(mime) ?? "",
		).find(Boolean) ?? "";
	const payload = parsePaneTransferPayload(raw);
	if (
		!payload ||
		payload.sourceWindowLabel === getCurrentWindow().label ||
		payload.fromDesktopId === targetDesktopId ||
		event.position === "center"
	) {
		return false;
	}
	const position = stablePosition(dropPosition(event.group, event.position));
	if (!position.direction || !claimRequest(payload.requestId)) return false;
	try {
		if (dataTransfer) dataTransfer.dropEffect = "move";
	} catch {
		// The target-first transaction still prevents source loss if WebKit
		// exposes a read-only DataTransfer at drop time.
	}
	void commitDrop(payload, targetDesktopId, position).catch((error) => {
		console.error(`[pane window data drop:${targetDesktopId}]`, error);
	});
	return true;
}

interface PaneWindowDropTarget {
	desktopId: string;
	isActive: () => boolean;
	api: () => DockviewApi | undefined;
	element: () => HTMLElement | null;
}

async function screenPointToClient(
	screenX: number,
	screenY: number,
): Promise<{ x: number; y: number } | null> {
	try {
		const currentWindow = getCurrentWindow();
		const [position, scale] = await Promise.all([
			currentWindow.innerPosition(),
			currentWindow.scaleFactor(),
		]);
		return {
			x: screenX - position.x / scale,
			y: screenY - position.y / scale,
		};
	} catch {
		return null;
	}
}

/**
 * Listen for the dragend fallback used when an embedded WebView does not
 * forward HTML5 DataTransfer across native windows. Only the active Workspace
 * can claim a request; utility chrome and inactive warm replicas ignore it.
 */
export function installPaneWindowDropTarget(
	target: PaneWindowDropTarget,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	const currentWindowLabel = getCurrentWindow().label;
	const handleEvent = (event: { payload: unknown }) => {
		const request = parsePaneWindowDropRequest(event.payload);
		const initialApi = target.api();
		const initialElement = target.element();
		if (
			!request ||
			request.targetWindowLabel !== currentWindowLabel ||
			request.sourceWindowLabel === currentWindowLabel ||
			request.fromDesktopId === target.desktopId ||
			!target.isActive() ||
			!initialApi ||
			!initialElement
		) {
			return;
		}

		void (async () => {
			const point = await screenPointToClient(request.screenX, request.screenY);
			if (!point || disposed) return;
			if (!(await recoverTargetDesktopProjection(target.desktopId))) return;
			if (disposed || !target.isActive()) return;

			const api = target.api();
			const element = target.element();
			if (!api || !element || api !== initialApi) return;
			const dockBounds = element.getBoundingClientRect();
			const position = resolvePaneDropPosition(
				point,
				{
					x: dockBounds.left,
					y: dockBounds.top,
					width: dockBounds.width,
					height: dockBounds.height,
				},
				api.groups.flatMap((group) => {
					const bounds = group.api.boundingBox;
					return bounds
						? [
								{
									value: group.id,
									bounds: {
										x: dockBounds.left + bounds.left,
										y: dockBounds.top + bounds.top,
										width: bounds.width,
										height: bounds.height,
									},
								},
							]
						: [];
				}),
			);
			if (!position || !claimRequest(request.requestId)) return;
			await movePanelToDesktopDrop(
				{
					panelId: request.panelId,
					fromDesktopId: request.fromDesktopId,
				},
				target.desktopId,
				position,
			);
		})().catch((error) => {
			console.error(`[pane window fallback drop:${target.desktopId}]`, error);
		});
	};

	void (async () => {
		const unlisteners: Array<() => void> = [];
		const release = () => {
			for (const unlisten of unlisteners.splice(0)) unlisten();
		};
		try {
			for (const eventName of PANE_WINDOW_DROP_INPUT_EVENTS) {
				unlisteners.push(await listenWhenReady(eventName, handleEvent));
			}
		} catch (error) {
			release();
			throw error;
		}
		return release;
	})()
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch((error) => {
			console.error(`[pane window drop listener:${target.desktopId}]`, error);
		});

	return () => {
		if (disposed) return;
		disposed = true;
		const ownedStop = stop;
		stop = undefined;
		ownedStop?.();
	};
}

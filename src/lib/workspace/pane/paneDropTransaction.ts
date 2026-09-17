import type { DockviewApi } from "dockview-react";
import {
	type DesktopPaneMoveItem,
	type MovePanelsToDesktopReceipt,
	moveFailure,
	planDesktopPaneMove,
} from "@/lib/workspace/desktop/desktopPaneMove";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { placementOptions } from "@/lib/workspace/pane/panePlacement";
import { paneProjectionSpecFromLayout } from "@/lib/workspace/pane/paneWindowTransfer";

export interface PaneDropTransactionDependencies {
	liveDockviews: ReadonlyMap<string, DockviewApi>;
	readLayouts: () => Record<string, unknown>;
	writeLayouts: (layouts: Record<string, unknown>) => void;
	guardPanelMove: (panelId: string) => () => void;
	publishLayoutPush: (desktopIds: readonly string[]) => void;
}

export interface PaneDropTransactionPosition {
	referenceGroup?: unknown;
	direction?: string;
	floating?: { x: number; y: number; width?: number; height?: number };
}

function projectLayout(api: DockviewApi, layout: unknown): void {
	api.fromJSON(layout as Parameters<DockviewApi["fromJSON"]>[0], {
		reuseExistingPanels: true,
	});
}

/** The existing drop mutation is synchronous. A caller can record its exact
 * receipt before yielding to window messages or persistence acknowledgements. */
export function commitPaneDropTransaction(
	item: DesktopPaneMoveItem,
	targetDesktopId: string,
	position: PaneDropTransactionPosition,
	dependencies: PaneDropTransactionDependencies,
): MovePanelsToDesktopReceipt {
	const validDirection =
		position.direction === "left" ||
		position.direction === "right" ||
		position.direction === "above" ||
		position.direction === "below";
	if (!position.floating && !validDirection) {
		return moveFailure("target_projection_failed", targetDesktopId);
	}
	const targetApi = dependencies.liveDockviews.get(targetDesktopId);
	if (!targetApi) {
		return moveFailure("target_projection_failed", targetDesktopId);
	}

	let targetBefore: unknown;
	try {
		targetBefore = targetApi.toJSON();
	} catch {
		return moveFailure("target_snapshot_failed", targetDesktopId);
	}

	const layoutsBefore = dependencies.readLayouts();
	let sourceBefore = layoutsBefore[item.fromDesktopId];
	const sourceApi = dependencies.liveDockviews.get(item.fromDesktopId);
	// 같은 창의 Spaces drag는 마지막 layout debounce 직후에도 시작할 수 있다.
	// 그때 persisted source만 읽으면 방금 재배치된 pane 정의를 놓치므로, 현재
	// mounted source를 동기로 찍는다. 다른 창의 source는 durable layout만 쓴다.
	if (sourceApi && sourceApi !== targetApi) {
		try {
			sourceBefore = sourceApi.toJSON();
		} catch {
			return moveFailure("layout_snapshot_failed", item.fromDesktopId);
		}
	}
	const transactionBase = {
		...layoutsBefore,
		[item.fromDesktopId]: sourceBefore,
		[targetDesktopId]: targetBefore,
	};
	const initialPlan = planDesktopPaneMove(
		transactionBase,
		[item],
		targetDesktopId,
	);
	if (initialPlan.error || initialPlan.movedPanelIds.length === 0) {
		return {
			...initialPlan,
			projectedDesktopIds: [],
			projectionFailedDesktopIds: [],
		};
	}

	const projection = paneProjectionSpecFromLayout(
		transactionBase[item.fromDesktopId],
		item.panelId,
	);
	if (!projection) {
		return moveFailure("target_projection_failed", targetDesktopId);
	}

	const rollbackTarget = () => {
		try {
			projectLayout(targetApi, targetBefore);
		} catch (error) {
			console.error(`[pane drop rollback:${targetDesktopId}]`, error);
		}
	};
	const releaseGuard = dependencies.guardPanelMove(item.panelId);

	try {
		if (!targetApi.getPanel(item.panelId)) {
			addPanePreservingSizes(targetApi, {
				...projection,
				...placementOptions(position),
			} as never);
		}

		let targetAfter: unknown;
		try {
			targetAfter = targetApi.toJSON();
		} catch {
			rollbackTarget();
			return moveFailure("target_snapshot_failed", targetDesktopId);
		}

		const plan = planDesktopPaneMove(
			{
				...dependencies.readLayouts(),
				[item.fromDesktopId]: sourceBefore,
				[targetDesktopId]: targetAfter,
			},
			[item],
			targetDesktopId,
		);
		if (plan.error || plan.movedPanelIds.length === 0) {
			rollbackTarget();
			return {
				...plan,
				projectedDesktopIds: [],
				projectionFailedDesktopIds: [],
			};
		}

		const updates = {
			...plan.updates,
			[targetDesktopId]: targetAfter,
		};
		const touchedDesktopIds = [
			...new Set([...plan.touchedDesktopIds, targetDesktopId]),
		];
		const previousLayouts = dependencies.readLayouts();
		try {
			dependencies.writeLayouts({
				...previousLayouts,
				...updates,
			});
		} catch (error) {
			// Zustand updates memory before its persist adapter writes. Restore
			// the in-memory transaction and visible target if persistence fails;
			// the source window never observes a removal.
			try {
				dependencies.writeLayouts(previousLayouts);
			} catch {
				// The assignment still precedes the failed persistence attempt.
			}
			rollbackTarget();
			console.error(`[pane drop persistence:${targetDesktopId}]`, error);
			return moveFailure("persistence_failed", targetDesktopId);
		}

		const projectedDesktopIds = [targetDesktopId];
		const projectionFailedDesktopIds: string[] = [];
		for (const desktopId of touchedDesktopIds) {
			if (desktopId === targetDesktopId) continue;
			const api = dependencies.liveDockviews.get(desktopId);
			const layout = updates[desktopId];
			if (!api || !layout) continue;
			try {
				projectLayout(api, layout);
				projectedDesktopIds.push(desktopId);
			} catch (error) {
				projectionFailedDesktopIds.push(desktopId);
				console.error(`[pane drop projection:${desktopId}]`, error);
			}
		}

		dependencies.publishLayoutPush(touchedDesktopIds);
		return {
			...plan,
			updates,
			touchedDesktopIds,
			projectedDesktopIds,
			projectionFailedDesktopIds,
		};
	} catch (error) {
		rollbackTarget();
		console.error(`[pane drop projection:${targetDesktopId}]`, error);
		return moveFailure("target_projection_failed", targetDesktopId);
	} finally {
		releaseGuard();
	}
}

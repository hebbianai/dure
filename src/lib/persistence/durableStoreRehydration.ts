import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import type { DurableProjectionCleanupCandidates } from "@/lib/persistence/durableProjectionRuntimeCleanup";

export const DURABLE_STORE_REHYDRATED_EVENT = "dure:durable-store-rehydrated";

export interface DurableStoreRehydrationOptions {
	forceProjection?: boolean;
	forceProjectionDesktopIds?: readonly string[];
	requiredProjectionDesktopId?: string;
}

interface DurableStoreRehydrationEventDetail
	extends DurableStoreRehydrationOptions {
	projection?: {
		desktopIds: readonly string[];
		forceAll: boolean;
		observed: Set<string>;
		failed: Set<string>;
	};
}

export class DurableStoreProjectionError extends Error {
	readonly desktopIds: readonly string[];

	constructor(desktopIds: readonly string[]) {
		super(`durable layout projection failed for ${desktopIds.join(", ")}`);
		this.name = "DurableStoreProjectionError";
		this.desktopIds = [...desktopIds];
	}
}

function rehydrationDetail(
	event: Event,
): DurableStoreRehydrationEventDetail | undefined {
	return event instanceof CustomEvent
		? (event.detail as DurableStoreRehydrationEventDetail | undefined)
		: undefined;
}

/** Installs the latest durable store and synchronously asks mounted workspaces
 * to project it before the caller resumes. */
export async function rehydrateDurableStore(
	options: DurableStoreRehydrationOptions = {},
	additionalDepartures?: DurableProjectionCleanupCandidates,
): Promise<void> {
	const departed = await settleDurableAppState(additionalDepartures);
	if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
		return;
	}
	const projectionDesktopIds = [
		...new Set([
			...(options.forceProjectionDesktopIds ?? []),
			...departed.projectionSpaceIds,
			...(options.requiredProjectionDesktopId
				? [options.requiredProjectionDesktopId]
				: []),
		]),
	];
	const forceAll =
		options.forceProjection === true &&
		(options.forceProjectionDesktopIds?.length ?? 0) === 0 &&
		options.requiredProjectionDesktopId === undefined;
	const projection =
		projectionDesktopIds.length > 0 || options.forceProjection === true
			? {
					desktopIds: projectionDesktopIds,
					forceAll,
					observed: new Set<string>(),
					failed: new Set<string>(),
				}
			: undefined;
	window.dispatchEvent(
		new CustomEvent(DURABLE_STORE_REHYDRATED_EVENT, {
			detail: {
				...options,
				...(projectionDesktopIds.length > 0
					? { forceProjectionDesktopIds: projectionDesktopIds }
					: {}),
				projection,
			},
		}),
	);
	if (projection && projection.failed.size > 0) {
		throw new DurableStoreProjectionError([...projection.failed]);
	}
}

/** Binds the event above to Workspace's single layout-projection authority.
 * Ordinary background synchronization respects focus; correlated commands
 * can force the same projection path before mutating its Dockview. */
export function subscribeDurableStoreLayoutProjection(
	desktopId: string,
	project: () => boolean,
	hasFocus: () => boolean = () => document.hasFocus(),
): () => void {
	const onRehydrated = (event: Event) => {
		const detail = rehydrationDetail(event);
		const requiredHere =
			detail?.projection?.desktopIds.includes(desktopId) === true;
		const trackedHere = requiredHere || detail?.projection?.forceAll === true;
		const forceHere = trackedHere;
		if (!forceHere && hasFocus()) return;
		let projected = false;
		try {
			projected = project();
		} catch (error) {
			console.error(`[durable layout projection:${desktopId}]`, error);
		}
		if (trackedHere && detail?.projection) {
			detail.projection.observed.add(desktopId);
			if (!projected) detail.projection.failed.add(desktopId);
		}
	};
	window.addEventListener(DURABLE_STORE_REHYDRATED_EVENT, onRehydrated);
	return () =>
		window.removeEventListener(DURABLE_STORE_REHYDRATED_EVENT, onRehydrated);
}

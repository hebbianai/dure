import { recoverDurableProjection } from "@/lib/persistence/durableProjectionRecovery";
import type { DurableProjectionCleanupCandidates } from "@/lib/persistence/durableProjectionRuntimeCleanup";
import {
	DurableStoreProjectionError,
	rehydrateDurableStore,
	type DurableStoreRehydrationOptions,
} from "@/lib/persistence/durableStoreRehydration";
import { reloadCurrentPage } from "@/lib/platform/pageReload";
import { durableAppStorage } from "@/store";

/** Project authoritative state while preserving this WebView's prior ancestor. */
export function recoverCurrentDurableProjection(
	project: () => Promise<void>,
): Promise<boolean> {
	return recoverDurableProjection({
		project,
		freezeAncestor: () => durableAppStorage.freezeProjectionAncestor(),
		reload: reloadCurrentPage,
		onRetry: (error) =>
			console.warn("Failed to project durable app state; retrying", error),
		onFailure: (error) =>
			console.error("Failed to project durable app state", error),
		onReloadFailure: (error) =>
			console.error("Failed to reload stale durable app projection", error),
	});
}

/** Rehydrate the store while retaining every projection target consumed by a failed attempt. */
export function recoverCurrentDurableStoreProjection(
	options: DurableStoreRehydrationOptions = {},
	additionalDepartures?: DurableProjectionCleanupCandidates,
): Promise<boolean> {
	const requiredDesktopIds = new Set(options.forceProjectionDesktopIds ?? []);
	return recoverCurrentDurableProjection(async () => {
		try {
			await rehydrateDurableStore(
				{
					...options,
					forceProjectionDesktopIds: [...requiredDesktopIds],
				},
				additionalDepartures,
			);
		} catch (error) {
			if (error instanceof DurableStoreProjectionError) {
				for (const desktopId of error.desktopIds) {
					requiredDesktopIds.add(desktopId);
				}
			}
			throw error;
		}
	});
}

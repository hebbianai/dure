import { createBroadcast } from "@/lib/state/broadcast";
import {
	availablePluginCatalogEntries,
	type DurePluginCatalogEntry,
	type DurePluginCatalogSnapshotV2,
	type DurePluginViewContainer,
	pluginViewContainers,
} from "@/lib/plugins/durePlugins";

export interface PluginCatalogResourceSnapshot {
	snapshot: DurePluginCatalogSnapshotV2 | null;
	catalog: DurePluginCatalogEntry[] | null;
	containers: DurePluginViewContainer[];
	loadState: "idle" | "loading" | "ready" | "error";
	error: string | null;
}

export interface PluginCatalogResource {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => PluginCatalogResourceSnapshot;
	ensureLoaded: () => void;
	refresh: () => Promise<void>;
}

const INITIAL_SNAPSHOT: PluginCatalogResourceSnapshot = {
	snapshot: null,
	catalog: null,
	containers: [],
	loadState: "idle",
	error: null,
};

/** One request-fenced catalog projection shared by every plugin UI surface. */
export function createPluginCatalogResource(
	load: () => Promise<DurePluginCatalogSnapshotV2>,
): PluginCatalogResource {
	const changed = createBroadcast<void>();
	let current = INITIAL_SNAPSHOT;
	let initialized = false;
	let requestGeneration = 0;

	const publish = (next: PluginCatalogResourceSnapshot) => {
		current = next;
		changed.publish();
	};

	const refresh = async () => {
		initialized = true;
		const generation = ++requestGeneration;
		publish({ ...current, loadState: "loading", error: null });
		try {
			const catalogSnapshot = await load();
			if (generation !== requestGeneration) return;
			const catalog = availablePluginCatalogEntries(catalogSnapshot);
			publish({
				snapshot: catalogSnapshot,
				catalog,
				containers: pluginViewContainers(catalog),
				loadState: "ready",
				error: null,
			});
		} catch (error) {
			if (generation !== requestGeneration) return;
			publish({ ...current, loadState: "error", error: String(error) });
		}
	};

	return {
		subscribe(listener) {
			return changed.subscribe(listener);
		},
		getSnapshot() {
			return current;
		},
		ensureLoaded() {
			if (!initialized) void refresh();
		},
		refresh,
	};
}

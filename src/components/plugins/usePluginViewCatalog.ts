import { useSyncExternalStore } from "react";
import { durePluginCatalogV2 } from "@/lib/ipc";
import {
	createPluginCatalogResource,
	type PluginCatalogResourceSnapshot,
} from "@/lib/plugins/pluginCatalogResource";

export type PluginViewCatalogState = PluginCatalogResourceSnapshot;

function createResource() {
	return createPluginCatalogResource(() => durePluginCatalogV2());
}

let resource = createResource();

function subscribe(listener: () => void) {
	const subscribedResource = resource;
	const unsubscribe = subscribedResource.subscribe(listener);
	subscribedResource.ensureLoaded();
	return unsubscribe;
}

function getSnapshot() {
	return resource.getSnapshot();
}

/** All mounted plugin surfaces share one negotiated catalog projection. */
export function usePluginCatalog(): PluginViewCatalogState {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePluginViewCatalog(): PluginViewCatalogState {
	return usePluginCatalog();
}

export function refreshPluginViewCatalog(): Promise<void> {
	return resource.refresh();
}

/** Test-only: every mounted catalog consumer must be unmounted first. */
export function resetPluginViewCatalogForTests() {
	resource = createResource();
}

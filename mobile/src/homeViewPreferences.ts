import {
	normalizeSpacesViewOptions,
	type SpacesViewOptions,
} from "@/lib/spaces/spacesViewOptions";

const STORAGE_KEY = "dure.homeView.v1";

export function loadHomeViewOptions(
	storage: Pick<Storage, "getItem"> = localStorage,
): SpacesViewOptions {
	try {
		return normalizeSpacesViewOptions(
			JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"),
			"space",
		);
	} catch {
		return normalizeSpacesViewOptions(undefined, "space");
	}
}

export function saveHomeViewOptions(
	value: SpacesViewOptions,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// The current view still works when persistent storage is unavailable.
	}
}

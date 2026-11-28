// Which windows the person asked to keep above other apps' windows. Window
// labels are stable per surface (an agent's large window, the presentation
// window), so a reopened window comes back the way it was left. Losing this
// only changes a window's level, so it lives in presentation storage.

import {
	browserLocalStorage,
	readPresentationItem,
	writePresentationItem,
} from "@/lib/persistence/windowPresentationStorage";

const KEEP_ON_TOP_STORAGE_KEY = "dure-window-keep-on-top";

/** The labels saved as kept on top; anything malformed reads as none. */
function keptOnTopLabels(storage: Storage | undefined): string[] {
	const raw = readPresentationItem(storage, KEEP_ON_TOP_STORAGE_KEY);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return [
			...new Set(
				parsed.filter(
					(label): label is string =>
						typeof label === "string" && label.length > 0,
				),
			),
		];
	} catch {
		return [];
	}
}

export function keepOnTopPreferred(
	storage: Storage | undefined,
	label: string,
): boolean {
	return keptOnTopLabels(storage).includes(label);
}

/** Saves the choice for one window. Turning it off drops the label, so the
 *  list only ever holds windows that are kept on top. */
export function rememberKeepOnTop(
	storage: Storage | undefined,
	label: string,
	keepOnTop: boolean,
): void {
	if (!storage || !label) return;
	const others = keptOnTopLabels(storage).filter(
		(candidate) => candidate !== label,
	);
	writePresentationItem(
		storage,
		KEEP_ON_TOP_STORAGE_KEY,
		JSON.stringify(keepOnTop ? [...others, label] : others),
	);
}

/** Creation options for a window with this label, so a window saved as kept
 *  on top opens at that level instead of flashing at the normal one. */
export function keepOnTopWindowOptions(label: string): {
	alwaysOnTop: boolean;
} {
	return { alwaysOnTop: keepOnTopPreferred(browserLocalStorage(), label) };
}

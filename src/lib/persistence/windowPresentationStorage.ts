// Web Storage for one window's presentation state (sidebar, Work view).
// Losing it only resets how a window looks, so every access tolerates a
// storage that is missing or throws, and the window stays usable.

/** This realm's localStorage, when it can be used at all. */
export function browserLocalStorage(): Storage | undefined {
	if (typeof localStorage === "undefined") return undefined;
	try {
		// Access itself can throw when Web Storage is unavailable.
		void localStorage.length;
		return localStorage;
	} catch {
		return undefined;
	}
}

export function readPresentationItem(
	storage: Storage | undefined,
	key: string,
): string | null {
	try {
		return storage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function writePresentationItem(
	storage: Storage,
	key: string,
	value: string,
): void {
	try {
		storage.setItem(key, value);
	} catch {
		// Presentation-only state: keep the window usable when Web Storage is
		// unavailable or full rather than surfacing a fatal error.
	}
}

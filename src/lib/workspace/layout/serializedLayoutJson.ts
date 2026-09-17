// Shared helpers for serialized Dockview layout JSON (persisted layouts and
// api.toJSON() snapshots). Extracted from the promotion/move flows that each
// carried an identical copy.

type UnknownRecord = Record<string, unknown>;

/** Narrow a JSON value to a plain object record; arrays are not records. */
export function recordOf(value: unknown): UnknownRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

/** Deep-clone a JSON-serializable value; null when it cannot round-trip. */
export function cloneJson<T>(value: T): T | null {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return null;
	}
}

/** Rewrite every grid/group reference to a renamed panel id in place:
 * `views`/`panelIds` membership arrays and the `activeView` selection. */
export function replacePanelReferences(
	value: unknown,
	sourcePanelId: string,
	targetPanelId: string,
): void {
	if (Array.isArray(value)) {
		for (const entry of value) {
			replacePanelReferences(entry, sourcePanelId, targetPanelId);
		}
		return;
	}
	const record = recordOf(value);
	if (!record) return;
	for (const [key, entry] of Object.entries(record)) {
		if ((key === "views" || key === "panelIds") && Array.isArray(entry)) {
			record[key] = entry.map((candidate) =>
				candidate === sourcePanelId ? targetPanelId : candidate,
			);
			continue;
		}
		if (key === "activeView" && entry === sourcePanelId) {
			record[key] = targetPanelId;
			continue;
		}
		replacePanelReferences(entry, sourcePanelId, targetPanelId);
	}
}

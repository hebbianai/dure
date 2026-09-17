// Which repository groups the Spaces pane shows folded. Keyed by the
// repository group key (`spaceRepositoryGroupKey`), so a fold made under one
// hierarchy holds under the other and survives an app restart — a folded
// repository is a decision about that repository, not about one render.
//
// Its own storage key, like the file-tree expansion store: a fold must not
// serialize the whole durable app snapshot.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import { UNOPENED_SECTION_FOLD_KEY } from "@/lib/spaces/unopenedAgentGroups";

export type CollapsedGroupKeys = Readonly<Record<string, true>>;

interface SpacesCollapsedGroupsStore {
	collapsed: CollapsedGroupKeys;
	toggle: (key: string) => void;
	setCollapsed: (keys: readonly string[], collapsed: boolean) => void;
}

/** Pure fold/unfold: removes the key when present, adds it otherwise. */
export function toggleCollapsedKey(
	collapsed: CollapsedGroupKeys,
	key: string,
): CollapsedGroupKeys {
	if (collapsed[key]) {
		const { [key]: _removed, ...rest } = collapsed;
		return rest;
	}
	return { ...collapsed, [key]: true };
}

/** Fold or unfold only the supplied rendered groups. Entries outside the
 * current projection stay untouched, so a search or grouping change cannot
 * erase an earlier per-repository decision. */
export function setCollapsedKeys(
	current: CollapsedGroupKeys,
	keys: readonly string[],
	collapsed: boolean,
): CollapsedGroupKeys {
	if (keys.length === 0) return current;
	if (collapsed) {
		let changed = false;
		const next: Record<string, true> = { ...current };
		for (const key of keys) {
			if (next[key]) continue;
			next[key] = true;
			changed = true;
		}
		return changed ? next : current;
	}
	const visible = new Set(keys);
	if (!keys.some((key) => current[key])) return current;
	return Object.fromEntries(
		Object.entries(current).filter(([key]) => !visible.has(key)),
	);
}

/** Folds that hold until someone opens them: the unopened-agent queue is
 *  closed by default (owner decision 2026-09-03) — it is a backlog, not the
 *  work in front of you. Every other group starts open. */
const DEFAULT_COLLAPSED: CollapsedGroupKeys = {
	[UNOPENED_SECTION_FOLD_KEY]: true,
};

/** Snapshots from before the queue folded by default (version 1) get that
 *  fold once; from then on an absent key means the person opened it. */
export function migrateCollapsedGroups(
	persisted: unknown,
	version: number,
): unknown {
	if (version >= 2) return persisted;
	return {
		collapsed: { ...normalizeCollapsedKeys(persisted), ...DEFAULT_COLLAPSED },
	};
}

/** Only well-formed persisted entries come back; anything else starts open. */
export function normalizeCollapsedKeys(raw: unknown): CollapsedGroupKeys {
	if (!raw || typeof raw !== "object") return {};
	const collapsed = (raw as { collapsed?: unknown }).collapsed;
	if (!collapsed || typeof collapsed !== "object") return {};
	const next: Record<string, true> = {};
	for (const [key, value] of Object.entries(collapsed)) {
		if (value === true) next[key] = true;
	}
	return next;
}

export const useSpacesCollapsedGroups = create<SpacesCollapsedGroupsStore>()(
	persist(
		(set) => ({
			collapsed: DEFAULT_COLLAPSED,
			toggle: (key) =>
				set((state) => ({ collapsed: toggleCollapsedKey(state.collapsed, key) })),
			setCollapsed: (keys, collapsed) =>
				set((state) => {
					const next = setCollapsedKeys(state.collapsed, keys, collapsed);
					return next === state.collapsed ? state : { collapsed: next };
				}),
		}),
		{
			name: "agent-ide-spaces-collapsed",
			version: 2,
			storage: createReferenceAwareLocalStorage(),
			partialize: (state) => ({ collapsed: state.collapsed }),
			migrate: (persisted, version) =>
				migrateCollapsedGroups(persisted, version) as {
					collapsed: CollapsedGroupKeys;
				},
			// Nothing stored yet keeps the defaults; a stored snapshot replaces
			// them wholesale — an absent key is a decision to keep a group open.
			merge: (persisted, current) => ({
				...current,
				collapsed:
					persisted == null ? current.collapsed : normalizeCollapsedKeys(persisted),
			}),
		},
	),
);

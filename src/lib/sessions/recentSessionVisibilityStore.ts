import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import {
	type HiddenRecentSession,
	hideRecentSession,
	normalizeHiddenRecentSessions,
	type RecentSessionVisibilityTarget,
} from "@/lib/sessions/recentSessionVisibility";

export const RECENT_SESSION_VISIBILITY_STORAGE_KEY =
	"dure:recent-session-visibility";

interface RecentSessionVisibilityStore {
	hidden: readonly HiddenRecentSession[];
	remove: (target: RecentSessionVisibilityTarget) => void;
	restoreAll: () => void;
}

export const useRecentSessionVisibilityStore =
	create<RecentSessionVisibilityStore>()(
		persist(
			(set) => ({
				hidden: [],
				remove: (target) =>
					set((current) => {
						const hidden = hideRecentSession(current.hidden, target);
						return hidden === current.hidden ? {} : { hidden };
					}),
				restoreAll: () =>
					set((current) => (current.hidden.length === 0 ? {} : { hidden: [] })),
			}),
			{
				name: RECENT_SESSION_VISIBILITY_STORAGE_KEY,
				version: 1,
				storage: createReferenceAwareLocalStorage(),
				partialize: (state) => ({ hidden: state.hidden }),
				merge: (persisted, current) => ({
					...current,
					hidden: normalizeHiddenRecentSessions(
						(persisted as Partial<RecentSessionVisibilityStore> | undefined)
							?.hidden,
					),
				}),
			},
		),
	);

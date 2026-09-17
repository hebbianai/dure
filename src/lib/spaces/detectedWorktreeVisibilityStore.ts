import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";
import {
	hideDetectedWorktree,
	normalizeHiddenDetectedWorktrees,
	type HiddenDetectedWorktree,
} from "@/lib/spaces/detectedWorktreeVisibility";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";

const DETECTED_WORKTREE_VISIBILITY_STORAGE_KEY =
	"agent-ide-detected-worktree-visibility";

interface DetectedWorktreeVisibilityStore {
	hidden: readonly HiddenDetectedWorktree[];
	hide: (session: DetectedWorktreeSession) => void;
	restoreAll: () => void;
}

export const useDetectedWorktreeVisibilityStore =
	create<DetectedWorktreeVisibilityStore>()(
		persist(
			(set) => ({
				hidden: [],
				hide: (session) =>
					set((current) => ({
						hidden: hideDetectedWorktree(current.hidden, session),
					})),
				restoreAll: () =>
					set((current) => (current.hidden.length === 0 ? {} : { hidden: [] })),
			}),
			{
				name: DETECTED_WORKTREE_VISIBILITY_STORAGE_KEY,
				version: 1,
				storage: createReferenceAwareLocalStorage(),
				partialize: (state) => ({ hidden: state.hidden }),
				merge: (persisted, current) => ({
					...current,
					hidden: normalizeHiddenDetectedWorktrees(
						(persisted as Partial<DetectedWorktreeVisibilityStore> | undefined)
							?.hidden,
					),
				}),
			},
		),
	);

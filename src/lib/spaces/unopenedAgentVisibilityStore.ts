import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import {
	type HiddenUnopenedAgent,
	hideUnopenedAgent,
	rehydrateHiddenUnopenedAgents,
	type UnopenedAgentVisibilityTarget,
} from "@/lib/spaces/unopenedAgentVisibility";

const UNOPENED_AGENT_VISIBILITY_STORAGE_KEY =
	"agent-ide-unopened-agent-visibility";

interface UnopenedAgentVisibilityStore {
	hidden: readonly HiddenUnopenedAgent[];
	hide: (target: UnopenedAgentVisibilityTarget) => void;
	restore: (agentId: string) => void;
	restoreAll: () => void;
}

export const unopenedAgentVisibilityStorage =
	createReferenceAwareLocalStorage<
		Pick<UnopenedAgentVisibilityStore, "hidden">
	>();

export const useUnopenedAgentVisibilityStore =
	create<UnopenedAgentVisibilityStore>()(
		persist(
			(set) => ({
				hidden: [],
				hide: (target) =>
					set((current) => ({
						hidden: hideUnopenedAgent(current.hidden, target),
					})),
				restore: (agentId) =>
					set((current) => ({
						hidden: current.hidden.filter((record) => record.id !== agentId),
					})),
				restoreAll: () =>
					set((current) => (current.hidden.length === 0 ? {} : { hidden: [] })),
			}),
			{
				name: UNOPENED_AGENT_VISIBILITY_STORAGE_KEY,
				version: 1,
				storage: unopenedAgentVisibilityStorage,
				partialize: (state) => ({ hidden: state.hidden }),
				// Rehydration zeroes the per-run episode observation — see
				// rehydrateHiddenUnopenedAgents for why a stale observation would
				// swallow this run's first fresh episodes.
				merge: (persisted, current) => ({
					...current,
					hidden: rehydrateHiddenUnopenedAgents(
						(persisted as Partial<UnopenedAgentVisibilityStore> | undefined)
							?.hidden,
					),
				}),
			},
		),
	);

// Store wiring for the next-up chip: the list, its shortcut and where each
// row leads. The chip itself only renders what these hooks return; each
// row's own facts come from useAgentRowFacts. A manager's team line reads
// the same order and the same row destinations.
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNeedsPerson } from "@/components/agents/useNeedsPerson";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { deriveNextUp, type NextUp } from "@/lib/agents/nextUp";
import { agentRevealTargets, goToNextUp } from "@/lib/agents/nextUpNavigation";
import {
	chordToLabels,
	matchesChord,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

export function useNextUp(): NextUp {
	const agentIds = useStore(
		useShallow((state) => state.agents.map((agent) => agent.id)),
	);
	const needsPerson = useNeedsPerson();
	const facts = useAgentAttention(
		useShallow((state) => ({
			displayStates: state.displayStates,
			episodes: state.episodes,
			acks: state.acks,
			episodeKinds: state.episodeKinds,
			episodeAt: state.episodeAt,
		})),
	);
	return useMemo(
		() => deriveNextUp({ agentIds, needsPerson, ...facts }),
		[agentIds, needsPerson, facts],
	);
}

/** The shortcut walks the same order the list shows. With nothing waiting the
 * key is left alone rather than swallowed by a command that cannot act. */
export function useNextUpShortcut(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const chord = shortcutChord(
				"go-to-next-up",
				useStore.getState().shortcutOverrides,
			);
			if (!matchesChord(chord, event) || shouldYieldToTerminal()) return;
			if (goToNextUp()) event.preventDefault();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);
}

/** The chord actually bound, as keycaps; none when the user cleared it. */
export function useNextUpKeys(): string[] {
	const overrides = useStore((state) => state.shortcutOverrides);
	return useMemo(() => {
		const chord = shortcutChord("go-to-next-up", overrides);
		return chord ? chordToLabels(chord) : [];
	}, [overrides]);
}

/** The Space each listed agent's row leads to, named only when going there
 * leaves the Space on screen. Pane locations are read once per change, not
 * once per row; pass a memoized list. */
export function useAgentRevealSpaceNames(
	agentIds: readonly string[],
): ReadonlyMap<string, string> {
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const spaces = useStore((state) => state.spaces);
	const layouts = useStore((state) => state.layouts);
	const hidden = useHiddenPanes((state) => state.hidden);
	return useMemo(() => {
		const targets = agentRevealTargets(agentIds, {
			activeSpaceId,
			spaces,
			layouts,
			hidden,
		});
		const names = new Map<string, string>();
		for (const [agentId, { desktopId }] of targets) {
			if (desktopId === activeSpaceId) continue;
			const name = spaces.find((space) => space.id === desktopId)?.name;
			if (name) names.set(agentId, name);
		}
		return names;
	}, [agentIds, activeSpaceId, spaces, layouts, hidden]);
}

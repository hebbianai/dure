// Store wiring for the next-up chip: the list, its shortcut and where each
// row leads. The chip itself only renders what these hooks return; each
// row's own facts come from useAgentRowFacts. A manager's team line reads
// the same order and the same row destinations.
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentRowPlacement } from "@/components/agents/useAgentRowFacts";
import { useNeedsPerson } from "@/components/agents/useNeedsPerson";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	deriveNextUp,
	type NextUp,
	nextUpAgentFacts,
	nextUpEntry,
	nextUpRowPlacement,
} from "@/lib/agents/nextUp";
import { agentRevealTargets, goToNextUp } from "@/lib/agents/nextUpNavigation";
import {
	chordToLabels,
	matchesChord,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

/** `resultsSinceMs`: a surface whose result window is a moment (the Work
 * view's local day) rather than Next up's "not looked at yet". */
export function useNextUp(resultsSinceMs?: number): NextUp {
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
		() => deriveNextUp({ agentIds, needsPerson, ...facts }, resultsSinceMs),
		[agentIds, needsPerson, facts, resultsSinceMs],
	);
}

/** Where one agent stands, for its row: why a person is needed, or a result
 * in the surface's window, as Next up reports it; otherwise its display state
 * alone. Next up's window is results not looked at yet; `resultsSinceMs`
 * lists results since that moment, and only the ones nobody has looked at
 * keep the unread ring. */
export function useAgentAttentionPlacement(
	agentId: string,
	resultsSinceMs?: number,
): AgentRowPlacement {
	const needsPerson = useNeedsPerson();
	const facts = useAgentAttention(
		useShallow((state) => nextUpAgentFacts({ ...state, needsPerson }, agentId)),
	);
	const entry = nextUpEntry(
		agentId,
		facts,
		resultsSinceMs === undefined ? undefined : { sinceMs: resultsSinceMs },
	);
	if (!entry) return facts.state ? { state: facts.state } : {};
	return entry.reason === "result"
		? { ...nextUpRowPlacement(entry), unread: facts.unread }
		: nextUpRowPlacement(entry);
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

/** Where revealing each listed agent lands, read once per change rather than
 * once per row; pass a memoized list. */
export function useAgentRevealTargets(
	agentIds: readonly string[],
): ReturnType<typeof agentRevealTargets> {
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const spaces = useStore((state) => state.spaces);
	const layouts = useStore((state) => state.layouts);
	const hidden = useHiddenPanes((state) => state.hidden);
	return useMemo(
		() =>
			agentRevealTargets(agentIds, {
				activeSpaceId,
				spaces,
				layouts,
				hidden,
			}),
		[agentIds, activeSpaceId, spaces, layouts, hidden],
	);
}

/** The Space each listed agent's row leads to, named only when going there
 * leaves the Space on screen. With `"pane"`, for a list shown in front of
 * the Spaces deck (the Work view): the Space that holds the agent's pane,
 * the active one included, and none for an agent without a pane. Pass a
 * memoized list. */
export function useAgentRevealSpaceNames(
	agentIds: readonly string[],
	named: "elsewhere" | "pane" = "elsewhere",
): ReadonlyMap<string, string> {
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const spaces = useStore((state) => state.spaces);
	const targets = useAgentRevealTargets(agentIds);
	return useMemo(() => {
		const names = new Map<string, string>();
		for (const [agentId, target] of targets) {
			if (
				named === "pane"
					? target.kind !== "pane"
					: target.desktopId === activeSpaceId
			) {
				continue;
			}
			const name = spaces.find((space) => space.id === target.desktopId)?.name;
			if (name) names.set(agentId, name);
		}
		return names;
	}, [targets, activeSpaceId, spaces, named]);
}

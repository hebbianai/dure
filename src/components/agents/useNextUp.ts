// Store wiring for the next-up chip: the list, its shortcut and each row's
// facts. The chip itself only renders what these hooks return.
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	deriveNextUp,
	type NextUp,
	type NextUpEntry,
	nextUpEntries,
} from "@/lib/agents/nextUp";
import { agentRevealTargets, goToNextUp } from "@/lib/agents/nextUpNavigation";
import {
	type ProgramStatusNotice,
	programStatusNotice,
} from "@/lib/agents/programStatus";
import {
	chordToLabels,
	matchesChord,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import {
	namesAgentByRun,
	observedTitle,
	resolveAgentPaneTitle,
} from "@/lib/workspace/pane/paneTitle";
import { useStore } from "@/store";

export function useNextUp(): NextUp {
	const agentIds = useStore(
		useShallow((state) => state.agents.map((agent) => agent.id)),
	);
	const facts = useAgentAttention(
		useShallow((state) => ({
			displayStates: state.displayStates,
			episodes: state.episodes,
			acks: state.acks,
			episodeKinds: state.episodeKinds,
			episodeAt: state.episodeAt,
			waitingSince: state.waitingSince,
		})),
	);
	return useMemo(() => deriveNextUp({ agentIds, ...facts }), [agentIds, facts]);
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

/** The Space each row leads to, named only when going there leaves the Space
 * on screen. Pane locations are read once per change, not once per row. */
export function useNextUpSpaceNames(nextUp: NextUp): ReadonlyMap<string, string> {
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const spaces = useStore((state) => state.spaces);
	const layouts = useStore((state) => state.layouts);
	const hidden = useHiddenPanes((state) => state.hidden);
	return useMemo(() => {
		const targets = agentRevealTargets(
			nextUpEntries(nextUp).map((entry) => entry.agentId),
			{ activeSpaceId, spaces, layouts, hidden },
		);
		const names = new Map<string, string>();
		for (const [agentId, { desktopId }] of targets) {
			if (desktopId === activeSpaceId) continue;
			const name = spaces.find((space) => space.id === desktopId)?.name;
			if (name) names.set(agentId, name);
		}
		return names;
	}, [nextUp, activeSpaceId, spaces, layouts, hidden]);
}

export interface NextUpRowFacts {
	agentId: string;
	title: string;
	projectName?: string;
	/** What the agent's own program reports, for a row Host attention put
	 * here. Finished turns carry none: their report is history. */
	programNotice?: ProgramStatusNotice;
}

export function useNextUpRow(entry: NextUpEntry): NextUpRowFacts | undefined {
	const agent = useStore((state) =>
		state.agents.find((candidate) => candidate.id === entry.agentId),
	);
	const sessionId = agent?.sessionId ?? "";
	const sessionTitle = useStore((state) => state.sessionTitle[sessionId]);
	const sessionCwd = useStore((state) => state.sessionCwd[sessionId]);
	const runtime = useStore((state) => state.sessionAgentRuntimeState[sessionId]);
	const projectName = useStore(
		(state) =>
			state.projects.find((project) => project.id === agent?.projectId)?.name,
	);
	const conversationTitle = useConversationTitle(agent?.id);
	if (!agent) return undefined;
	const programNotice =
		entry.reason !== "finished" && runtime?.lifecycle === "running"
			? programStatusNotice(runtime.programStatus)
			: undefined;
	return {
		agentId: agent.id,
		// The same title authority as the pane header and the Spaces row.
		title: resolveAgentPaneTitle({
			name: agent.name,
			displayName: agent.displayName,
			runtimeTitle:
				conversationTitle ?? observedTitle(sessionTitle, agent.conversationId),
			opaqueConversationId: agent.conversationId,
			directoryCandidates: [sessionCwd, agent.worktreePath],
			runNamed: namesAgentByRun(agent),
		}),
		...(projectName ? { projectName } : {}),
		...(programNotice ? { programNotice } : {}),
	};
}

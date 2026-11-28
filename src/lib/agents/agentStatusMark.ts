// How an agent's display state looks: one table every client draws from.
// The desktop's ActivityDot and AgentActivityGlyph and the phone's session
// rows all read it; agent-status-mark.css turns the data attributes it
// returns into colour and motion, so no surface spells a state's look.

import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** What a state's colour means. Each stylesheet maps it to a status token:
 *  `live` is working (green), `attention` asks for the person (the accent the
 *  Needs you pill uses), `danger` is failure, `rest` is a finished turn and
 *  `neutral` is a state the dot can only report (connecting, exited,
 *  unknown). */
export type AgentStatusTone = "live" | "attention" | "danger" | "rest" | "neutral";

/** `breathe` is the one ongoing motion, for work in progress; `pulse` is a
 *  transition that ends by itself. Reduced motion stills both. */
export type AgentStatusMotion = "breathe" | "pulse" | "still";

export interface AgentStatusMark {
	readonly tone: AgentStatusTone;
	/** Hollow says the session is gone, without colour. */
	readonly fill: "solid" | "hollow";
	readonly motion: AgentStatusMotion;
	/** Whether the mark rides on an agent's glyph as a corner badge. A
	 *  finished turn is the ordinary resting state and draws none. */
	readonly onGlyph: boolean;
}

export const AGENT_STATUS_MARK: Readonly<
	Record<AgentDisplayState, AgentStatusMark>
> = {
	working: { tone: "live", fill: "solid", motion: "breathe", onGlyph: true },
	waiting: { tone: "rest", fill: "solid", motion: "still", onGlyph: false },
	input: { tone: "attention", fill: "solid", motion: "still", onGlyph: true },
	blocked: { tone: "attention", fill: "solid", motion: "still", onGlyph: true },
	error: { tone: "danger", fill: "solid", motion: "still", onGlyph: true },
	connecting: { tone: "neutral", fill: "solid", motion: "pulse", onGlyph: true },
	exited: { tone: "neutral", fill: "hollow", motion: "still", onGlyph: true },
	unknown: { tone: "neutral", fill: "solid", motion: "still", onGlyph: true },
};

/** The attributes an element carries to draw a state's mark with the
 *  shared stylesheet. Spread onto a React element, or set one by one. */
export interface AgentStatusMarkData {
	readonly "data-agent-tone": AgentStatusTone;
	readonly "data-agent-fill": AgentStatusMark["fill"];
	readonly "data-agent-motion": AgentStatusMotion;
}

export function agentStatusMarkData(
	state: AgentDisplayState,
): AgentStatusMarkData {
	const mark = AGENT_STATUS_MARK[state];
	return {
		"data-agent-tone": mark.tone,
		"data-agent-fill": mark.fill,
		"data-agent-motion": mark.motion,
	};
}

import { describe, expect, it } from "vitest";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { AGENT_STATUS_MARK, agentStatusMarkData } from "@/lib/agents/agentStatusMark";

const STATES = Object.keys(AGENT_STATUS_MARK) as AgentDisplayState[];
const statesWhere = (match: (state: AgentDisplayState) => boolean) =>
	STATES.filter(match).sort();

describe("agent status mark", () => {
	it("makes working the one green state and the one that breathes", () => {
		expect(
			statesWhere((state) => AGENT_STATUS_MARK[state].tone === "live"),
		).toEqual(["working"]);
		expect(
			statesWhere((state) => AGENT_STATUS_MARK[state].motion === "breathe"),
		).toEqual(["working"]);
	});

	it("spends the accent only on what waits for the person, and red on failure", () => {
		expect(
			statesWhere((state) => AGENT_STATUS_MARK[state].tone === "attention"),
		).toEqual(["blocked", "input"]);
		expect(
			statesWhere((state) => AGENT_STATUS_MARK[state].tone === "danger"),
		).toEqual(["error"]);
	});

	it("keeps a finished turn quiet, connecting a passing pulse and exited hollow", () => {
		expect(AGENT_STATUS_MARK.waiting).toEqual({
			tone: "rest",
			fill: "solid",
			motion: "still",
			onGlyph: false,
		});
		expect(AGENT_STATUS_MARK.connecting.motion).toBe("pulse");
		expect(
			statesWhere((state) => AGENT_STATUS_MARK[state].fill === "hollow"),
		).toEqual(["exited"]);
		expect(AGENT_STATUS_MARK.unknown.tone).toBe("neutral");
	});

	it("puts every state but the resting one on an agent's glyph", () => {
		expect(statesWhere((state) => !AGENT_STATUS_MARK[state].onGlyph)).toEqual([
			"waiting",
		]);
	});

	it("hands the stylesheet the mark as data attributes", () => {
		expect(agentStatusMarkData("working")).toEqual({
			"data-agent-tone": "live",
			"data-agent-fill": "solid",
			"data-agent-motion": "breathe",
		});
		expect(agentStatusMarkData("exited")).toEqual({
			"data-agent-tone": "neutral",
			"data-agent-fill": "hollow",
			"data-agent-motion": "still",
		});
	});
});

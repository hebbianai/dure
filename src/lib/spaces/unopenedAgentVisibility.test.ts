import { describe, expect, it } from "vitest";
import {
	UNOPENED_AGENT_HIDDEN_LIMIT,
	hideUnopenedAgent,
	isUnopenedAgentHidden,
	normalizeHiddenUnopenedAgents,
	rehydrateHiddenUnopenedAgents,
} from "@/lib/spaces/unopenedAgentVisibility";

describe("unopenedAgentVisibility", () => {
	it("hides the exact observation and reveals on a new attention episode", () => {
		const hidden = hideUnopenedAgent([], { id: "agent-1", episode: 4 });
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 4 }, hidden),
		).toBe(true);
		// 감지 워크트리와 같은 의미 — 새 활동(에피소드 전진)이 행을 되살린다.
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 5 }, hidden),
		).toBe(false);
		expect(
			isUnopenedAgentHidden({ id: "agent-2", episode: 0 }, hidden),
		).toBe(false);
	});

	it("re-hiding replaces the previous observation for the same agent", () => {
		const first = hideUnopenedAgent([], { id: "agent-1", episode: 1 });
		const second = hideUnopenedAgent(first, { id: "agent-1", episode: 3 });
		expect(second).toHaveLength(1);
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 3 }, second),
		).toBe(true);
	});

	it("keeps an agent with no episodes hidden until its first episode", () => {
		const hidden = hideUnopenedAgent([], { id: "agent-1", episode: 0 });
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 0 }, hidden),
		).toBe(true);
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 1 }, hidden),
		).toBe(false);
	});

	it("rehydrates persisted entries with a zero observation — a restart alone is not activity", () => {
		// The attention episode sequence is a per-run volatile counter: an
		// observation persisted by a previous run would swallow this run's first
		// fresh episodes. Rehydration keeps the ids and zeroes the observation.
		const rehydrated = rehydrateHiddenUnopenedAgents([
			{ id: "agent-1", observedEpisode: 9 },
			{ id: "agent-2" },
		]);
		expect(rehydrated).toEqual([
			{ id: "agent-1", observedEpisode: 0 },
			{ id: "agent-2", observedEpisode: 0 },
		]);
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 0 }, rehydrated),
		).toBe(true);
		expect(
			isUnopenedAgentHidden({ id: "agent-1", episode: 1 }, rehydrated),
		).toBe(false);
	});

	it("drops malformed records, dedupes by id keeping the latest, and bounds the list", () => {
		expect(
			normalizeHiddenUnopenedAgents([
				{ id: "", observedEpisode: 1 },
				{ id: 7, observedEpisode: 1 },
				null,
				"agent-1",
				{ id: "agent-1", observedEpisode: 1 },
				{ id: "agent-1", observedEpisode: 6 },
			]),
		).toEqual([{ id: "agent-1", observedEpisode: 6 }]);
		expect(normalizeHiddenUnopenedAgents("nope")).toEqual([]);

		const flood = Array.from(
			{ length: UNOPENED_AGENT_HIDDEN_LIMIT + 8 },
			(_, index) => ({ id: `agent-${index}`, observedEpisode: 0 }),
		);
		expect(normalizeHiddenUnopenedAgents(flood)).toHaveLength(
			UNOPENED_AGENT_HIDDEN_LIMIT,
		);
	});
});

import { describe, expect, it } from "vitest";
import type { Agent, Project } from "@/types";

import {
	agentInProjectNamed,
	parseAgentNameQuery,
	uniqueAgentMatch,
} from "@/lib/agents/agentNameQuery";
import { agentFixture } from "@/test/agentFixtures";

function agent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		name: "fix-main",
		worktreePath: "/repo/worktree",
		branch: "agent/fix-main",
		started: true,
		...patch,
	});
}

describe("parseAgentNameQuery", () => {
	it("splits project/name and trims the raw query", () => {
		expect(parseAgentNameQuery("  repo/fix-main ")).toEqual({
			query: "repo/fix-main",
			projectName: "repo",
			agentName: "fix-main",
		});
	});

	it("keeps a bare or leading-slash query as one agent name", () => {
		expect(parseAgentNameQuery("fix-main")).toEqual({
			query: "fix-main",
			projectName: undefined,
			agentName: "fix-main",
		});
		expect(parseAgentNameQuery("/odd")).toEqual({
			query: "/odd",
			projectName: undefined,
			agentName: "/odd",
		});
	});

	it("rejects an empty query", () => {
		expect(() => parseAgentNameQuery("  ")).toThrowError("name is required");
	});
});

describe("agentInProjectNamed", () => {
	it("matches only the agent's own project by name", () => {
		const projects = [
			{ id: "project-1", name: "repo" },
			{ id: "project-2", name: "other" },
		] as Project[];
		expect(agentInProjectNamed(agent(), "repo", projects)).toBe(true);
		expect(agentInProjectNamed(agent(), "other", projects)).toBe(false);
	});
});

describe("uniqueAgentMatch", () => {
	it("returns the single match", () => {
		const only = agent();
		expect(uniqueAgentMatch([only], "Hmux agent", "fix-main")).toBe(only);
	});

	it("labels not-found and ambiguous errors with the caller surface", () => {
		expect(() => uniqueAgentMatch([], "legacy agent", "ghost")).toThrowError(
			"legacy agent ghost was not found",
		);
		expect(() =>
			uniqueAgentMatch([agent(), agent({ id: "agent-2" })], "Hmux agent", "fix-main"),
		).toThrowError("Hmux agent fix-main is ambiguous; use project/name");
	});
});

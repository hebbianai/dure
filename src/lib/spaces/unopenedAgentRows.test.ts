import { describe, expect, it } from "vitest";
import { resolveUnopenedAgentPresentation } from "@/lib/spaces/unopenedAgentPresentation";
import { agentFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";
import {
	type UnopenedAgentRowsInput,
	unopenedAgentRows,
} from "./unopenedAgentRows";

const project: Project = {
	id: "project-1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const alpha = agentFixture({
	id: "agent-alpha",
	name: "Alpha",
	projectId: "project-1",
	worktreePath: "/repo/.worktrees/alpha",
	branch: "feat/alpha",
});
const beta = agentFixture({
	id: "agent-beta",
	name: "Beta",
	projectId: "project-missing",
	worktreePath: "/elsewhere/beta-tree",
	branch: "feat/beta",
});

function input(
	overrides: Partial<UnopenedAgentRowsInput> = {},
): UnopenedAgentRowsInput {
	return {
		candidates: [alpha, beta],
		projects: [project],
		conversationIndex: new Map(),
		activity: {},
		displayStates: {},
		episodes: {},
		acks: {},
		normalizedQuery: "",
		hidden: [],
		...overrides,
	};
}

describe("unopenedAgentRows", () => {
	it("presents each candidate from its project, presentation and attention", () => {
		const { visible, hiddenCount } = unopenedAgentRows(
			input({
				activity: { "agent-alpha": "connecting" },
				displayStates: { "agent-beta": "blocked" },
				episodes: { "agent-beta": 2 },
				acks: { "agent-beta": 1 },
			}),
		);
		expect(hiddenCount).toBe(0);
		expect(visible.map((row) => row.agent.id)).toEqual([
			"agent-beta",
			"agent-alpha",
		]);
		const [betaRow, alphaRow] = visible;
		expect(alphaRow).toMatchObject({
			displayName: resolveUnopenedAgentPresentation({ agent: alpha }).title,
			sortName: "Alpha",
			state: "connecting",
			unread: false,
			projectName: "Dure",
			detail: "feat/alpha",
		});
		// No registered project: the worktree's last path segment names it.
		expect(betaRow).toMatchObject({
			state: "blocked",
			unread: true,
			projectName: "beta-tree",
		});
	});

	it("presents a candidate nobody has observed as exited", () => {
		const { visible } = unopenedAgentRows(input({ candidates: [alpha] }));
		expect(visible[0]?.state).toBe("exited");
	});

	it("filters by the shared search parts and counts hidden rows only among matches", () => {
		const { visible, hiddenCount } = unopenedAgentRows(
			input({
				normalizedQuery: "feat/alpha",
				hidden: [{ id: "agent-alpha", observedEpisode: 0 }],
			}),
		);
		expect(visible).toEqual([]);
		// Beta does not match the search, so it is neither visible nor hidden.
		expect(hiddenCount).toBe(1);
	});

	it("revives a hidden row once a newer attention episode arrives", () => {
		const hidden = [{ id: "agent-alpha", observedEpisode: 1 }];
		expect(
			unopenedAgentRows(
				input({ hidden, episodes: { "agent-alpha": 1 } }),
			).visible.map((row) => row.agent.id),
		).toEqual(["agent-beta"]);
		expect(
			unopenedAgentRows(
				input({ hidden, episodes: { "agent-alpha": 2 } }),
			).visible.map((row) => row.agent.id),
		).toEqual(["agent-alpha", "agent-beta"]);
	});

	it("orders unread first, then by display rank, then by the stable name", () => {
		const gamma = agentFixture({
			id: "agent-gamma",
			name: "Gamma",
			projectId: "project-1",
			worktreePath: "/repo/.worktrees/gamma",
		});
		const { visible } = unopenedAgentRows(
			input({
				candidates: [gamma, beta, alpha],
				displayStates: {
					"agent-alpha": "working",
					"agent-beta": "waiting",
					"agent-gamma": "working",
				},
				episodes: { "agent-beta": 1 },
			}),
		);
		expect(visible.map((row) => row.agent.id)).toEqual([
			"agent-beta",
			"agent-alpha",
			"agent-gamma",
		]);
	});
});

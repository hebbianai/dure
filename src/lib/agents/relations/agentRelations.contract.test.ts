// Coverage contract: every surface that says who manages whom reads the one
// relation owner, so Spaces' lead nesting, worker pane placement, the row
// paths and a manager's team line cannot disagree about an agent's manager,
// whether that is an Agent or a plain shell row.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "..");

function source(path: string): string {
	return readFileSync(join(SRC, path), "utf8");
}

function* sources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) yield* sources(full);
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
	}
}

describe("relation coverage", () => {
	it("resolves Run-parent leads only inside the relation facts", () => {
		const outside = [...sources(SRC)]
			.map((file) => relative(SRC, file))
			.filter(
				(file) =>
					file !== join("lib", "agents", "agentRunParent.ts") &&
					file !== join("lib", "agents", "relations", "agentRelationFacts.ts"),
			)
			.filter((file) =>
				/createAgentRunLeadsResolver|createAgentRunLeadResolver/.test(
					source(file),
				),
			);
		expect(outside).toEqual([]);
	});

	it("routes every surface that names a manager through the owner", () => {
		expect(source("components/spaces/useSpaces.ts")).toContain(
			"relations.managerOf(relationKey)",
		);
		expect(source("lib/workspace/dock/workerColumnPlacement.ts")).toContain(
			"relations.managerOf(worker.id)",
		);
		const rowFacts = source("components/agents/useAgentRowFacts.ts");
		expect(rowFacts).toContain("relations.chain(agentId, below)");
		expect(rowFacts).toContain("useAgentManagedSummary(agentId)");
		expect(source("components/agents/AgentManagedFold.tsx")).toContain(
			"useAgentManagedSummary(agentId)",
		);
		const teamLine = source("components/agents/AgentTeamLine.tsx");
		expect(teamLine).toContain("useAgentRelations()");
		expect(teamLine).toContain("agentTeamMembers(");
		// The manager the phone is told about, and the forest it builds from it.
		expect(source("components/hub/useHubSidebarLayout.ts")).toContain(
			"relations.managerOf(agentId)",
		);
		// Every reader outside React takes the store's facts, shells included.
		expect(source("lib/agents/agentAttentionNotifier.ts")).toContain(
			"agentRelationsOfState(useStore.getState())",
		);
		expect(source("lib/workspace/dock.ts")).toContain(
			"agentRelationFactsOf(useStore.getState())",
		);
		expect(source("../mobile/src/homeRelations.ts")).toContain(
			"buildAgentRelations(nodes, edges)",
		);
	});
});

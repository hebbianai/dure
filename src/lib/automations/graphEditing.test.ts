import { describe, expect, it } from "vitest";
import { parseDefinition, parseWorkflowRunSummary } from "./graphContract";
import {
	dailyReviewWorkflow,
	defaultPositions,
	dependencyEdges,
	removeNode,
	updateNode,
} from "./graphEditing";
import { normalizeGraphLayouts } from "./graphPresentation";

const template = () =>
	dailyReviewWorkflow(
		{
			name: "Review",
			collect: "Changes",
			review: "Review",
			prompt: "Review changes",
		},
		"UTC",
		"project",
	);

describe("graph editing", () => {
	it("keeps a missing source visible after deletion, including through save and reopen", () => {
		const edited = removeNode(template().definition, "collect");
		const reopened = parseDefinition(JSON.parse(JSON.stringify(edited)));
		expect(reopened.nodes[0].inputs.input).toEqual({
			kind: "output",
			nodeId: "collect",
			field: "stdout",
		});
		expect(dependencyEdges(reopened)).toEqual([
			{ source: "collect", target: "review", mapped: true },
		]);
	});
	it("renames a step without changing its consumers or putting layout in execution data", () => {
		const definition = template().definition;
		const edited = updateNode(definition, "collect", { name: "New label" });
		expect(edited.nodes[1].inputs).toEqual(definition.nodes[1].inputs);
		const original = JSON.stringify(edited);
		const positions = defaultPositions(edited);
		positions.collect = { x: 500, y: 800 };
		expect(JSON.stringify(edited)).toBe(original);
		expect(
			normalizeGraphLayouts({
				saved: positions,
				corrupt: { collect: { x: Number.NaN, y: 0 } },
			}),
		).toEqual({ saved: positions, corrupt: {} });
	});
	it("retains a typed Daily review mapping without selecting credentials or a provider", () => {
		const draft = template();
		expect(draft.trigger).toEqual({
			kind: "schedule",
			expression: "0 9 * * *",
			timezone: "UTC",
		});
		expect(draft.definition.nodes[1].inputs.providerId).toBeUndefined();
		expect(draft.definition.nodes[1].inputs.executionProfile).toBeUndefined();
		expect(parseDefinition(draft.definition)).toEqual(draft.definition);
	});
	it("rejects corrupt identities and unknown execution states at the response boundary", () => {
		const definition = template().definition;
		definition.nodes.push(definition.nodes[0]);
		expect(() => parseDefinition(definition)).toThrow(
			"workflow_response_invalid",
		);
		expect(() =>
			parseWorkflowRunSummary({ schemaVersion: 1, status: "success" }),
		).toThrow("workflow_response_invalid");
	});
});

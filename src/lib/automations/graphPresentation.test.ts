import { applyNodeChanges } from "@xyflow/react";
import { expect, it } from "vitest";
import { dailyReviewWorkflow } from "./graphEditing";
import { projectGraphNodes } from "./graphPresentation";

it("retains React Flow measurements and node identities across equivalent Run refreshes", () => {
	const draft = dailyReviewWorkflow(
		{
			name: "Daily review",
			collect: "Collect",
			review: "Review",
			prompt: "Review",
		},
		"UTC",
	);
	const initial = projectGraphNodes(
		[],
		draft.definition,
		"collect",
		{},
		[],
		[],
	);
	const measured = applyNodeChanges(
		[
			{
				type: "dimensions",
				id: "collect",
				dimensions: { width: 208, height: 102 },
			},
			{
				type: "dimensions",
				id: "review",
				dimensions: { width: 208, height: 102 },
			},
		],
		initial,
	);
	const refreshed = projectGraphNodes(
		measured,
		structuredClone(draft.definition),
		"collect",
		{},
		[],
		[],
	);
	expect(refreshed).toBe(measured);
	const renamed = structuredClone(draft.definition);
	renamed.nodes[0].name = "Updated label";
	const changed = projectGraphNodes(refreshed, renamed, "review", {}, [], []);
	expect(changed[0].data.name).toBe("Updated label");
	expect(changed.map((node) => node.measured)).toEqual([
		{ width: 208, height: 102 },
		{ width: 208, height: 102 },
	]);
	expect(draft.definition.nodes[0].name).toBe("Collect");
});

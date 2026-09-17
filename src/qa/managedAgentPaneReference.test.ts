// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	managedAgentPaneReferenceCases,
	probeManagedAgentPaneReference,
} from "./managedAgentPaneReference";

describe.each([false, true])("exact pane constraint = %s", (exact) => {
	it.each(managedAgentPaneReferenceCases)(
		"resolves %s Agent presentation without using the pane ID as content",
		async (scenario) => {
			await expect(
				probeManagedAgentPaneReference(scenario, exact),
			).resolves.toMatchObject({
				scenario,
				preserved: true,
			});
		},
	);
});

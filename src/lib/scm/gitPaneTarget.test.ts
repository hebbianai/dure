import { describe, expect, it } from "vitest";
import { gitProjectIdFromPane } from "./gitPaneTarget";

describe("gitProjectIdFromPane", () => {
	it.each(["pane-one", "git:old", "agent:former"])(
		"reads the current project at %s",
		(id) => {
			const pane = { id, component: "git", params: { projectId: "current" } };
			expect(gitProjectIdFromPane(pane)).toBe("current");
		},
	);
	it.each([undefined, null, "", 123, [], {}])(
		"does not infer a malformed explicit project %j",
		(projectId) => {
			const pane = {
				id: "git:former",
				component: "git",
				params: { projectId },
			};
			expect(gitProjectIdFromPane(pane)).toBeUndefined();
		},
	);
	it.each([undefined, "terminal", "github", "future-content"])(
		"does not reinterpret %s content as Git",
		(component) => {
			const pane = {
				id: "git:former",
				component,
				params: { projectId: "former" },
			};
			expect(gitProjectIdFromPane(pane)).toBeUndefined();
		},
	);
});

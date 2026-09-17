import { describe, expect, it } from "vitest";
import { agentIdFromPane } from "./agentPaneParameters";
import { normalizePersistedPaneLayout } from "./persistedPaneLayout";

describe("explicit Agent pane references", () => {
	it.each([undefined, {}, { agentId: "copied-target" }])(
		"does not derive a mounted target from a historical pane ID with parameters %j",
		(params) => {
			expect(
				agentIdFromPane({ id: "agent:old-target", component: "agent", params }),
			).toBeUndefined();
		},
	);

	it.each(["pane-neutral", "agent:old-target", "terminal:old-target"])(
		"reads the current reference independently of %s",
		(id) => {
			expect(
				agentIdFromPane({
					id,
					component: "agent",
					params: { agentRef: { agentId: "current-target" } },
				}),
			).toBe("current-target");
		},
	);

	it.each([null, {}, { agentId: "" }, { agentId: 7 }])(
		"does not replace malformed explicit reference %j with a historical target",
		(agentRef) => {
			expect(
				agentIdFromPane({
					id: "agent:old-target",
					component: "agent",
					params: { agentRef },
				}),
			).toBeUndefined();
		},
	);

	it("keeps legacy compatibility at saved-layout ingress without renaming the pane", () => {
		const original = {
			panels: {
				"agent:old-target": {
					id: "agent:old-target",
					contentComponent: "agent",
					params: { agentId: "untrusted-copy" },
				},
			},
		};
		const restored = normalizePersistedPaneLayout(original) as typeof original;
		const panel = restored.panels["agent:old-target"];
		expect(panel.id).toBe("agent:old-target");
		expect(panel.params).toEqual({ agentRef: { agentId: "old-target" } });
		expect(
			agentIdFromPane({ ...panel, component: panel.contentComponent }),
		).toBe("old-target");
		expect(original.panels["agent:old-target"].params).toEqual({
			agentId: "untrusted-copy",
		});
		expect(normalizePersistedPaneLayout(restored)).toBe(restored);
	});
});

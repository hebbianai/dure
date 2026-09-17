// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import {
	dockPanelParameters,
	dockPanelReference,
} from "@/lib/workspace/dock/dockPanelParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

describe("dockPanelParameters", () => {
	it("reads current content and merged Agent references from real Dockview before and after restore", () => {
		const create = () =>
			createDockview(document.createElement("div"), {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
		const api = create();
		const restored = create();
		try {
			api.layout(1000, 700);
			restored.layout(1000, 700);
			const first = agentFixture({
				id: "first",
				runtimeBinding: managedBindingFixture({ sessionId: "first-session" }),
			});
			const second = agentFixture({
				id: "second",
				runtimeBinding: managedBindingFixture({ sessionId: "second-session" }),
			});
			const pane = api.addPanel({
				id: "launcher:unchanged",
				component: "agent",
				params: { agentRef: { agentId: first.id } },
			});
			const read = () =>
				bindingFromPane(dockPanelReference(pane), [first, second], []);
			expect(read()).toEqual(first.runtimeBinding);
			pane.api.updateParameters({ agentRef: { agentId: second.id } });
			expect(read()).toEqual(second.runtimeBinding);
			expect(pane.id).toBe("launcher:unchanged");
			const saved = JSON.parse(JSON.stringify(api.toJSON()));
			restored.fromJSON(JSON.parse(JSON.stringify(saved)));
			const restoredPane = restored.getPanel(pane.id)!;
			expect(dockPanelReference(restoredPane)).toEqual(
				panelsFromLayout(saved)[0],
			);
			expect(
				bindingFromPane(dockPanelReference(restoredPane), [first, second], []),
			).toEqual(second.runtimeBinding);
			pane.api.updateParameters({ agentRef: null });
			expect(read()).toBeUndefined();
			expect(restored.toJSON()).toEqual(saved);
		} finally {
			api.dispose();
			restored.dispose();
		}
	});

	it("reads canonical initial params when PanelApi has not been seeded", () => {
		const params = { sessionId: "standalone-1", binding: { runtime: "hmux" } };

		expect(
			dockPanelParameters({
				params,
				api: { getParameters: () => ({}) },
			}),
		).toBe(params);
	});

	it("falls back to PanelApi for panels without model params", () => {
		const params = { sessionId: "updated-session" };

		expect(
			dockPanelParameters({
				api: { getParameters: () => params },
			}),
		).toBe(params);
	});

	it("rejects non-record parameter values", () => {
		expect(
			dockPanelParameters({
				params: [],
				api: { getParameters: () => null },
			}),
		).toEqual({});
	});
});

// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { agentFixture } from "@/test/agentFixtures";
import {
	type FocusContext,
	focusContextForPane,
	sameFocusContext,
} from "./focusContext";

const context: FocusContext = {
	key: "term:one",
	cwd: "/work/repo",
	source: "local",
	label: "repo",
};

describe("sameFocusContext", () => {
	it("compares semantic fields instead of object identity", () => {
		expect(sameFocusContext(context, { ...context })).toBe(true);
		expect(sameFocusContext(context, { ...context, key: "term:two" })).toBe(
			false,
		);
		expect(sameFocusContext(context, null)).toBe(false);
		expect(sameFocusContext(null, null)).toBe(true);
	});
	it("observes a target change within the same pane and working directory", () => {
		expect(
			sameFocusContext(
				{ ...context, agentId: "previous" },
				{ ...context, agentId: "current" },
			),
		).toBe(false);
	});
});

describe.each(["slot", "agent:previous", "launcher:previous"])(
	"focus context in %s",
	(id) => {
		it("reads live and restored Agent references and observes retargeting in place", () => {
			const element = document.createElement("div");
			document.body.append(element);
			const api = createDockview(element, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			const current = agentFixture({
				id: "current",
				projectId: "project",
				worktreePath: "/outside",
			});
			const other = agentFixture({
				id: "other",
				projectId: "other-project",
				worktreePath: "/outside",
			});
			const state = { agents: [current, other], projects: [], sessionCwd: {} };
			const read = () =>
				focusContextForPane(
					dockPanelReference(api.getPanel(id)!),
					state,
					() => ({ kind: "local" }),
					"Terminal",
				);
			try {
				api.layout(900, 600);
				api.addPanel({
					id,
					component: "agent",
					params: { agentRef: { agentId: current.id } },
				});
				expect(read()).toMatchObject({
					key: id,
					agentId: current.id,
					cwd: "/outside",
				});
				api.fromJSON(JSON.parse(JSON.stringify(api.toJSON())));
				expect(read()?.agentId).toBe(current.id);
				const panel = api.getPanel(id)!;
				const previous = read();
				panel.api.updateParameters({ agentRef: { agentId: other.id } });
				expect(api.getPanel(id)).toBe(panel);
				expect(read()?.agentId).toBe(other.id);
				expect(sameFocusContext(previous, read())).toBe(false);
				panel.api.updateParameters({
					agentRef: null,
					sessionId: "copied",
					cwd: "/copied",
				});
				expect(read()).toBeNull();
			} finally {
				api.dispose();
				element.remove();
			}
		});
		it.each(["terminal", "ssh"])(
			"uses the %s content's cwd and location, not an old Agent alias",
			(component) => {
				const state = {
					agents: [agentFixture({ id: "previous" })],
					projects: [],
					sessionCwd: { runtime: "/observed/folder" },
				};
				const pane = {
					id,
					component,
					params: {
						sessionId: "runtime",
						cwd: "/stale",
						hostId: "host",
						agentRef: { agentId: "previous" },
					},
				};
				expect(
					focusContextForPane(
						pane,
						state,
						() => ({ kind: "local" }),
						"Terminal",
					),
				).toEqual({
					key: id,
					cwd: "/observed/folder",
					source: component === "ssh" ? "ssh" : "local",
					label: "folder",
					...(component === "ssh" ? { hostId: "host" } : {}),
				});
			},
		);
		it("keeps nested SSH observation and missing-folder labels independent of ID shape", () => {
			const pane = {
				id,
				component: "terminal",
				params: { sessionId: "runtime" },
			};
			const state = { agents: [], projects: [], sessionCwd: {} };
			expect(
				focusContextForPane(
					pane,
					state,
					() => ({ kind: "ssh", target: "remote" }),
					"Terminal",
				),
			).toEqual({ key: id, cwd: "", source: "ssh", label: "remote" });
			expect(
				focusContextForPane(pane, state, () => ({ kind: "local" }), "Terminal"),
			).toEqual({ key: id, cwd: "", source: "local", label: "Terminal" });
		});
	},
);

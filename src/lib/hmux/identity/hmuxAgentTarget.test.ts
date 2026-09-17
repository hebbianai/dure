import { beforeEach, expect, expectTypeOf, it } from "vitest";
import {
	type HmuxAgentTarget,
	resolveHmuxAgentTarget,
} from "@/lib/hmux/identity/hmuxAgentTarget";
import {
	resolveLegacyAgentPaneTarget,
	resolveManagedAgentTarget,
} from "@/lib/sessions/managed/managedAgentTarget";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(id: string, displayName: string): Agent {
	return agentFixture({
		id,
		name: `canonical-${id}`,
		displayName,
		worktreePath: `/repo/${id}`,
		branch: `agent/${id}`,
		sessionId: `session-${id}`,
		runtimeBinding: managedBindingFixture({ sessionId: `session-${id}` }),
	});
}

beforeEach(() => {
	useStore.setState({ agents: [], projects: [], layouts: {} });
});

const runtimeBindings: NonNullable<Agent["runtimeBinding"]>[] = [
	managedBindingFixture({ sessionId: "session-one" }),
	{
		schemaVersion: 1,
		runtime: "hmux_standalone_v1",
		source: "local",
		hostId: "local",
		sessionId: "session-one",
		workspaceId: "workspace-one",
	},
	{
		...managedBindingFixture({ sessionId: "session-one" }),
		source: "ssh",
		hostId: "remote",
		commandBridgeNonce: "bridge",
		createIdempotencyKey: "create-one",
	},
];

it.each(runtimeBindings)(
	"resolves $source $runtime without a pane",
	(binding) => {
		const target = agent("one", "fix-main");
		target.runtimeBinding = binding;
		useStore.setState({ agents: [target] });
		expect(resolveHmuxAgentTarget("one")).toMatchObject({
			agent: target,
			binding,
		});
		if (binding.runtime === "hmux_managed_v1" && binding.source === "local") {
			expect(resolveManagedAgentTarget("one")).toEqual({
				agent: target,
				binding,
			});
		} else {
			expect(() => resolveManagedAgentTarget("one")).toThrowError(
				expect.objectContaining({ code: "invalid_request" }),
			);
		}
	},
);

it.each(["one", "session-one", "canonical-one", "fix-main"])(
	"preserves the selected Agent when addressed as %s",
	(query) => {
		const target = agent("one", "fix-main");
		useStore.setState({ agents: [target, agent("two", "unrelated")] });
		expect(resolveHmuxAgentTarget(query)).toMatchObject({
			agent: target,
			binding: target.runtimeBinding,
		});
		expect(resolveManagedAgentTarget(query)).toEqual({
			agent: target,
			binding: target.runtimeBinding,
		});
	},
);

it.each([undefined, "agent:one"])(
	"keeps legacy pane metadata in the compatibility adapter for %s",
	(panelId) => {
		const target = agent("one", "fix-main");
		useStore.setState({ agents: [target] });
		expect(resolveManagedAgentTarget("one")).toEqual({
			agent: target,
			binding: target.runtimeBinding,
		});
		expect(resolveLegacyAgentPaneTarget(target, panelId)).toEqual({
			agent: target,
			panelId: "agent:one",
		});
	},
);

it.each(["pane-neutral", "launcher:old", "agent:two"])(
	"does not silently discard the legacy managed target constraint %s",
	(panelId) => {
		useStore.setState({ agents: [agent("one", "fix-main")] });
		expect(() => resolveLegacyAgentPaneTarget("one", panelId)).toThrowError(
			expect.objectContaining({ code: "pane_changed" }),
		);
	},
);

it.each(["runtime", "managed"])(
	"refuses a missing or mismatched runtime in %s selection",
	(kind) => {
		const resolve =
			kind === "runtime" ? resolveHmuxAgentTarget : resolveManagedAgentTarget;
		for (const runtimeBinding of [
			undefined,
			managedBindingFixture({ sessionId: "replaced-session" }),
		]) {
			useStore.setState({
				agents: [{ ...agent("one", "fix-main"), runtimeBinding }],
			});
			expect(() => resolve("one")).toThrowError(
				expect.objectContaining({ code: "invalid_request" }),
			);
		}
	},
);

it("does not select a replacement pane's content as the runtime recipient", () => {
	const target = agent("one", "fix-main");
	useStore.setState({
		agents: [target],
		layouts: {
			space: {
				panels: {
					"agent:one": {
						id: "agent:one",
						contentComponent: "terminal",
						params: { agentRef: { agentId: "two" } },
					},
				},
			},
		},
	});
	expect(resolveHmuxAgentTarget("one")).toMatchObject({
		agent: target,
		binding: target.runtimeBinding,
	});
});

it("resolves the visible pane title to one exact managed binding", () => {
	const target = agent("one", "fix-main");
	useStore.setState({ agents: [target] });

	expect(resolveHmuxAgentTarget("fix-main")).toEqual({
		agent: target,
		binding: target.runtimeBinding,
	});
});

it("does not expose a pane alias in the runtime-only target contract", () => {
	expectTypeOf<keyof HmuxAgentTarget>().toEqualTypeOf<"agent" | "binding">();
	expectTypeOf<typeof resolveHmuxAgentTarget>().parameters.toEqualTypeOf<
		[string]
	>();
	useStore.setState({ agents: [agent("one", "fix-main")] });
	expect(resolveHmuxAgentTarget("one")).not.toHaveProperty("panelId");
});

it("refuses an ambiguous visible pane title", () => {
	useStore.setState({
		agents: [agent("one", "fix-main"), agent("two", "fix-main")],
	});

	expect(() => resolveHmuxAgentTarget("fix-main")).toThrow(
		"Hmux agent fix-main is ambiguous",
	);
});

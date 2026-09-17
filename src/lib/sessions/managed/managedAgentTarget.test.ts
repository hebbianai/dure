import { beforeEach, expect, expectTypeOf, it } from "vitest";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import {
	type ManagedAgentTarget,
	resolveLegacyAgentPaneTarget,
	resolveManagedAgentTarget,
} from "./managedAgentTarget";

const binding = managedBindingFixture({ stopFence: stopFenceFixture() });
const agent = managedAgentFixture({ name: "worker", runtimeBinding: binding });

beforeEach(() => useStore.setState({ agents: [agent], projects: [] }));

it("keeps pane display metadata out of the managed runtime target", () => {
	expectTypeOf<keyof ManagedAgentTarget>().toEqualTypeOf<"agent" | "binding">();
	expectTypeOf<Parameters<typeof resolveManagedAgentTarget>>().toEqualTypeOf<
		[name: string]
	>();
	expect(resolveManagedAgentTarget("worker")).not.toHaveProperty("panelId");
});

it.each([agent.id, agent.name, agent.sessionId])(
	"resolves %s to the existing Agent and exact managed binding",
	(name) => {
		const target = resolveManagedAgentTarget(name);
		expect(target.agent).toBe(agent);
		expect(target.binding).toEqual(binding);
	},
);

it("accepts the existing explicit alias without changing the runtime recipient", () => {
	expect(resolveLegacyAgentPaneTarget("worker", "agent:agent-1")).toMatchObject(
		{
			agent,
			panelId: "agent:agent-1",
		},
	);
});

it("refuses a mismatching explicit alias before binding admission", () => {
	useStore.setState({ agents: [{ ...agent, sessionId: "changed-session" }] });
	expect(() =>
		resolveLegacyAgentPaneTarget("worker", "agent:someone-else"),
	).toThrowError(expect.objectContaining({ code: "pane_changed" }));
});

it("refuses a binding from a different runtime session", () => {
	useStore.setState({ agents: [{ ...agent, sessionId: "changed-session" }] });
	expect(() => resolveManagedAgentTarget("worker")).toThrowError(
		expect.objectContaining({ code: "invalid_request" }),
	);
});

it("does not admit a remote runtime through the local target", () => {
	useStore.setState({
		agents: [
			{
				...agent,
				runtimeBinding: {
					...binding,
					source: "ssh",
					hostId: "remote",
					createIdempotencyKey: "create-remote",
					commandBridgeNonce: "bridge-remote",
				},
			},
		],
	});
	expect(() => resolveManagedAgentTarget("worker")).toThrowError(
		expect.objectContaining({ code: "invalid_request" }),
	);
});

it("does not admit a standalone runtime through the managed target", () => {
	useStore.setState({
		agents: [
			{
				...agent,
				runtimeBinding: { ...binding, runtime: "hmux_standalone_v1" },
			},
		],
	});
	expect(() => resolveManagedAgentTarget("worker")).toThrowError(
		expect.objectContaining({ code: "invalid_request" }),
	);
});

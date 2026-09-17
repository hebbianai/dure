import { describe, expect, it } from "vitest";
import { managedAgentFreshStartIdentity } from "@/lib/sessions/managed/managedAgentFreshStartIdentity";
import { stopFenceFixture } from "@/test/agentFixtures";

const source = {
	agentId: "agent-1",
	sourceSessionId: "session-exited",
	workspaceId: "workspace-1",
	sourceCreateIdempotencyKey: "spawn-agent-1",
};

const sourceStopFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
});

describe("managed fresh-start identity", () => {
	it("reuses one backend operation for every retry of the same tombstone", () => {
		const first = managedAgentFreshStartIdentity(source);
		const retry = managedAgentFreshStartIdentity({ ...source });

		expect(retry).toEqual(first);
		expect(first).toEqual({
			recoveryId: "fresh_ea64ba72e6ed4ca5",
		});
	});

	it("allocates a new operation after the Agent is bound to a new source", () => {
		expect(
			managedAgentFreshStartIdentity({
				...source,
				sourceSessionId: "session-successor",
			}),
		).not.toEqual(managedAgentFreshStartIdentity(source));
	});

	it("separates equal session labels in different workspaces", () => {
		expect(
			managedAgentFreshStartIdentity({
				...source,
				workspaceId: "workspace-2",
			}),
		).not.toEqual(managedAgentFreshStartIdentity(source));
	});

	it("binds a running fresh replacement to its target credential", () => {
		const crispy = managedAgentFreshStartIdentity({
			...source,
			operationKey: "credential-switch:account-crispy",
		});
		const canonical = managedAgentFreshStartIdentity({
			...source,
			operationKey: "credential-switch:runtime-default",
		});

		expect(crispy).not.toEqual(canonical);
		expect(
			managedAgentFreshStartIdentity({
				...source,
				operationKey: "credential-switch:account-crispy",
			}),
		).toEqual(crispy);
	});

	it("reuses the journal operation when a retry carries a changed source fence", () => {
		const firstRequest = {
			...source,
			sourceStopFence,
		};
		const successorRequest = {
			...source,
			sourceStopFence: {
				...sourceStopFence,
				terminalEpoch: "terminal-2",
			},
		};
		const first = managedAgentFreshStartIdentity(firstRequest);
		const successor = managedAgentFreshStartIdentity(successorRequest);

		expect(successor).toEqual(first);
	});
});

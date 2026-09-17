import { describe, expect, it } from "vitest";
import {
	agentRemovalRegistrationIdentity,
	parseManagedAgentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

function agent() {
	return agentFixture({
		id: "agent-removal",
		worktreePath: "/repo/.worktrees/agent-removal",
		sessionId: "session-removal",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-removal",
			workspaceId: "workspace-removal",
		}),
	});
}

describe("Agent removal registration identity", () => {
	it("parses one boundary identity and rejects malformed variants", () => {
		const identity = agentRemovalRegistrationIdentity(agent());

		expect(parseManagedAgentRemovalRegistrationIdentity(identity)).toEqual(
			identity,
		);
		expect(
			parseManagedAgentRemovalRegistrationIdentity({
				...identity,
				provider: "unknown-provider",
			}),
		).toBeUndefined();
		expect(
			parseManagedAgentRemovalRegistrationIdentity({
				...identity,
				interactionSessionId: "orphan-interaction",
			}),
		).toBeUndefined();
	});

	it("ignores presentation-only changes", () => {
		const original = agent();
		const identity = agentRemovalRegistrationIdentity(original);

		expect(
			sameAgentRemovalTarget(
				{ ...original, displayName: "A clearer name", branch: "renamed" },
				identity,
			),
		).toBe(true);
	});

	it("rejects a replacement runtime generation", () => {
		const original = agent();
		const identity = agentRemovalRegistrationIdentity(original);
		const replacement = {
			...original,
			sessionId: "session-replacement",
			runtimeBinding: managedBindingFixture({
				sessionId: "session-replacement",
				workspaceId: "workspace-replacement",
			}),
		};

		expect(sameAgentRemovalTarget(replacement, identity)).toBe(false);
	});

	it("rejects a same-session successor with different canonical provenance", () => {
		const original = {
			...agent(),
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-source",
			},
		};
		const identity = agentRemovalRegistrationIdentity(original);
		const successor = {
			...original,
			canonicalSpawn: {
				...original.canonicalSpawn,
				operationId: "spawn-successor",
			},
		};

		expect(sameAgentRemovalTarget(successor, identity)).toBe(false);
	});

	it("accepts a refreshed local process generation for the same session", () => {
		const original = agentFixture({
			runtimeBinding: managedBindingFixture({
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-old" }),
			}),
		});
		const identity = agentRemovalRegistrationIdentity(original);
		const refreshed = {
			...original,
			runtimeBinding: managedBindingFixture({
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-current" }),
			}),
		};

		expect(sameAgentRemovalTarget(refreshed, identity)).toBe(true);
		expect(sameAgentRemovalProjection(refreshed, identity)).toBe(false);
	});

	it("rejects a local credential-generation successor", () => {
		const binding = {
			...managedBindingFixture(),
			credentialId: "credential-1",
			credentialGeneration: 1,
		};
		const original = agentFixture({
			runtimeBinding: binding,
		});
		const identity = agentRemovalRegistrationIdentity(original);
		const replacement = {
			...original,
			runtimeBinding: {
				...binding,
				credentialGeneration: 2,
			},
		};

		expect(sameAgentRemovalTarget(replacement, identity)).toBe(false);
	});

	it("rejects a remote credential-profile successor", () => {
		const binding = {
			schemaVersion: 1 as const,
			runtime: "hmux_managed_v1" as const,
			source: "ssh" as const,
			hostId: "host-1",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			commandBridgeNonce: "bridge-1",
			credentialId: "credential-1",
			credentialProfileDirectory: ".dure/accounts/one",
			stopFence: stopFenceFixture(),
		};
		const original = agentFixture({
			sessionKind: "ssh",
			runtimeBinding: binding,
		});
		const identity = agentRemovalRegistrationIdentity(original);
		const replacement = {
			...original,
			runtimeBinding: {
				...binding,
				credentialProfileDirectory: ".dure/accounts/two",
			},
		};

		expect(sameAgentRemovalTarget(replacement, identity)).toBe(false);
	});

	it("is reflexive for an accepted raw path that still needs Host resolution", () => {
		const original = agentFixture({ worktreePath: "/repo/./worktree" });

		expect(
			sameAgentRemovalTarget(
				original,
				agentRemovalRegistrationIdentity(original),
			),
		).toBe(true);
	});

	it("accepts an equivalent Windows worktree spelling", () => {
		const original = agentFixture({ worktreePath: "C:\\Repo\\worktree" });
		const identity = agentRemovalRegistrationIdentity(original);

		expect(
			sameAgentRemovalTarget(
				{ ...original, worktreePath: "c:/repo/worktree/" },
				identity,
			),
		).toBe(true);
	});

	it("rejects a changed remote command bridge generation", () => {
		const original = agentFixture({
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_standalone_v1",
				source: "ssh",
				hostId: "host-1",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				commandBridgeNonce: "bridge-1",
			} as unknown as ReturnType<typeof agent>["runtimeBinding"],
		});
		const identity = agentRemovalRegistrationIdentity(original);
		const replacement = {
			...original,
			runtimeBinding: {
				...original.runtimeBinding,
				commandBridgeNonce: "bridge-2",
			} as unknown as ReturnType<typeof agent>["runtimeBinding"],
		};

		expect(sameAgentRemovalTarget(replacement, identity)).toBe(false);
	});
});

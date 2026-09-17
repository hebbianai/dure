import { beforeEach, describe, expect, it } from "vitest";
import {
	resolveHmuxExactInputTarget,
	revalidateHmuxExactInputTarget,
} from "@/lib/hmux/identity/hmuxExactInputTarget";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-exact",
		name: "codex-exact",
		worktreePath: "/repo/worktree",
		branch: "agent/exact",
		sessionId: "session-exact",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-exact",
			workspaceId: "workspace-exact",
		}),
		...patch,
	});
}

function identity(patch: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		targetPanelId: "agent:agent-exact",
		hostId: "local",
		sessionId: "session-exact",
		workspaceId: "workspace-exact",
		...patch,
	};
}

beforeEach(() => {
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "HebbianIDE",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [agent()],
	});
});

describe("exact Hmux input identity", () => {
	it("resolves only the immutable Agent pane and complete Hmux binding", () => {
		expect(resolveHmuxExactInputTarget(identity())).toMatchObject({
			identity: identity(),
			agent: { id: "agent-exact" },
			binding: {
				hostId: "local",
				sessionId: "session-exact",
				workspaceId: "workspace-exact",
			},
		});
	});

	it.each([
		undefined,
		{},
		{ ...identity(), schemaVersion: 2 },
		{ ...identity(), displayName: "codex-exact" },
		{ ...identity(), targetPanelId: "codex-exact" },
	])("rejects a non-v1 or display-name target: %j", (target) => {
		expect(() => resolveHmuxExactInputTarget(target)).toThrowError(
			expect.objectContaining({ code: "invalid_request" }),
		);
	});

	it.each([
		{ hostId: "other" },
		{ sessionId: "other" },
		{ workspaceId: "other" },
		{ targetPanelId: "agent:other" },
	])("fails closed when one exact identity component is stale: %j", (patch) => {
		expect(() => resolveHmuxExactInputTarget(identity(patch))).toThrowError(
			expect.objectContaining({
				code: patch.targetPanelId ? "pane_not_found" : "pane_changed",
			}),
		);
	});

	it("accepts an exact SSH managed binding without weakening its host identity", () => {
		useStore.setState({
			agents: [
				agent({
					sessionKind: "ssh",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: "host-remote",
						sessionId: "session-exact",
						workspaceId: "workspace-exact",
						createIdempotencyKey: "create-exact",
						commandBridgeNonce: "bridge-remote",
					},
				}),
			],
		});

		expect(
			resolveHmuxExactInputTarget(identity({ hostId: "host-remote" })),
		).toMatchObject({
			binding: { source: "ssh", hostId: "host-remote" },
		});
	});
});

it.each([
	"runnerPrincipal",
	"runnerInstance",
	"channelEpoch",
	"hostInstanceId",
	"terminalEpoch",
] as const)("retains the prepared managed generation field %s", (field) => {
	const fence = stopFenceFixture();
	const binding = managedBindingFixture({
		sessionId: "session-exact",
		workspaceId: "workspace-exact",
		stopFence: fence,
	});
	useStore.setState({ agents: [agent({ runtimeBinding: binding })] });
	const target = resolveHmuxExactInputTarget(identity());
	// A retained target must not alias the mutable projection's generation.
	fence[field] = field === "channelEpoch" ? "8" : "replacement";
	expect(() => revalidateHmuxExactInputTarget(target)).toThrowError(
		expect.objectContaining({ code: "pane_changed" }),
	);
});
it("refuses a runtime class replacement with the same pane and session IDs", () => {
	useStore.setState({
		agents: [
			agent({
				runtimeBinding: managedBindingFixture({
					sessionId: "session-exact",
					workspaceId: "workspace-exact",
					stopFence: stopFenceFixture(),
				}),
			}),
		],
	});
	const target = resolveHmuxExactInputTarget(identity());
	expect(revalidateHmuxExactInputTarget(target).binding).toEqual(
		target.binding,
	);
	useStore.setState({
		agents: [
			agent({
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1",
					source: "local",
					hostId: "local",
					sessionId: "session-exact",
					workspaceId: "workspace-exact",
				},
			}),
		],
	});
	expect(() => revalidateHmuxExactInputTarget(target)).toThrowError(
		expect.objectContaining({ code: "pane_changed" }),
	);
});
it("refuses missing remote registration before input dispatch", () => {
	useStore.setState({
		sshHosts: [],
		agents: [
			agent({
				sessionKind: "ssh",
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "host-remote",
					sessionId: "session-exact",
					workspaceId: "workspace-exact",
					commandBridgeNonce: "original",
					createIdempotencyKey: "create:remote",
					stopFence: stopFenceFixture(),
				},
			}),
		],
	});
	const target = resolveHmuxExactInputTarget(
		identity({ hostId: "host-remote" }),
	);
	expect(() => revalidateHmuxExactInputTarget(target)).toThrowError(
		expect.objectContaining({ code: "pane_changed" }),
	);
});
it("refuses replacement of a remote command bridge", () => {
	const binding = {
		schemaVersion: 1 as const,
		runtime: "hmux_managed_v1" as const,
		source: "ssh" as const,
		hostId: "host-remote",
		sessionId: "session-exact",
		workspaceId: "workspace-exact",
		commandBridgeNonce: "original",
		createIdempotencyKey: "create:remote",
		stopFence: stopFenceFixture(),
	};
	useStore.setState({
		sshHosts: [
			{
				id: "host-remote",
				name: "Remote",
				host: "remote.test",
				port: 22,
				user: "agent",
				auth: "auto",
			},
		],
		agents: [agent({ sessionKind: "ssh", runtimeBinding: binding })],
	});
	const target = resolveHmuxExactInputTarget(
		identity({ hostId: "host-remote" }),
	);
	useStore.setState({
		agents: [
			agent({
				sessionKind: "ssh",
				runtimeBinding: { ...binding, commandBridgeNonce: "replacement" },
			}),
		],
	});
	expect(() => revalidateHmuxExactInputTarget(target)).toThrowError(
		expect.objectContaining({ code: "pane_changed" }),
	);
});

import { describe, expect, it } from "vitest";
import {
	planRemoteNeverCreatedManagedAgentCleanup,
	sameRemoteNeverCreatedManagedAgentCleanupCandidate,
} from "@/lib/sessions/cleanup/remoteNeverCreatedManagedAgentCleanup";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent, Project, SshHostConfig } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Remote",
	path: "/srv/repo",
	kind: "ssh",
	sshHostId: "host-1",
	isRepo: true,
};
const host: SshHostConfig = {
	id: "host-1",
	name: "remote",
	host: "remote.test",
	port: 22,
	user: "agent",
	auth: "key",
	keyPath: "/keys/remote",
};
const agent: Agent = agentFixture({
	name: "codex-remote",
	projectId: project.id,
	worktreePath: "/srv/repo/.worktrees/codex-remote",
	branch: "agent/codex-remote",
	sessionId: "agent-1",
	sessionKind: "ssh",
	started: false,
	runtimeBinding: {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "ssh",
		hostId: host.id,
		sessionId: "agent-1",
		workspaceId: project.id,
		createIdempotencyKey: "create-1",
		commandBridgeNonce: "bridge-1",
	},
});

describe("remote never-created managed Agent cleanup planning", () => {
	it("selects only an exact unstarted registration without a Host generation", () => {
		expect(
			planRemoteNeverCreatedManagedAgentCleanup({
				agent,
				projects: [project],
				sshHosts: [host],
			}),
		).toMatchObject({
			agent: { id: "agent-1", started: false },
			binding: { hostId: "host-1", commandBridgeNonce: "bridge-1" },
		});
		for (const changed of [
			{
				...agent,
				canonicalSpawn: {
					schemaVersion: 1 as const,
					backendProfileId: "remote-1",
					operationId: "spawn-remote",
				},
			},
			{ ...agent, started: true },
			{
				...agent,
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1",
					source: "ssh",
					hostId: host.id,
					sessionId: agent.sessionId,
					workspaceId: project.id,
					commandBridgeNonce: "standalone-bridge",
				} as unknown as Agent["runtimeBinding"],
			},
			{
				...agent,
				runtimeBinding: {
					...agent.runtimeBinding,
					stopFence: {
						runnerPrincipal: "runner",
						runnerInstance: "instance",
						channelEpoch: "1",
						hostInstanceId: "host-instance",
						terminalEpoch: "terminal",
					},
				} as Agent["runtimeBinding"],
			},
		] satisfies Agent[]) {
			expect(
				planRemoteNeverCreatedManagedAgentCleanup({
					agent: changed,
					projects: [project],
					sshHosts: [host],
				}),
			).toBeUndefined();
		}
	});

	it("revalidates the host and create identity, not the display name", () => {
		const candidate = planRemoteNeverCreatedManagedAgentCleanup({
			agent,
			projects: [project],
			sshHosts: [host],
		});
		if (!candidate) throw new Error("candidate missing");
		expect(
			sameRemoteNeverCreatedManagedAgentCleanupCandidate(
				{ agent, projects: [project], sshHosts: [host] },
				candidate,
			),
		).toBe(true);
		expect(
			sameRemoteNeverCreatedManagedAgentCleanupCandidate(
				{
					agent: {
						...agent,
						runtimeBinding: {
							...agent.runtimeBinding,
							commandBridgeNonce: "bridge-replaced",
						} as Agent["runtimeBinding"],
					},
					projects: [project],
					sshHosts: [host],
				},
				candidate,
			),
		).toBe(false);
		expect(
			sameRemoteNeverCreatedManagedAgentCleanupCandidate(
				{
					agent,
					projects: [project],
					sshHosts: [{ ...host, port: 2222 }],
				},
				candidate,
			),
		).toBe(false);
	});
});

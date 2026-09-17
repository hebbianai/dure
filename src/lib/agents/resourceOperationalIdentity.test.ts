import { describe, expect, it } from "vitest";
import {
	sameAgentOperationalIdentity,
	samePaneOperationalIdentity,
	sameProjectOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Project, SshHostConfig } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const host: SshHostConfig = {
	id: "host-1",
	name: "Host",
	host: "host.example.test",
	port: 22,
	user: "dure",
	auth: "password",
	secretId: "secret-1",
};

describe("resource operational identity", () => {
	it("ignores Agent presentation while detecting a different registration", () => {
		const agent = agentFixture({
			id: "agent-1",
			projectId: project.id,
			worktreePath: "/repo/.worktrees/agent-1",
			sessionId: "session-1",
		});
		expect(
			sameAgentOperationalIdentity(
				{ ...agent, displayName: "Renamed", started: true },
				agent,
			),
		).toBe(true);
		expect(
			sameAgentOperationalIdentity(
				{ ...agent, sessionId: "session-2" },
				agent,
			),
		).toBe(false);
		expect(
			sameAgentOperationalIdentity(
				{ ...agent, worktreePath: "/repo/.worktrees/replacement" },
				agent,
			),
		).toBe(false);
	});

	it("treats a refreshed local managed fence as a replacement registration", () => {
		const agent = agentFixture({
			runtimeBinding: managedBindingFixture({
				stopFence: stopFenceFixture({ terminalEpoch: "terminal-old" }),
			}),
		});
		expect(
			sameAgentOperationalIdentity(
				{
					...agent,
					runtimeBinding: managedBindingFixture({
						stopFence: stopFenceFixture({
							terminalEpoch: "terminal-current",
						}),
					}),
				},
				agent,
			),
		).toBe(false);
	});

	it("ignores Project presentation while detecting a different location", () => {
		expect(
			sameProjectOperationalIdentity(
				{ ...project, name: "Renamed", isRepo: false },
				project,
			),
		).toBe(true);
		expect(
			sameProjectOperationalIdentity({ ...project, path: "/replacement" }, project),
		).toBe(false);
	});

	it("ignores host presentation while detecting different connection authority", () => {
		const ownedHost: SshHostConfig = {
			...host,
			registrationGeneration: "generation-1",
			secretId: undefined,
			credential: {
				schemaVersion: 1,
				id: "ssh-11111111111111111111111111111111",
				hostId: host.id,
				registrationGeneration: "generation-1",
			},
		};
		expect(
			sameSshHostOperationalIdentity({ ...host, name: "Renamed" }, host),
		).toBe(true);
		expect(
			sameSshHostOperationalIdentity(
				{ ...host, secretId: "secret-2" },
				host,
			),
		).toBe(false);
		expect(
			sameSshHostOperationalIdentity(
				{ ...ownedHost, secretId: ownedHost.credential?.id },
				ownedHost,
			),
		).toBe(true);
		expect(
			sameSshHostOperationalIdentity(
				{
					...ownedHost,
					credential: {
						schemaVersion: 1,
						id: "ssh-22222222222222222222222222222222",
						hostId: host.id,
						registrationGeneration: "generation-1",
					},
				},
				ownedHost,
			),
		).toBe(false);
		expect(
			sameSshHostOperationalIdentity(
				{ ...host, sshConfigAlias: "through-bastion" },
				host,
			),
		).toBe(false);
		expect(sameSshHostOperationalIdentity(undefined, undefined)).toBe(false);
	});

	it("compares a persisted pane occurrence independently of object key order", () => {
		expect(
			samePaneOperationalIdentity(
				{ title: "Shell", binding: { sessionId: "session-1", hostId: "host-1" } },
				{ binding: { hostId: "host-1", sessionId: "session-1" }, title: "Shell" },
			),
		).toBe(true);
		expect(
			samePaneOperationalIdentity(
				{ binding: { sessionId: "session-2", hostId: "host-1" } },
				{ binding: { sessionId: "session-1", hostId: "host-1" } },
			),
		).toBe(false);
	});
});

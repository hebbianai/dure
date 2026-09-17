import { describe, expect, it } from "vitest";
import {
	captureSshHostRemovalScope,
	matchesSshHostRemovalScope,
} from "@/lib/agents/sshHostRemovalScope";
import { agentFixture } from "@/test/agentFixtures";
import type { Project, SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "host-1",
	name: "Remote",
	host: "remote.test",
	port: 22,
	user: "agent",
	auth: "password",
	secretId: "secret-1",
};
const project: Project = {
	id: "project-1",
	name: "Remote",
	path: "/repo",
	kind: "ssh",
	sshHostId: host.id,
	isRepo: true,
};
const agent = agentFixture({ projectId: project.id, sessionKind: "ssh" });

describe("SSH host removal scope", () => {
	it("matches the exact prepared scope", () => {
		const state = { sshHosts: [host], projects: [project], agents: [agent] };
		const scope = captureSshHostRemovalScope(host.id, state);

		expect(matchesSshHostRemovalScope(scope, state)).toBe(true);
	});

	it("rejects a project added to the host after preparation", () => {
		const state = { sshHosts: [host], projects: [project], agents: [agent] };
		const scope = captureSshHostRemovalScope(host.id, state);
		const added = { ...project, id: "project-2", path: "/other" };

		expect(
			matchesSshHostRemovalScope(scope, {
				...state,
				projects: [project, added],
			}),
		).toBe(false);
	});

	it("rejects an Agent added to or replaced within the prepared projects", () => {
		const state = { sshHosts: [host], projects: [project], agents: [agent] };
		const scope = captureSshHostRemovalScope(host.id, state);
		const added = agentFixture({
			id: "agent-2",
			projectId: project.id,
			sessionKind: "ssh",
		});
		const replacement = { ...agent, sessionId: "session-replacement" };

		expect(
			matchesSshHostRemovalScope(scope, {
				...state,
				agents: [agent, added],
			}),
		).toBe(false);
		expect(
			matchesSshHostRemovalScope(scope, {
				...state,
				agents: [replacement],
			}),
		).toBe(false);
	});

	it("rejects a host replacement", () => {
		const state = { sshHosts: [host], projects: [project], agents: [agent] };
		const scope = captureSshHostRemovalScope(host.id, state);

		expect(
			matchesSshHostRemovalScope(scope, {
				...state,
				sshHosts: [{ ...host, secretId: "secret-2" }],
			}),
		).toBe(false);
	});
});

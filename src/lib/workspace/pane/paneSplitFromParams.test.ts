import { afterEach, describe, expect, it } from "vitest";
import { remoteHmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { paneSplitTargetForPanel } from "@/lib/workspace/pane/paneSplitFromParams";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const original = {
	agents: useStore.getState().agents,
	projects: useStore.getState().projects,
	sessionCwd: useStore.getState().sessionCwd,
};

afterEach(() => useStore.setState(original));

describe("paneSplitTargetForPanel", () => {
	it.each(["slot", "launcher:old", "agent:old"])(
		"inherits a terminal's own binding in %s despite copied Agent and session fields",
		(panelId) => {
			useStore.setState({
				agents: [agentFixture({ id: "old", worktreePath: "/former-agent" })],
				projects: [],
				sessionCwd: {
					"terminal-current": "/terminal/live",
					"stale-session": "/stale/live",
				},
			});
			const params = {
				agentRef: { agentId: "old" },
				agentId: "old",
				sessionId: "stale-session",
				hostId: "stale-host",
				cwd: "/terminal/initial",
				binding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1",
					source: "local",
					hostId: "local",
					sessionId: "terminal-current",
					workspaceId: "terminal-workspace",
				} as const,
			};
			expect(
				paneSplitTargetForPanel({ id: panelId, component: "terminal" }, params),
			).toEqual({ kind: "local", cwd: "/terminal/live" });
		},
	);

	it("inherits execution location from the explicit Agent reference, not old pane parameters", () => {
		const binding = remoteHmuxManagedBinding(
			"current-session",
			"current-workspace",
			"current-host",
			"current-bridge",
		);
		useStore.setState({
			agents: [
				agentFixture({
					id: "current",
					runtimeBinding: binding,
					sessionId: binding.sessionId,
					worktreePath: "/current",
				}),
			],
			projects: [],
			sessionCwd: { [binding.sessionId]: "/current/live" },
		});
		const params = {
			agentRef: { agentId: "current" },
			agentId: "stale",
			cwd: "/stale",
			hostId: "stale-host",
		};
		expect(
			paneSplitTargetForPanel(
				{ id: "pane:opaque", component: "agent" },
				params,
			),
		).toEqual({
			kind: "ssh",
			hostId: "current-host",
			cwd: "/current/live",
		});
	});

	it("does not use copied execution coordinates when the explicit Agent reference is unresolved", () => {
		useStore.setState({ agents: [], projects: [], sessionCwd: {} });
		const params = {
			agentRef: null,
			agentId: "stale",
			cwd: "/stale",
			hostId: "stale-host",
		};
		expect(
			paneSplitTargetForPanel(
				{ id: "pane:opaque", component: "agent" },
				params,
			),
		).toEqual({
			kind: "local",
		});
	});

	it("ignores copied legacy coordinates for an explicitly referenced Agent", () => {
		const binding = remoteHmuxManagedBinding(
			"session-current",
			"workspace-current",
			"host-current",
			"bridge-current",
		);
		const agent = agentFixture({
			id: "agent-current",
			projectId: "project-current",
			sessionId: binding.sessionId,
			sessionKind: "ssh",
			worktreePath: "/srv/current",
			runtimeBinding: binding,
		});
		useStore.setState({
			agents: [agent],
			projects: [
				{
					id: agent.projectId,
					name: "Current",
					path: "/srv/current",
					kind: "ssh",
					isRepo: true,
					sshHostId: "host-current",
				},
			],
			sessionCwd: { [agent.sessionId]: "/srv/current/live" },
		});

		expect(
			paneSplitTargetForPanel(
				{ id: `agent:${agent.id}`, component: "agent" },
				{
					agentRef: { agentId: agent.id },
					agentId: "agent-stale",
					hostId: "host-stale",
					cwd: "/srv/stale",
					binding: remoteHmuxManagedBinding(
						"session-stale",
						"workspace-stale",
						"host-stale",
						"bridge-stale",
					),
				},
			),
		).toEqual({
			kind: "ssh",
			hostId: "host-current",
			cwd: "/srv/current/live",
		});
	});
});

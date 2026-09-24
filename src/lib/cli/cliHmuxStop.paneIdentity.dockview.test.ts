// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CliHmuxStopRuntime,
	handleCliHmuxStop,
	resolveCliHmuxStopTarget,
} from "@/lib/cli/cliHmuxStop";
import {
	cleanupExitedManagedAgentRegistration,
	type ExitedManagedAgentCleanupRuntime,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";

const cleanups: Array<() => void> = [];
const binding = managedBindingFixture();
const agent = {
	...managedAgentFixture({
		name: "selected",
		runtimeBinding: binding,
	}),
	canonicalSpawn: undefined,
};
const receipt = {
	schema: "hmux-managed-stop-v1" as const,
	schemaVersion: 2 as const,
	stopId: "stop-fixture",
	sessionId: binding.sessionId,
	workspaceId: binding.workspaceId,
	runnerPrincipal: "runner",
	runnerInstance: "runner-1",
	channelEpoch: 1,
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
	outcome: "stopped" as const,
	exitReason: "stopped by user",
};

function mounted(spaceId = "target"): DockviewApi {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(spaceId, api);
	cleanups.push(() => {
		unregisterDockview(spaceId, api);
		api.dispose();
		container.remove();
	});
	return api;
}

function addAgent(api: DockviewApi, id: string, agentId = agent.id) {
	return api.addPanel({
		id,
		component: "agent",
		params: { agentRef: { agentId } },
	});
}

function runtime(): CliHmuxStopRuntime {
	return {
		claim: vi.fn().mockResolvedValue(true),
		resolve: resolveCliHmuxStopTarget,
		prepare: vi.fn(async (target) => target),
		cleanupExited: vi.fn().mockResolvedValue(undefined),
		reconcile: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(async () => ({ target: { agent, binding }, receipt })),
		finalize: vi.fn().mockResolvedValue(undefined),
		canonical: { prepare: vi.fn(), execute: vi.fn(), finalize: vi.fn() },
	};
}

function stop(deps: CliHmuxStopRuntime, targetPanelId?: string) {
	return handleCliHmuxStop(
		{ name: agent.name, targetPanelId },
		"request",
		deps,
	);
}

function cleaned() {
	return {
		agentId: agent.id,
		agentName: agent.name,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		outcome: "cleaned" as const,
		sourceState: "retired" as const,
	};
}

beforeEach(() => {
	useStore.setState({
		agents: [agent],
		projects: [],
		layouts: {},
		sshHosts: [],
	});
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	useStore.setState({ agents: [], layouts: {} });
});

describe.each(["mounted", "saved", "restored"])(
	"CLI stop %s pane selection",
	(location) => {
		it.each(["pane-neutral", "launcher:historical", "agent:other"])(
			"stops the explicit Agent reference in %s and preserves its receipt ID",
			async (panelId) => {
				const api = mounted();
				addAgent(api, panelId);
				if (location !== "mounted") {
					const layout = api.toJSON();
					unregisterDockview("target", api);
					if (location === "saved")
						useStore.setState({ layouts: { target: layout } });
					else mounted("restored").fromJSON(layout);
				}
				const deps = runtime();
				expect(await stop(deps, panelId)).toMatchObject({
					ok: true,
					stop: receipt,
					agent: { id: agent.id, panelId },
				});
				expect(deps.stop).toHaveBeenCalledWith({ agent, binding });
				expect(deps.finalize).toHaveBeenCalledWith({ agent, binding }, receipt);
			},
		);
	},
);

describe("CLI stop lifecycle boundary", () => {
	it.each(["terminal", "other-agent", "invalid-reference", "ambiguous"])(
		"refuses an observed %s even when its ID is the selected Agent's historical alias",
		async (kind) => {
			const id = `agent:${agent.id}`;
			const api = mounted();
			if (kind === "terminal") api.addPanel({ id, component: "terminal" });
			else {
				const panel = addAgent(
					api,
					id,
					kind === "other-agent" ? "other" : agent.id,
				);
				if (kind === "invalid-reference")
					panel.api.updateParameters({ agentRef: {} });
				if (kind === "ambiguous") addAgent(mounted("peer"), id);
			}
			const deps = runtime();
			expect(await stop(deps, id)).toMatchObject({
				ok: false,
				error: {
					code: kind === "ambiguous" ? "pane_ambiguous" : "pane_changed",
				},
			});
			expect(deps.cleanupExited).not.toHaveBeenCalled();
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.finalize).not.toHaveBeenCalled();
		},
	);

	it.each(["claim", "prepare", "reconcile", "cleanupExited"] as const)(
		"does not stop when the pane changes during %s",
		async (phase) => {
			const id = `agent:${agent.id}`;
			const panel = addAgent(mounted(), id);
			const deps = runtime();
			const retarget = () =>
				panel.api.updateParameters({ agentRef: { agentId: "other" } });
			if (phase === "claim")
				vi.mocked(deps.claim).mockImplementation(async () => {
					retarget();
					return true;
				});
			else if (phase === "prepare")
				vi.mocked(deps.prepare).mockImplementation(async (target) => {
					retarget();
					return target;
				});
			else
				vi.mocked(deps[phase]).mockImplementation(async () => {
					retarget();
					return undefined;
				});
			expect(await stop(deps, id)).toMatchObject({
				ok: false,
				error: { code: "pane_changed" },
			});
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.finalize).not.toHaveBeenCalled();
		},
	);

	it.each(["pane-neutral", `agent:${agent.id}`])(
		"does not turn a vanished prepared %s into a headless stop",
		async (id) => {
			const api = mounted();
			const panel = addAgent(api, id);
			useStore.setState({ layouts: { target: api.toJSON() } });
			const deps = runtime();
			vi.mocked(deps.claim).mockImplementation(async () => {
				api.removePanel(panel);
				return true;
			});
			expect(await stop(deps, id)).toMatchObject({
				ok: false,
				error: { code: "pane_changed" },
			});
			expect(deps.stop).not.toHaveBeenCalled();
		},
	);

	it.each(["initial", "claim", "cleanupExited"] as const)(
		"allows cleanup-only completion when the pane is absent at %s",
		async (phase) => {
			const id = "pane-neutral";
			const api = mounted();
			const panel = phase !== "initial" ? addAgent(api, id) : undefined;
			const deps = runtime();
			vi.mocked(deps.cleanupExited).mockImplementation(async () => {
				if (phase === "cleanupExited" && panel) api.removePanel(panel);
				return cleaned();
			});
			vi.mocked(deps.claim).mockImplementation(async () => {
				if (phase === "claim" && panel) api.removePanel(panel);
				return true;
			});
			expect(await stop(deps, id)).toMatchObject({
				ok: true,
				cleanup: cleaned(),
				agent: { panelId: id },
			});
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.finalize).not.toHaveBeenCalled();
		},
	);

	it("requires an observed pane before a new stop when a neutral hint was already absent", async () => {
		const deps = runtime();
		expect(await stop(deps, "pane-absent")).toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expect(deps.cleanupExited).toHaveBeenCalledOnce();
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("preserves a selected pane moved to another Space during claim", async () => {
		const api = mounted();
		const id = "pane-neutral";
		const panel = addAgent(api, id);
		const peer = mounted("peer");
		const deps = runtime();
		vi.mocked(deps.claim).mockImplementation(async () => {
			api.removePanel(panel);
			addAgent(peer, id);
			return true;
		});
		expect(await stop(deps, id)).toMatchObject({
			ok: true,
			agent: { panelId: id },
		});
		expect(deps.stop).toHaveBeenCalledOnce();
	});

	it("finishes the accepted stop without acting on the pane's replacement", async () => {
		const id = "pane-neutral";
		const panel = addAgent(mounted(), id);
		const deps = runtime();
		vi.mocked(deps.stop).mockImplementation(async () => {
			panel.api.updateParameters({ agentRef: { agentId: "other" } });
			return { target: { agent, binding }, receipt };
		});
		expect(await stop(deps, id)).toMatchObject({
			ok: true,
			stop: receipt,
			agent: { panelId: id },
		});
		expect(deps.finalize).toHaveBeenCalledWith({ agent, binding }, receipt);
		expect(panel.params?.agentRef).toEqual({ agentId: "other" });
		expect(deps.stop).toHaveBeenCalledOnce();
	});

	it("preserves an accepted stop receipt after finalize failure and cleans on retry without another stop", async () => {
		const id = "pane-neutral";
		const api = mounted();
		const panel = addAgent(api, id);
		const deps = runtime();
		vi.mocked(deps.finalize).mockImplementation(async () => {
			api.removePanel(panel);
			throw new Error("fixture publication lost");
		});
		expect(await stop(deps, id)).toMatchObject({
			ok: false,
			stop: receipt,
			agent: { panelId: id },
		});
		vi.mocked(deps.cleanupExited).mockResolvedValue(cleaned());
		expect(await stop(deps, id)).toMatchObject({
			ok: true,
			cleanup: cleaned(),
			agent: { panelId: id },
		});
		expect(deps.stop).toHaveBeenCalledOnce();
	});

	it("does not use uncertain stop delivery as permission to finalize", async () => {
		addAgent(mounted(), "pane-neutral");
		const deps = runtime();
		vi.mocked(deps.stop).mockRejectedValue(new Error("fixture response lost"));
		expect(await stop(deps, "pane-neutral")).toMatchObject({
			ok: false,
			error: { code: "hmux_managed_stop_failed" },
			agent: { panelId: "pane-neutral" },
		});
		expect(deps.stop).toHaveBeenCalledOnce();
		expect(deps.finalize).not.toHaveBeenCalled();
	});

	it("replays an accepted stop after view loss without archiving the Host or stopping again", async () => {
		const id = "pane-neutral";
		const api = mounted();
		const panel = addAgent(api, id);
		const completed = { target: { agent, binding }, receipt };
		const deps = Object.assign(runtime(), {
			reconcile: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockResolvedValue(completed),
		});
		vi.mocked(deps.finalize).mockImplementationOnce(async () => {
			api.removePanel(panel);
			throw new Error("fixture publication lost");
		});
		expect(await stop(deps, id)).toMatchObject({ ok: false, stop: receipt });
		vi.mocked(deps.cleanupExited).mockResolvedValue({
			...cleaned(),
			outcome: "skipped",
			reason: "retire_refused",
			hmuxReason: "lifetime_busy",
		});
		expect(await stop(deps, id)).toMatchObject({
			ok: true,
			stop: receipt,
			agent: { panelId: id },
		});
		expect(deps.reconcile).toHaveBeenCalledTimes(2);
		expect(deps.cleanupExited).toHaveBeenCalledOnce();
		expect(deps.stop).toHaveBeenCalledOnce();
		expect(deps.finalize).toHaveBeenLastCalledWith(completed.target, receipt);
	});

	it("resumes completion from its owner after caller restart without a mounted pane", async () => {
		const completed = { target: { agent, binding }, receipt };
		const deps = Object.assign(runtime(), {
			reconcile: vi.fn().mockResolvedValue(completed),
		});
		expect(await stop(deps, "pane-previously-closed")).toMatchObject({
			ok: true,
			stop: receipt,
			agent: { panelId: "pane-previously-closed" },
		});
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).toHaveBeenCalledWith(completed.target, receipt);
	});

	it("does not fall through to cleanup or stop after uncertain completion observation", async () => {
		addAgent(mounted(), "pane-neutral");
		const deps = runtime();
		vi.mocked(deps.reconcile).mockRejectedValue(
			new Error("completion response lost"),
		);
		expect(await stop(deps, "pane-neutral")).toMatchObject({
			ok: false,
			error: { message: "completion response lost" },
		});
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
		expect(deps.finalize).not.toHaveBeenCalled();
	});

	it("does not execute a duplicate claim for an observed neutral pane", async () => {
		addAgent(mounted(), "pane-neutral");
		const deps = runtime();
		vi.mocked(deps.claim).mockResolvedValue(false);
		expect(await stop(deps, "pane-neutral")).toBeNull();
		expect(deps.cleanupExited).not.toHaveBeenCalled();
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("does not cleanup a replacement registration selected by ID after asynchronous claim", async () => {
		const deps = runtime();
		const replacement = {
			...agent,
			sessionId: "replacement",
			runtimeBinding: { ...binding, sessionId: "replacement" },
		};
		vi.mocked(deps.claim).mockImplementation(async () => {
			useStore.setState({ agents: [replacement] });
			return true;
		});
		const forget = vi.fn(() => {
			useStore.setState({ agents: [] });
			return true;
		});
		const cleanupRuntime: ExitedManagedAgentCleanupRuntime = {
			listSessions: vi.fn().mockResolvedValue([]),
			currentAgents: () => useStore.getState().agents,
			currentProjects: () => [],
			absentEligibleAgentIds: () => new Set([agent.id]),
			retireExitedSessions: vi.fn(),
			cleanupStaleSessions: vi.fn(),
			forget,
			reconcileReplacement: vi.fn(),
		};
		deps.cleanupExited = (selected) =>
			cleanupExitedManagedAgentRegistration(selected, cleanupRuntime);
		expect(await stop(deps)).toMatchObject({
			ok: false,
			error: { code: "managed_agent_cleanup_failed" },
		});
		expect(forget).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([replacement]);
		expect(deps.stop).not.toHaveBeenCalled();
	});
});

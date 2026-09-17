// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	unopenedAgentVisibilityStorage,
	useUnopenedAgentVisibilityStore,
} from "@/lib/spaces/unopenedAgentVisibilityStore";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { dispatchCliUnopenedAgentVisibility } from "./cliUnopenedAgentVisibility";

const agent = managedAgentFixture({
	id: "exact-agent",
	conversationId: "keep-conversation",
});
const visibilityStore = useUnopenedAgentVisibilityStore;
const dependencies = {
	isMainWindow: vi.fn(() => true),
	claim: vi.fn(async () => true),
	complete: vi.fn(
		async (_reqId: string, _result: unknown, _action: string) => undefined,
	),
};

async function request(
	params: Record<string, unknown>,
	action = "agents.unopened.visibility",
) {
	await dispatchCliUnopenedAgentVisibility(
		{
			reqId: "visibility-test",
			action,
			params: { schemaVersion: 1, agentId: agent.id, ...params },
		},
		dependencies,
	);
	return dependencies.complete.mock.lastCall?.[1];
}

function bump() {
	useAgentAttention.getState().applyAttentionResolution({
		displayStates: {},
		bumps: [{ agentId: agent.id, kind: "done" }],
		consumedArms: [],
	});
}

beforeEach(async () => {
	vi.restoreAllMocks();
	dependencies.isMainWindow.mockReset().mockReturnValue(true);
	dependencies.claim.mockReset().mockResolvedValue(true);
	dependencies.complete.mockClear();
	useStore.setState({ agents: [agent], layouts: {} });
	useHiddenPanes.setState({ hidden: {} });
	useAgentAttention.setState({ episodes: {} });
	visibilityStore.getState().restoreAll();
	await unopenedAgentVisibilityStorage.flush();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("connected-app unopened visibility", () => {
	it("uses the UI hide owner, persists the result, and restores only the exact target", async () => {
		const agents = useStore.getState().agents;
		visibilityStore.getState().hide({ id: "unrelated", episode: 4 });
		// The same action used by the existing Hide from list menu.
		visibilityStore.getState().hide({ id: agent.id, episode: 0 });
		expect(await request({ operation: "get" })).toMatchObject({
			ok: true,
			visibility: {
				agentId: agent.id,
				placement: "unopened",
				episode: 0,
				hidden: true,
				changed: false,
				persisted: true,
			},
		});
		const saved = () =>
			JSON.parse(
				localStorage.getItem("agent-ide-unopened-agent-visibility") ?? "null",
			).state.hidden;
		expect(saved()).toContainEqual({ id: agent.id, observedEpisode: 0 });
		expect(
			await request({ operation: "restore", expectedEpisode: 0 }),
		).toMatchObject({ ok: true, visibility: { hidden: false, changed: true } });
		expect(saved()).toEqual([{ id: "unrelated", observedEpisode: 4 }]);
		expect(
			await request({ operation: "restore", expectedEpisode: 0 }),
		).toMatchObject({ visibility: { changed: false } });
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({ visibility: { hidden: true, changed: true } });
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({ visibility: { hidden: true, changed: false } });
		expect(visibilityStore.getState().hidden).toEqual(saved());
		expect(useStore.getState().agents).toBe(agents);
		expect(useStore.getState().agents[0]).toEqual(agent);
	});

	it("rechecks attention after the claim and refuses to hide newer work", async () => {
		dependencies.claim.mockImplementationOnce(async () => {
			bump();
			return true;
		});
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({
			ok: false,
			error: { code: "visibility_observation_stale" },
		});
		expect(visibilityStore.getState().hidden).toEqual([]);
		expect(await request({ operation: "get" })).toMatchObject({
			visibility: { episode: 1, hidden: false },
		});
	});

	it("reports actual visibility if fresh attention arrives while saving", async () => {
		const flush = unopenedAgentVisibilityStorage.flush.bind(
			unopenedAgentVisibilityStorage,
		);
		vi.spyOn(unopenedAgentVisibilityStorage, "flush").mockImplementationOnce(
			async () => {
				bump();
				await flush();
			},
		);
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({
			ok: true,
			visibility: {
				episode: 1,
				hidden: false,
				changed: true,
				persisted: true,
			},
		});
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({
			ok: false,
			error: { code: "visibility_observation_stale" },
		});
	});

	it.each(["saved", "mounted", "hidden"])(
		"refuses to hide an agent with a %s pane",
		async (kind) => {
			const container = document.createElement("div");
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			try {
				if (kind === "saved") {
					useStore.setState({
						layouts: {
							space: {
								panels: {
									slot: {
										contentComponent: "agent",
										params: { agentRef: { agentId: agent.id } },
									},
								},
							},
						},
					});
				} else if (kind === "mounted") {
					api.addPanel({
						id: "slot",
						component: "agent",
						params: { agentRef: { agentId: agent.id } },
					});
					dockviewRegistry.set("space", api);
				} else useHiddenPanes.getState().markHidden(agent.id, "space", "slot");
				expect(await request({ operation: "get" })).toMatchObject({
					visibility: {
						placement: kind === "hidden" ? "hidden_pane" : "placed",
					},
				});
				expect(
					await request({ operation: "hide", expectedEpisode: 0 }),
				).toMatchObject({ ok: false, error: { code: "agent_not_unopened" } });
				expect(visibilityStore.getState().hidden).toEqual([]);
			} finally {
				dockviewRegistry.delete("space");
				api.dispose();
			}
		},
	);

	it("does not claim from another window, mutate an unclaimed request, or handle another action", async () => {
		dependencies.isMainWindow.mockReturnValue(false);
		await request({ operation: "hide", expectedEpisode: 0 });
		expect(dependencies.claim).not.toHaveBeenCalled();
		dependencies.isMainWindow.mockReturnValue(true);
		dependencies.claim.mockResolvedValue(false);
		await request({ operation: "hide", expectedEpisode: 0 });
		await request({ operation: "hide", expectedEpisode: 0 }, "hmux.stop");
		expect(dependencies.claim).toHaveBeenCalledTimes(1);
		expect(dependencies.complete).not.toHaveBeenCalled();
		expect(visibilityStore.getState().hidden).toEqual([]);
	});

	it("refuses unknown IDs, incomplete hydration and invalid input without mutation", async () => {
		expect(
			await request({
				operation: "hide",
				agentId: agent.name,
				expectedEpisode: 0,
			}),
		).toMatchObject({ ok: false, error: { code: "agent_not_found" } });
		for (const params of [
			{ operation: "remove", expectedEpisode: 0 },
			{ operation: "hide" },
			{ operation: "restore", expectedEpisode: -1 },
			{ operation: "hide", expectedEpisode: "0" },
			{ operation: "hide", expectedEpisode: 0.5 },
			{ operation: "get", expectedEpisode: 0 },
			{ operation: "get", schemaVersion: 2 },
			{ operation: "get", agentId: "\u001b" },
		])
			expect(await request(params)).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
		vi.spyOn(visibilityStore.persist, "hasHydrated").mockReturnValueOnce(false);
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({ ok: false, error: { code: "client_not_ready" } });
		expect(visibilityStore.getState().hidden).toEqual([]);
	});

	it("does not report durable success when persistence fails", async () => {
		vi.spyOn(unopenedAgentVisibilityStorage, "flush").mockRejectedValueOnce(
			new Error("fixture storage unavailable"),
		);
		expect(
			await request({ operation: "hide", expectedEpisode: 0 }),
		).toMatchObject({
			ok: false,
			error: { code: "unopened_visibility_failed" },
		});
		// A failed receipt is not proof of absence; inspect instead of repeating the mutation.
		expect(await request({ operation: "get" })).toMatchObject({
			ok: true,
			visibility: { hidden: true, persisted: true },
		});
	});
});

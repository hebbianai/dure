// @vitest-environment jsdom
import { createDockview, type SerializedDockview } from "dockview-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
	status: vi.fn(),
	preview: vi.fn(),
	apply: vi.fn(),
}));
vi.mock("@/lib/ipc/dureAgentStop", () => ({
	createDureAgentStopClient: () => backend,
}));

import {
	applyCanonicalAgentStopPresentationV1,
	executeCanonicalAgentStopV1,
	prepareCanonicalAgentStopV1,
} from "@/lib/agents/canonicalAgentStopRuntime";
import {
	type CliHmuxStopRuntime,
	handleCliHmuxStop,
	resolveCliHmuxStopTarget,
} from "@/lib/cli/cliHmuxStop";
import { subscribeDurableStoreLayoutProjection } from "@/lib/persistence/durableStoreRehydration";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const agent = agentFixture({
	id: "agent-canonical",
	name: "worker",
	canonicalSpawn: {
		schemaVersion: 1,
		backendProfileId: "local",
		operationId: "spawn-worker",
	},
});
const authority = testDureBackendRouteAuthority("dure-local", "generation-1");
const receipt = (
	status: "planned" | "authorized" | "workspace_preserved" | "source_retained",
) => ({
	schemaVersion: 1 as const,
	operationId: "stop-worker",
	spawnOperationId: "spawn-worker",
	agentId: agent.id,
	planToken: `sha256:${"a".repeat(64)}`,
	workspaceDisposition: "preserve" as const,
	journalRevision: status === "planned" ? 1 : status === "authorized" ? 2 : 3,
	status,
});

function runtime() {
	return {
		claim: vi.fn().mockResolvedValue(true),
		resolve: resolveCliHmuxStopTarget,
		prepare: vi.fn(),
		reconcile: vi.fn(),
		cleanupExited: vi.fn(),
		stop: vi.fn(),
		finalize: vi.fn(),
		canonical: {
			prepare: prepareCanonicalAgentStopV1,
			execute: executeCanonicalAgentStopV1,
			finalize: applyCanonicalAgentStopPresentationV1,
		},
	} satisfies CliHmuxStopRuntime;
}

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [agent],
		projects: [],
		layouts: {},
		sessionCwd: {},
	});
	backend.status.mockResolvedValue({
		receipt: null,
		routeAuthority: authority,
	});
	backend.preview.mockResolvedValue(receipt("planned"));
	backend.apply.mockResolvedValue(receipt("workspace_preserved"));
});

describe("CLI canonical Agent cleanup", () => {
	it.each([false, true])(
		"revalidates the selected canonical pane before applying (retargeted=%s)",
		async (retargeted) => {
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			api.layout(1000, 700);
			registerDockview("canonical-stop", api);
			const panel = api.addPanel({
				id: "neutral-slot",
				component: "agent",
				params: { agentRef: { agentId: agent.id } },
			});
			useStore.setState({
				spaces: [{ id: "canonical-stop", name: "Stop QA" }],
				layouts: { "canonical-stop": api.toJSON() },
			});
			const unsubscribe = subscribeDurableStoreLayoutProjection(
				"canonical-stop",
				() => {
					api.fromJSON(
						useStore.getState().layouts["canonical-stop"] as SerializedDockview,
					);
					return true;
				},
				() => true,
			);
			try {
				if (retargeted)
					backend.preview.mockImplementation(async () => {
						panel.api.updateParameters({
							agentRef: { agentId: "other-agent" },
						});
						return receipt("planned");
					});
				const result = await handleCliHmuxStop(
					{ name: agent.id, targetPanelId: panel.id },
					"pane-stop",
					runtime(),
				);
				expect(result?.ok).toBe(!retargeted);
				if (retargeted) {
					expect(result).toMatchObject({ error: { code: "pane_changed" } });
					expect(backend.apply).not.toHaveBeenCalled();
					expect(api.getPanel(panel.id)?.params?.agentRef?.agentId).toBe(
						"other-agent",
					);
				} else {
					expect(backend.apply).toHaveBeenCalledOnce();
					expect(api.getPanel(panel.id) === undefined).toBe(true);
				}
			} finally {
				unsubscribe();
				unregisterDockview("canonical-stop", api);
				api.dispose();
				container.remove();
			}
		},
	);

	it.each(["worker", "agent-canonical"])(
		"stops %s through dispatch stop and removes the registration without a legacy stop",
		async (name) => {
			const deps = runtime();
			const result = await handleCliHmuxStop({ name }, "stop-request", deps);
			expect(result).toMatchObject({
				ok: true,
				dispatchStop: receipt("workspace_preserved"),
				agent: { id: agent.id },
			});
			expect(backend.status).toHaveBeenCalledWith("spawn-worker");
			expect(backend.preview).toHaveBeenCalledWith("spawn-worker", authority);
			expect(backend.apply).toHaveBeenCalledWith(receipt("planned"), authority);
			expect(deps.prepare).not.toHaveBeenCalled();
			expect(deps.stop).not.toHaveBeenCalled();
			expect(deps.cleanupExited).not.toHaveBeenCalled();
			expect(useStore.getState().agents).toEqual([]);
		},
	);

	it("retains the Agent when the backend retains its source", async () => {
		backend.apply.mockResolvedValue(receipt("source_retained"));
		const deps = runtime();
		const result = await handleCliHmuxStop(
			{ name: agent.id },
			"retained",
			deps,
		);
		expect(result?.ok).toBe(false);
		expect(useStore.getState().agents).toEqual([agent]);
		expect(deps.stop).not.toHaveBeenCalled();
	});

	it("reconciles a lost apply reply before cleanup without a second stop", async () => {
		backend.apply.mockRejectedValueOnce(new Error("reply lost"));
		const deps = runtime();
		expect(
			(await handleCliHmuxStop({ name: agent.id }, "lost", deps))?.ok,
		).toBe(false);
		expect(useStore.getState().agents).toEqual([agent]);
		backend.status.mockResolvedValue({
			receipt: receipt("workspace_preserved"),
			routeAuthority: authority,
		});
		expect(
			(await handleCliHmuxStop({ name: agent.id }, "retry", deps))?.ok,
		).toBe(true);
		expect(backend.apply).toHaveBeenCalledTimes(1);
		expect(backend.preview).toHaveBeenCalledTimes(1);
		expect(useStore.getState().agents).toEqual([]);
	});

	it("returns the stop receipt when presentation cleanup needs retry", async () => {
		const deps = runtime();
		deps.canonical.finalize = vi.fn().mockResolvedValue(false);
		expect(
			await handleCliHmuxStop({ name: agent.id }, "cleanup-failed", deps),
		).toMatchObject({
			ok: false,
			dispatchStop: receipt("workspace_preserved"),
			error: { code: "agent_dispatch_stop_cleanup_failed" },
		});
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("does not resume a workspace deletion through the workspace-preserving stop command", async () => {
		backend.status.mockResolvedValue({
			receipt: {
				...receipt("authorized"),
				workspaceDisposition: "remove_owned",
			},
			routeAuthority: authority,
		});
		const result = await handleCliHmuxStop(
			{ name: agent.id },
			"preserve-workspace",
			runtime(),
		);
		expect(result).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("removes the workspace") },
		});
		expect(backend.apply).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("refuses a replaced Agent while preparing the canonical stop", async () => {
		backend.preview.mockImplementation(async () => {
			useStore.setState({
				agents: [
					{
						...agent,
						canonicalSpawn: {
							...agent.canonicalSpawn!,
							operationId: "replacement",
						},
					},
				],
			});
			return receipt("planned");
		});
		expect(
			(await handleCliHmuxStop({ name: agent.id }, "replaced", runtime()))?.ok,
		).toBe(false);
		expect(backend.apply).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].canonicalSpawn?.operationId).toBe(
			"replacement",
		);
	});

	it("does not stop a canonical Agent when another client claimed the request", async () => {
		const deps = runtime();
		vi.mocked(deps.claim).mockResolvedValue(false);
		expect(
			await handleCliHmuxStop({ name: agent.id }, "claimed", deps),
		).toBeNull();
		expect(backend.status).not.toHaveBeenCalled();
		expect(backend.apply).not.toHaveBeenCalled();
	});
});

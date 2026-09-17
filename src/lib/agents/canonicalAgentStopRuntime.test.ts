import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	apply: vi.fn(),
	createClient: vi.fn(),
	preview: vi.fn(),
	status: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentStop", () => ({
	createDureAgentStopClient: mocks.createClient,
}));

import {
	applyCanonicalAgentStopPresentationV1,
	CanonicalAgentStopRetainedError,
	executeCanonicalAgentStopV1,
	prepareCanonicalAgentStopV1,
	reconcileCanonicalAgentStopsOnceV1,
} from "@/lib/agents/canonicalAgentStopRuntime";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	useStore,
} from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

const route = testDureBackendRouteAuthority("dure-local", "generation-1");

function canonicalAgent(operationId = "spawn-1") {
	return agentFixture({
		id: "agent-1",
		sessionId: "session-1",
		canonicalSpawn: {
			schemaVersion: 1,
			backendProfileId: "local",
			operationId,
		},
	});
}

function receipt(
	status:
		| "planned"
		| "superseded"
		| "authorized"
		| "source_retained"
		| "workspace_preserved",
) {
	return {
		schemaVersion: 1 as const,
		operationId: "stop-1",
		spawnOperationId: "spawn-1",
		agentId: "agent-1",
		planToken: `sha256:${"a".repeat(64)}`,
		journalRevision: status === "planned" ? 1 : status === "authorized" ? 2 : 3,
		workspaceDisposition: "preserve" as const,
		status,
	};
}

describe("canonical Agent stop reload reconciliation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createClient.mockReturnValue({
			status: mocks.status,
			preview: mocks.preview,
			apply: mocks.apply,
		});
		useStore.setState({
			agents: [canonicalAgent()],
			projects: [],
			layouts: {},
			sessionCwd: { "session-1": "/repo" },
		});
	});

	it("resumes an authorized durable stop once, then forgets presentation", async () => {
		mocks.status.mockResolvedValue({
			receipt: receipt("authorized"),
			routeAuthority: route,
		});
		mocks.apply.mockResolvedValue(receipt("workspace_preserved"));

		const [result] = await reconcileCanonicalAgentStopsOnceV1();

		expect(mocks.apply).toHaveBeenCalledWith(receipt("authorized"), route);
		expect(mocks.preview).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			agentId: "agent-1",
			outcome: "forgotten",
			status: "workspace_preserved",
		});
		expect(useStore.getState().agents).toEqual([]);
	});

	it("keeps the original status projection in flight until its profile is ready", async () => {
		let publishReady!: (observation: {
			receipt: ReturnType<typeof receipt>;
			routeAuthority: typeof route;
		}) => void;
		mocks.status.mockReturnValueOnce(
			new Promise((resolve) => {
				publishReady = resolve;
			}),
		);

		const reconciliation = reconcileCanonicalAgentStopsOnceV1();
		await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledOnce());
		expect(useStore.getState().agents).toHaveLength(1);

		publishReady({
			receipt: receipt("workspace_preserved"),
			routeAuthority: route,
		});
		const [result] = await reconciliation;

		expect(mocks.createClient).toHaveBeenCalledOnce();
		expect(mocks.status).toHaveBeenCalledOnce();
		expect(mocks.preview).not.toHaveBeenCalled();
		expect(mocks.apply).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			agentId: "agent-1",
			outcome: "forgotten",
			status: "workspace_preserved",
		});
		expect(useStore.getState().agents).toEqual([]);
	});

	it("leaves an inert planned stop for explicit user confirmation", async () => {
		mocks.status.mockResolvedValue({
			receipt: receipt("planned"),
			routeAuthority: route,
		});

		const [result] = await reconcileCanonicalAgentStopsOnceV1();

		expect(result).toMatchObject({ outcome: "unchanged", status: "planned" });
		expect(mocks.preview).not.toHaveBeenCalled();
		expect(mocks.apply).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("does not reauthorize a definitively retained stop during reload", async () => {
		mocks.status.mockResolvedValue({
			receipt: receipt("source_retained"),
			routeAuthority: route,
		});

		const [result] = await reconcileCanonicalAgentStopsOnceV1();

		expect(result).toMatchObject({
			outcome: "unchanged",
			status: "source_retained",
		});
		expect(mocks.preview).not.toHaveBeenCalled();
		expect(mocks.apply).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("returns a typed refusal when the confirmed stop retains its source", async () => {
		mocks.status.mockResolvedValue({ receipt: null, routeAuthority: route });
		mocks.preview.mockResolvedValue(receipt("planned"));
		mocks.apply.mockResolvedValue(receipt("source_retained"));
		const agent = canonicalAgent();
		if (!agent.canonicalSpawn) throw new Error("expected canonical provenance");
		const target = await prepareCanonicalAgentStopV1({
			...agent,
			canonicalSpawn: agent.canonicalSpawn,
		});

		await expect(executeCanonicalAgentStopV1(target)).rejects.toMatchObject({
			name: CanonicalAgentStopRetainedError.name,
			code: "agent_dispatch_stop_source_retained",
		});
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("does not apply a preview receipt after a same-ID successor appears", async () => {
		mocks.status.mockResolvedValue({ receipt: null, routeAuthority: route });
		const source = canonicalAgent();
		if (!source.canonicalSpawn)
			throw new Error("expected canonical provenance");
		const successor = canonicalAgent("spawn-2");
		mocks.preview.mockImplementationOnce(async () => {
			useStore.setState({ agents: [successor] });
			return receipt("planned");
		});
		const target = await prepareCanonicalAgentStopV1({
			...source,
			canonicalSpawn: source.canonicalSpawn,
		});

		await expect(executeCanonicalAgentStopV1(target)).rejects.toThrow();

		expect(mocks.apply).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("rejects a preview receipt for another Agent before apply", async () => {
		mocks.status.mockResolvedValue({ receipt: null, routeAuthority: route });
		mocks.preview.mockResolvedValue({
			...receipt("planned"),
			agentId: "agent-other",
		});
		const source = canonicalAgent();
		if (!source.canonicalSpawn)
			throw new Error("expected canonical provenance");
		const target = await prepareCanonicalAgentStopV1({
			...source,
			canonicalSpawn: source.canonicalSpawn,
		});

		await expect(executeCanonicalAgentStopV1(target)).rejects.toThrow();

		expect(mocks.apply).not.toHaveBeenCalled();
	});

	it("projects a terminal preview replay without applying it again", async () => {
		mocks.status.mockResolvedValue({ receipt: null, routeAuthority: route });
		mocks.preview.mockResolvedValue(receipt("workspace_preserved"));
		mocks.apply.mockRejectedValue(new Error("terminal receipt must not apply"));
		const source = canonicalAgent();
		if (!source.canonicalSpawn)
			throw new Error("expected canonical provenance");
		const target = await prepareCanonicalAgentStopV1({
			...source,
			canonicalSpawn: source.canonicalSpawn,
		});

		await expect(executeCanonicalAgentStopV1(target)).resolves.toMatchObject({
			status: "workspace_preserved",
		});

		expect(mocks.apply).not.toHaveBeenCalled();
	});

	it.each(["source_retained", "superseded"] as const)(
		"projects a %s preview replay without an invalid apply",
		async (status) => {
			mocks.status.mockResolvedValue({ receipt: null, routeAuthority: route });
			mocks.preview.mockResolvedValue(receipt(status));
			const source = canonicalAgent();
			if (!source.canonicalSpawn) {
				throw new Error("expected canonical provenance");
			}
			const target = await prepareCanonicalAgentStopV1({
				...source,
				canonicalSpawn: source.canonicalSpawn,
			});

			await expect(executeCanonicalAgentStopV1(target)).rejects.toMatchObject({
				code: `agent_dispatch_stop_${status}`,
			});
			expect(mocks.apply).not.toHaveBeenCalled();
		},
	);

	it("preserves a same-ID successor when terminal status arrives after reload", async () => {
		await durableAppStorage.flush();
		const durable = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		) as {
			state: { agents: Agent[] };
			version: number;
		};
		const successor = canonicalAgent("spawn-2");
		localStorage.setItem(
			DURABLE_APP_STORE_NAME,
			JSON.stringify({
				...durable,
				state: { ...durable.state, agents: [successor] },
			}),
		);
		mocks.status.mockResolvedValue({
			receipt: receipt("workspace_preserved"),
			routeAuthority: route,
		});

		const [result] = await reconcileCanonicalAgentStopsOnceV1();

		expect(result).toMatchObject({ outcome: "unchanged" });
		expect(useStore.getState().agents).toEqual([successor]);
	});

	it("removes the durable pane without overwriting an unrelated layout update", async () => {
		const source = canonicalAgent();
		if (!source.canonicalSpawn) throw new Error("expected canonical provenance");
		useStore.setState({
			agents: [source],
			layouts: {
				"space-source": {
					panels: {
						"agent:agent-1": { id: "agent:agent-1", component: "agent" },
					},
				},
			},
		});
		await durableAppStorage.flush();
		const durable = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		) as {
			state: { agents: Agent[]; layouts: Record<string, unknown> };
			version: number;
		};
		localStorage.setItem(
			DURABLE_APP_STORE_NAME,
			JSON.stringify({
				...durable,
				state: {
					...durable.state,
					layouts: {
						...durable.state.layouts,
						"space-concurrent": {
							panels: { "file:keep": { id: "file:keep" } },
						},
					},
				},
			}),
		);

		const applied = await applyCanonicalAgentStopPresentationV1(
			source.canonicalSpawn,
			receipt("workspace_preserved"),
		);
		await durableAppStorage.flush();

		const persisted = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		) as {
			state: {
				agents: Agent[];
				layouts: Record<string, { panels: Record<string, unknown> }>;
			};
		};
		expect(applied).toBe(true);
		expect(persisted.state.agents).toEqual([]);
		expect(persisted.state.layouts["space-source"].panels).toEqual({});
		expect(persisted.state.layouts["space-concurrent"].panels).toEqual({
			"file:keep": { id: "file:keep" },
		});
	});
});

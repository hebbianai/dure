import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { inspectAgentRuntimeProjection } from "@/lib/agents/agentRuntimeProjectionInspection";
import { installAgentRuntimeProjectionReconciliationRuntime } from "@/lib/agents/agentRuntimeProjectionReconciliationRuntime";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import type { HmuxControlPlaneCensus, HmuxSessionSummary } from "@/lib/ipc";
import type { DureAgentRuntimeInspectResultV1 } from "@/lib/ipc/dureAgentRuntime";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
} from "@/test/dureAgentRuntimeFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent, Project, SshHostConfig } from "@/types";

// The test WebView has no native bridge. Do not leave its unrelated durable-store
// notifications waiting for bridge readiness across fake-clock tests.
vi.mock("@/lib/workspace/window/durableStoreBroadcast", () => ({
	publishDurableStoreChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
	invoke: vi.fn(),
}));

function project(): Project {
	return {
		id: "project-1",
		name: "Project",
		path: "/repo",
		kind: "local",
		isRepo: true,
	};
}

function nativeAgent(index = 1): Agent {
	const stopFence = stopFenceFixture({
		terminalEpoch: `terminal-${index}`,
	});
	return agentFixture({
		id: `agent-${index}`,
		sessionId: `session-${index}`,
		runtimeBinding: managedBindingFixture({
			sessionId: `session-${index}`,
			workspaceId: `workspace-${index}`,
			backendProfileId: "local",
			stopFence,
		}),
	});
}

function summary(agent: Agent, lifecycle: "ready" | "exited" = "ready") {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1") throw new Error("test binding");
	return hmuxSessionSummaryFixture({
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		lifecycle,
		health: lifecycle === "ready" ? "current_healthy" : "exited",
		terminalEpoch: binding.stopFence?.terminalEpoch ?? `terminal-${agent.id}`,
		stopFence: binding.stopFence,
	});
}

function census(sessions: HmuxSessionSummary[]): HmuxControlPlaneCensus {
	return {
		policy: {
			activation: "local_bundled_or_installed_current",
			signedReleaseFetch: "not_implemented",
			signedPackageInstall: "blocked_missing_trust_root",
		},
		sessions,
		protectedBuildIds: [],
	};
}

function stableStructured(
	agent: Agent,
	backendProfileId = "local",
): Extract<DureAgentRuntimeInspectResultV1, { state: "stable" }> {
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
		backendProfileId,
	);
	return {
		state: "stable",
		backend: routeAuthority.backend,
		backendProfileId,
		routeAuthority,
		agentId: agent.id,
		selectionRevision: 2,
		providerId: agent.provider,
		executionProfile: { kind: "provider_default" },
		providerConversationRef: "conversation-1",
		interactionProfile: "structured_protocol",
		interactionSessionId: "interaction-1",
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
	};
}

function stableNative(
	agent: Agent,
): Extract<
	DureAgentRuntimeInspectResultV1,
	{ state: "stable"; interactionProfile: "native_cli" }
> {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || !binding.stopFence) {
		throw new Error("test binding");
	}
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
		binding.backendProfileId ?? "local",
	);
	return {
		state: "stable",
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		agentId: agent.id,
		selectionRevision: 1,
		providerId: agent.provider,
		executionProfile: { kind: "provider_default" },
		providerConversationRef: null,
		interactionProfile: "native_cli",
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		launchIdempotencyKey: binding.createIdempotencyKey ?? null,
		stopFence: binding.stopFence,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
	};
}

function setAgents(
	agents: Agent[],
	projects: Project[] = [project()],
	sshHosts: SshHostConfig[] = [],
) {
	useStore.setState({
		agents,
		projects,
		sshHosts,
		agentActivity: {},
		sessionAgentRuntimeState: {},
		agentRuntimeLaunchPresentation: {},
	});
}

function harness() {
	let censusListener: ((value: HmuxControlPlaneCensus) => void) | undefined;
	const inspect = vi.fn();
	const projectRuntime = vi.fn();
	const warn = vi.fn();
	const convergeUnmanaged = vi.fn().mockResolvedValue(true);
	const runtime = installAgentRuntimeProjectionReconciliationRuntime({
		subscribeCensus: (listener) => {
			censusListener = listener;
			return () => {
				censusListener = undefined;
			};
		},
		snapshot: () => useStore.getState(),
		inspect,
		convergeUnmanaged,
		project: projectRuntime,
		warn,
	});
	return {
		inspect,
		convergeUnmanaged,
		projectRuntime,
		publish: (value: HmuxControlPlaneCensus) => censusListener?.(value),
		runtime,
		warn,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.mocked(invoke).mockReset();
	setAgents([]);
});

it("adopts a completed successor for an unmanaged retired source at startup", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	const routeAuthority = stableNative(agent).routeAuthority;
	const unmanaged = {
		state: "unmanaged" as const,
		agentId: agent.id,
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
	};
	const { inspect, convergeUnmanaged, publish, runtime } = harness();
	inspect.mockResolvedValue(unmanaged);
	const target = { ...nativeAgent(2), id: agent.id };
	convergeUnmanaged.mockImplementation(async (_source, observed, isCurrent) => {
		expect(observed).toBe(unmanaged);
		expect(isCurrent()).toBe(true);
		setAgents([target]);
		return true;
	});

	publish(census([summary(agent, "exited"), summary(target)]));
	await vi.waitFor(() => expect(useStore.getState().agents[0]).toBe(target));
	expect(convergeUnmanaged).toHaveBeenCalledOnce();
	publish(census([summary(agent, "exited"), summary(target)]));
	await Promise.resolve();
	expect(convergeUnmanaged).toHaveBeenCalledOnce();
	runtime.stop();
});

it.each(["pending", "unavailable"])(
	"revisits %s successor evidence without adding a timer or caching it as absent",
	async (state) => {
		const agent = nativeAgent();
		setAgents([agent]);
		const routeAuthority = stableNative(agent).routeAuthority;
		const { inspect, convergeUnmanaged, publish, runtime } = harness();
		inspect.mockResolvedValue({
			state: "unmanaged",
			agentId: agent.id,
			backend: routeAuthority.backend,
			backendProfileId: routeAuthority.profileId,
			routeAuthority,
		});
		if (state === "pending") convergeUnmanaged.mockResolvedValueOnce(false);
		else
			convergeUnmanaged.mockRejectedValueOnce(
				new Error("hmux_descriptor_unavailable"),
			);
		convergeUnmanaged.mockResolvedValue(true);
		const retired = census([summary(agent, "exited")]);
		publish(retired);
		await vi.waitFor(() => expect(convergeUnmanaged).toHaveBeenCalledTimes(1));
		publish(retired);
		await vi.waitFor(() => expect(convergeUnmanaged).toHaveBeenCalledTimes(2));
		publish(retired);
		await Promise.resolve();
		expect(convergeUnmanaged).toHaveBeenCalledTimes(2);
		runtime.stop();
	},
);

it("reconciles concurrent agents without another agent overtaking an inspection retry", async () => {
	const agents = [nativeAgent(1), nativeAgent(2), nativeAgent(3)];
	setAgents(agents);
	const pending: (() => void)[] = [];
	vi.mocked(invoke).mockImplementation((_command, args) => {
		const { body } = args as { body: { agentId: string } };
		const envelope = agentRuntimeBackendEnvelope({ agentId: body.agentId });
		return new Promise((resolve) =>
			pending.push(() =>
				resolve({
					...envelope,
					result: {
						...envelope.result,
						state: "stable",
						projectionContext: agentRuntimeProjectionContext(body.agentId),
					},
				}),
			),
		);
	});
	const { inspect, projectRuntime, runtime, warn } = harness();
	inspect.mockImplementation(inspectAgentRuntimeProjection);
	const request = (agent: Agent) =>
		runtime.request({
			agentId: agent.id,
			evidence: "source-retired",
		});
	try {
		request(agents[0]);
		request(agents[1]);
		pending[1]();
		await vi.waitFor(() => expect(projectRuntime).toHaveBeenCalledOnce());
		pending[0]();
		await vi.waitFor(() =>
			expect(
				projectRuntime.mock.calls.length === 2 || pending.length === 3,
			).toBe(true),
		);
		const retry = pending[2];
		request(agents[2]);
		pending[pending.length - 1]();
		await vi.waitFor(() =>
			expect(projectRuntime).toHaveBeenCalledWith(
				agents[2].id,
				expect.objectContaining({ state: "stable" }),
			),
		);
		retry?.();
		await vi.waitFor(() =>
			expect(projectRuntime.mock.calls.length + warn.mock.calls.length).toBe(3),
		);

		expect(warn).not.toHaveBeenCalled();
		expect(projectRuntime).toHaveBeenCalledTimes(3);
		expect(invoke).toHaveBeenCalledTimes(3);
	} finally {
		runtime.stop();
	}
});

it("performs no backend reads for a healthy native pane population", () => {
	const agents = Array.from({ length: 32 }, (_, index) =>
		nativeAgent(index + 1),
	);
	setAgents(agents);
	const { inspect, publish, runtime } = harness();

	publish(census(agents.map((agent) => summary(agent))));

	expect(inspect).not.toHaveBeenCalled();
	runtime.stop();
});

it("single-flights duplicate retired-source evidence and projects one stable receipt", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	let resolve!: (value: DureAgentRuntimeInspectResultV1) => void;
	const pending = new Promise<DureAgentRuntimeInspectResultV1>((done) => {
		resolve = done;
	});
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect.mockReturnValue(pending);
	const retired = census([summary(agent, "exited")]);

	publish(retired);
	publish(retired);
	expect(inspect).toHaveBeenCalledOnce();
	resolve(stableStructured(agent));
	await vi.waitFor(() => expect(projectRuntime).toHaveBeenCalledOnce());
	publish(retired);
	expect(inspect).toHaveBeenCalledOnce();
	runtime.stop();
});

it("keeps a legitimately exited exact native source exited", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	useStore.setState({ agentActivity: { [agent.id]: "exited" } });
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect.mockResolvedValue({
		...stableNative(agent),
		// Revision-one checkpoint adoption predates launch metadata. The exact
		// persisted source supplies its already-known idempotency key.
		launchIdempotencyKey: null,
	});

	publish(census([summary(agent, "exited")]));
	await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());

	expect(projectRuntime).not.toHaveBeenCalled();
	expect(useStore.getState().agentActivity[agent.id]).toBe("exited");
	runtime.stop();
});

it.each(["exited", "absent"])(
	"recovers a missed rehost event from an %s source, including after projection restart",
	async (sourceState) => {
		const source = nativeAgent();
		const successor = { ...nativeAgent(2), id: source.id };
		const committed = stableNative(successor);
		const observation = census([
			...(sourceState === "exited" ? [summary(source, "exited")] : []),
			summary(successor),
		]);

		// Each installation starts from a stale persisted WebView projection.
		// Neither receives agent:managed-rehosted; only the native census and the
		// durable control-plane Stable receipt can advance its binding.
		for (let installation = 0; installation < 2; installation += 1) {
			setAgents([source]);
			const { inspect, projectRuntime, publish, runtime } = harness();
			inspect.mockResolvedValue(committed);
			projectRuntime.mockImplementation(projectAgentRuntimeTransition);
			try {
				publish(observation);
				publish(observation);
				await vi.waitFor(() =>
					expect(useStore.getState().agents[0].sessionId).toBe("session-2"),
				);
				expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
					sessionId: committed.sessionId,
					workspaceId: committed.workspaceId,
					stopFence: committed.stopFence,
				});
				publish(observation);
				expect(inspect).toHaveBeenCalledOnce();
				expect(projectRuntime).toHaveBeenCalledOnce();
			} finally {
				runtime.stop();
			}
		}
	},
);

it("re-inspects a handled retired source once another live session starts in its workspace", async () => {
	// A runtime wake from the CLI or another client starts the conversation on
	// a new root in the same runtime workspace without notifying this window.
	const agent = nativeAgent();
	const woken = agentFixture({
		id: agent.id,
		sessionId: "session-woken",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-woken",
			workspaceId: "workspace-1",
			backendProfileId: "local",
			stopFence: stopFenceFixture({ terminalEpoch: "terminal-woken" }),
		}),
	});
	setAgents([agent]);
	const { inspect, projectRuntime, publish, runtime } = harness();
	projectRuntime.mockImplementation(projectAgentRuntimeTransition);
	inspect.mockResolvedValueOnce(stableNative(agent));

	publish(census([summary(agent, "exited")]));
	await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
	publish(census([summary(agent, "exited")]));
	expect(inspect).toHaveBeenCalledOnce();

	inspect.mockResolvedValueOnce(stableNative(woken));
	publish(census([summary(agent, "exited"), summary(woken)]));
	await vi.waitFor(() =>
		expect(useStore.getState().agents[0].sessionId).toBe("session-woken"),
	);
	expect(inspect).toHaveBeenCalledTimes(2);
	runtime.stop();
});

it("projects an authoritative native launch key that differs from the local source", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect.mockResolvedValue({
		...stableNative(agent),
		launchIdempotencyKey: "create-replacement",
	});

	publish(census([summary(agent, "exited")]));
	await vi.waitFor(() => expect(projectRuntime).toHaveBeenCalledOnce());

	expect(projectRuntime).toHaveBeenCalledWith(
		agent.id,
		expect.objectContaining({
			interactionProfile: "native_cli",
			launchIdempotencyKey: "create-replacement",
		}),
	);
	runtime.stop();
});

it("does not inspect census absence during the positive spawn gap", () => {
	const agent = nativeAgent();
	setAgents([agent]);
	useStore.setState({ agentActivity: { [agent.id]: "connecting" } });
	const { inspect, publish, runtime } = harness();

	publish(census([]));

	expect(inspect).not.toHaveBeenCalled();
	runtime.stop();
});

it("replays newer evidence that arrives behind an older in-flight snapshot", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	let resolve!: (value: DureAgentRuntimeInspectResultV1) => void;
	const first = new Promise<DureAgentRuntimeInspectResultV1>((done) => {
		resolve = done;
	});
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
	);
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect
		.mockReturnValueOnce(first)
		.mockResolvedValueOnce(stableStructured(agent));
	const retired = summary(agent, "exited");

	publish(census([retired]));
	publish(census([{ ...retired, outputSeq: "1" }]));
	resolve({
		state: "unmanaged",
		agentId: agent.id,
		backend: routeAuthority.backend,
		backendProfileId: "local",
		routeAuthority,
	});

	await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
	await vi.waitFor(() => expect(projectRuntime).toHaveBeenCalledOnce());
	runtime.stop();
});

it("drops a delayed observation after the exact native source changes", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	let resolve!: (value: DureAgentRuntimeInspectResultV1) => void;
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect.mockReturnValue(
		new Promise<DureAgentRuntimeInspectResultV1>((done) => {
			resolve = done;
		}),
	);

	publish(census([summary(agent, "exited")]));
	setAgents([{ ...nativeAgent(2), id: agent.id }]);
	resolve(stableStructured(agent));
	await Promise.resolve();
	await Promise.resolve();

	expect(projectRuntime).not.toHaveBeenCalled();
	runtime.stop();
});

it("does not project an in-flight snapshot after the service stops", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	let resolve!: (value: DureAgentRuntimeInspectResultV1) => void;
	const { inspect, projectRuntime, publish, runtime, warn } = harness();
	inspect.mockReturnValue(
		new Promise<DureAgentRuntimeInspectResultV1>((done) => {
			resolve = done;
		}),
	);

	publish(census([summary(agent, "exited")]));
	runtime.stop();
	resolve(stableStructured(agent));
	await Promise.resolve();
	await Promise.resolve();

	expect(projectRuntime).not.toHaveBeenCalled();
	expect(warn).not.toHaveBeenCalled();
});

it("treats manifest and runtime-health exits as retired", async () => {
	const agents = [nativeAgent(1), nativeAgent(2)];
	setAgents(agents);
	const { inspect, publish, runtime } = harness();
	inspect.mockImplementation(async (source) => {
		const agent = agents.find((candidate) => candidate.id === source.agentId);
		if (!agent) throw new Error("test agent");
		return stableNative(agent);
	});

	publish(
		census([
			{ ...summary(agents[0]), manifestLifecycle: "exited" },
			{ ...summary(agents[1]), health: "exited" },
		]),
	);

	await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
	runtime.stop();
});

it("does not collapse distinct census generations into one handled hint", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	const { inspect, publish, runtime } = harness();
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
	);
	inspect.mockResolvedValue({
		state: "unmanaged",
		agentId: agent.id,
		backend: routeAuthority.backend,
		backendProfileId: "local",
		routeAuthority,
	});
	const firstFence = stopFenceFixture({ runnerInstance: "replacement-1" });
	const secondFence = stopFenceFixture({ runnerInstance: "replacement-2" });

	publish(
		census([
			{
				...summary(agent),
				terminalEpoch: firstFence.terminalEpoch,
				stopFence: firstFence,
			},
		]),
	);
	await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
	publish(
		census([
			{
				...summary(agent),
				terminalEpoch: secondFence.terminalEpoch,
				stopFence: secondFence,
			},
		]),
	);

	await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
	runtime.stop();
});

it("retries equal evidence after transport failure instead of caching it", async () => {
	const agent = nativeAgent();
	setAgents([agent]);
	const { inspect, publish, runtime, warn } = harness();
	inspect.mockRejectedValue(new Error("transport unavailable"));
	const retired = census([summary(agent, "exited")]);

	publish(retired);
	await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
	publish(retired);
	await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
	runtime.stop();
});

it("bounds a backend that remains transitioning", async () => {
	vi.useFakeTimers();
	const agent = nativeAgent();
	setAgents([agent]);
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
	);
	const { inspect, projectRuntime, runtime } = harness();
	inspect.mockResolvedValue({
		state: "transitioning",
		agentId: agent.id,
		operationId: "operation-1",
		stage: "source_stopped",
		journalRevision: 2,
		targetInteractionProfile: "structured_protocol",
		targetExecutionProfile: { kind: "provider_default" },
		backend: routeAuthority.backend,
		backendProfileId: "local",
		routeAuthority,
	});

	runtime.request({ agentId: agent.id, evidence: "source-retired" });
	await vi.runAllTimersAsync();

	expect(inspect).toHaveBeenCalledTimes(8);
	expect(projectRuntime).not.toHaveBeenCalled();
	runtime.stop();
});

it("accepts an SSH semantic hint without treating the local census as SSH authority", async () => {
	const remoteAgent = agentFixture({
		id: "agent-remote",
		projectId: "project-remote",
		sessionId: "session-remote",
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "ssh-profile",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
			backendProfileId: "ssh-profile",
			stopFence: stopFenceFixture(),
		},
	});
	setAgents(
		[remoteAgent],
		[
			{
				id: "project-remote",
				name: "Remote",
				path: "/repo",
				kind: "ssh",
				sshHostId: "ssh-profile",
				isRepo: true,
			},
		],
		[
			{
				id: "ssh-profile",
				name: "Remote",
				host: "backend.example.test",
				port: 22,
				user: "dure",
				auth: "auto",
			},
		],
	);
	const { inspect, projectRuntime, publish, runtime } = harness();
	inspect.mockResolvedValue(stableStructured(remoteAgent, "ssh-profile"));

	publish(census([]));
	expect(inspect).not.toHaveBeenCalled();
	runtime.request({
		agentId: remoteAgent.id,
		evidence: "semantic_runtime_exited:terminal-remote:2",
	});
	await vi.waitFor(() => expect(projectRuntime).toHaveBeenCalledOnce());
	expect(inspect).toHaveBeenCalledWith({
		agentId: remoteAgent.id,
		backendProfileId: "ssh-profile",
		key: expect.any(String),
	});
	runtime.stop();
});

it("rejects an SSH snapshot whose exact backend target was remapped", async () => {
	const remoteAgent = agentFixture({
		id: "agent-remote",
		projectId: "project-remote",
		sessionId: "session-remote",
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "ssh-profile",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
			backendProfileId: "ssh-profile",
			stopFence: stopFenceFixture(),
		},
	});
	setAgents(
		[remoteAgent],
		[
			{
				id: "project-remote",
				name: "Remote",
				path: "/repo",
				kind: "ssh",
				sshHostId: "ssh-profile",
				isRepo: true,
			},
		],
		[
			{
				id: "ssh-profile",
				name: "Remote",
				host: "expected.example.test",
				port: 22,
				user: "dure",
				auth: "auto",
			},
		],
	);
	const { inspect, projectRuntime, runtime, warn } = harness();
	inspect.mockResolvedValue(stableStructured(remoteAgent, "ssh-profile"));

	runtime.request({ agentId: remoteAgent.id, evidence: "source-retired" });
	await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
	expect(projectRuntime).not.toHaveBeenCalled();
	runtime.stop();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendCapabilities, type TauriCoreModule } from "@/lib/ipc/core";
import {
	createManagedRefreshTiming,
	type ManagedCreateDiagnostics,
} from "@/lib/hmux/managed/managedRefreshTiming";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), resolvePane: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@/lib/workspace/dock", () => ({ resolvePaneById: mocks.resolvePane }));
vi.mock("@/lib/agents/agentAttentionNotifier", () => ({
	notifyAgentEvent: vi.fn(),
}));

import { installAgentTracker } from "@/lib/agents/agentTracker";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { commitManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { durableAppStorage, useStore } from "@/store";
import {
	createNativeRehostBackendFixture,
	nativeResumeCreateFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";
import { resumeExactManagedAgentPane } from "./managedExactConversationResume";

let generation: number;
let backend: ReturnType<typeof createNativeRehostBackendFixture>;
let stopTracker: () => void;
let presentations: Array<() => void>;
let completions: Array<Promise<unknown>>;

beforeEach(async () => {
	generation = 1;
	backend = createNativeRehostBackendFixture();
	presentations = [];
	completions = [];
	mocks.resolvePane
		.mockReset()
		.mockImplementation(
			() => new Promise((resolve) => presentations.push(() => resolve(null))),
		);
	mocks.invoke.mockReset().mockImplementation((command, args) => {
		if (command === "app_caps")
			return Promise.resolve({
				name: "Dure",
				packageVersion: "0.1.4",
				protocolVersion: 1,
				buildId: "native-resume-fixture",
				features: ["hmux.managed-create-advance-v1"],
			});
		if (command === "dure_backend_route_assert")
			return nativeResumePayloadFixture(1).backendRouteAuthority;
		if (command === "hmux_managed_create_advance_v1") {
			const receipt = nativeResumeCreateFixture(generation);
			backend.prepare({
				...nativeResumePayloadFixture(generation),
				operationId: receipt.idempotencyKey,
			});
			return { state: "advanced", receipt };
		}
		return backend.handleRequest(command, args);
	});
	await backendCapabilities(true);
	useStore.setState({
		agents: [managedRehostAgentFixture(0)],
		accounts: [],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		layouts: {},
		agentActivity: { "agent-1": "exited" },
		sessionAgentRuntimeState: {},
		hmuxSessionMetadata: {},
		agentRuntimeLaunchPresentation: {},
		sessionCwd: {},
	});
	stopTracker = installAgentTracker();
});

afterEach(async () => {
	for (const release of presentations) release();
	await Promise.allSettled(completions);
	for (const pending of backend.pending) pending.lose();
	await new Promise((resolve) => setTimeout(resolve, 0));
	stopTracker();
	await durableAppStorage.flush();
});

async function startResume(diagnostics?: ManagedCreateDiagnostics) {
	const index = presentations.length;
	const done = resumeExactManagedAgentPane(
		"agent-1",
		"agent:agent-1",
		`conversation-${generation}`,
		diagnostics,
	);
	completions.push(done);
	await vi.waitFor(() => expect(presentations).toHaveLength(index + 1));
	return { done, finish: presentations[index] };
}

function observe(
	activity: "working" | "waiting" | "exited",
	target = generation,
) {
	useStore.getState().setSessionAgentRuntimeState(`session-${target}`, {
		terminalEpoch: `terminal-${target}`,
		revision: "1",
		observedThroughOutputSeq: "42",
		lifecycle: activity === "exited" ? "exited" : "running",
		activity: activity === "exited" ? "waiting" : activity,
		attention: "none",
		source: "controller_input",
		turnCompletedCount: "0",
	});
}

describe("native Resume presentation completion", () => {
	it("keeps same-source retry checkpoints ordered without changing either launch input", async () => {
		const timing = createManagedRefreshTiming();
		const originalInvoke = mocks.invoke.getMockImplementation()!;
		let attempts = 0;
		mocks.invoke.mockImplementation((command, args) => {
			if (command === "hmux_managed_create_advance_v1" && attempts++ === 0) {
				return {
					state: "retry_same",
					reason: "create_retryable",
					code: "pending",
					message: "pending",
				};
			}
			return originalInvoke(command, args);
		});
		const resume = await startResume({ brokerTiming: true, timing });
		resume.finish();
		await resume.done;
		const calls = mocks.invoke.mock.calls.filter(
			([cmd]) => cmd === "hmux_managed_create_advance_v1",
		);
		expect(calls).toHaveLength(2);
		expect(calls[0][1]).toEqual(calls[1][1]);
		expect(
			timing
				.snapshot()
				.checkpoints.filter(({ phase }) => phase.startsWith("invoke."))
				.map(({ phase }) => phase),
		).toEqual([
			"invoke.start",
			"invoke.received",
			"invoke.start",
			"invoke.received",
		]);
		expect(timing.snapshot().truncated).toBe(false);
	});

	it("labels joining an existing resume instead of attributing its work to a second launch", async () => {
		const originalInvoke = mocks.invoke.getMockImplementation()!;
		let releaseLaunch: (() => void) | undefined;
		mocks.invoke.mockImplementation(async (command, args) => {
			if (command === "hmux_managed_create_advance_v1") {
				await new Promise<void>((resolve) => {
					releaseLaunch = resolve;
				});
			}
			return originalInvoke(command, args);
		});
		const first = startResume();
		await vi.waitFor(() => expect(releaseLaunch).toBeDefined());
		const timing = createManagedRefreshTiming();
		const joined = resumeExactManagedAgentPane(
			"agent-1",
			"agent:agent-1",
			"conversation-1",
			{ brokerTiming: true, timing },
		);
		completions.push(joined);
		releaseLaunch?.();
		const resume = await first;
		resume.finish();
		await Promise.all([resume.done, joined]);
		expect(
			mocks.invoke.mock.calls.filter(
				([cmd]) => cmd === "hmux_managed_create_advance_v1",
			),
		).toHaveLength(1);
		expect(timing.snapshot().checkpoints.map(({ phase }) => phase)).toEqual([
			"action.start",
			"resume.prepare",
			"resume.join",
		]);
	});

	it("separates capability, native invoke and projection waits without changing the launch", async () => {
		let now = 100;
		const timing = createManagedRefreshTiming({
			now: () => now,
			unixMs: () => 1000,
		});
		const originalInvoke = mocks.invoke.getMockImplementation()!;
		let releaseCapabilities: () => void = () => {};
		mocks.invoke.mockImplementation(async (command, args) => {
			if (command === "app_caps") {
				await new Promise<void>((resolve) => {
					releaseCapabilities = resolve;
				});
			}
			if (command === "hmux_managed_create_advance_v1") now += 30;
			return originalInvoke(command, args);
		});
		const capabilities = backendCapabilities(true);
		const pending = startResume({ brokerTiming: true, timing });
		await vi.waitFor(() => {
			const checkpoints = timing.snapshot().checkpoints;
			expect(checkpoints[checkpoints.length - 1]?.phase).toBe("capabilities.start");
		});
		expect(
			mocks.invoke.mock.calls.some(
				([cmd]) => cmd === "hmux_managed_create_advance_v1",
			),
		).toBe(false);
		now += 20;
		releaseCapabilities();
		await capabilities;
		const resume = await pending;
		now += 40;
		resume.finish();
		await resume.done;
		expect(timing.snapshot().checkpoints).toEqual([
			{ phase: "action.start", elapsedMs: 0 },
			{ phase: "resume.prepare", elapsedMs: 0 },
			{ phase: "launch.ready", elapsedMs: 0 },
			{ phase: "capabilities.start", elapsedMs: 0 },
			{ phase: "capabilities.ready", elapsedMs: 20 },
			{ phase: "invoke.start", elapsedMs: 20 },
			{ phase: "invoke.received", elapsedMs: 50 },
			{ phase: "resolution.ready", elapsedMs: 50 },
			{ phase: "projection.start", elapsedMs: 50 },
			{ phase: "projection.ready", elapsedMs: 90 },
			{ phase: "resume.publish", elapsedMs: 90 },
		]);
		const [, args] = mocks.invoke.mock.calls.find(
			([cmd]) => cmd === "hmux_managed_create_advance_v1",
		)!;
		expect(args).not.toHaveProperty("timing");
		expect(args.request).not.toHaveProperty("timing");
		expect(args.request).not.toHaveProperty("brokerTiming");
		expect(useStore.getState().agents[0]).not.toHaveProperty("timing");
		expect(useStore.getState().agents[0].runtimeBinding).not.toHaveProperty(
			"timing",
		);
	});
	it.each([true, false, undefined])(
		"forwards only the requested broker timing option (%s), outside launch identity",
		async (enabled) => {
			const pending = await startResume(
				enabled === undefined ? undefined : { brokerTiming: enabled },
			);
			pending.finish();
			await pending.done;
			const [, args] = mocks.invoke.mock.calls.find(
				([command]) => command === "hmux_managed_create_advance_v1",
			)!;
			expect(args.brokerTiming).toBe(enabled === true ? true : undefined);
			expect(args.request).not.toHaveProperty("brokerTiming");
			expect(args.request.replaceCurrent).toBe(true);
			expect(args.request.conversationId).toBe("conversation-1");
			const agent = useStore.getState().agents[0];
			expect(agent).not.toHaveProperty("brokerTiming");
			expect(agent.runtimeBinding).not.toHaveProperty("brokerTiming");
		},
	);
	it("rejects a legacy adapter before invoking Resume or changing the existing pane", async () => {
		const original = useStore.getState().agents[0];
		mocks.invoke.mockImplementation(async (command) => {
			if (command === "app_caps")
				return {
					name: "Dure",
					packageVersion: "0.1.4",
					protocolVersion: 1,
					buildId: "legacy-native-fixture",
					features: ["hmux.managed-create-v1"],
				};
			throw new Error(`Command ${command} not found`);
		});
		await backendCapabilities(true);
		mocks.invoke.mockClear();

		await expect(
			resumeExactManagedAgentPane("agent-1", "agent:agent-1", "conversation-1"),
		).rejects.toThrow("hmux_managed_create_advance_v1_backend_unavailable");
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toBe(original);
		expect(mocks.resolvePane).not.toHaveBeenCalled();
	});

	it("preserves the source and reports one uncertain invoke without inventing a retry", async () => {
		const original = useStore.getState().agents[0];
		mocks.invoke.mockClear().mockRejectedValue(new Error("response lost"));
		await expect(
			resumeExactManagedAgentPane("agent-1", "agent:agent-1", "conversation-1"),
		).rejects.toMatchObject({
			code: "managed_create_retry_same",
			backendCode: "managed_create_outcome_unknown",
		});
		expect(mocks.invoke).toHaveBeenCalledOnce();
		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_managed_create_advance_v1",
			{
				request: expect.objectContaining({ replaceCurrent: true }),
			},
		);
		expect(useStore.getState().agents[0]).toBe(original);
		expect(mocks.resolvePane).not.toHaveBeenCalled();
	});

	it("initializes activity with the new Ready binding before pane lookup completes", async () => {
		await startResume();
		expect(useStore.getState().agents[0].sessionId).toBe("session-1");
		expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
	});

	it.each(["working", "waiting", "exited"] as const)(
		"preserves the newer Host %s observation after delayed presentation",
		async (activity) => {
			const pending = await startResume();
			observe(activity);
			expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
			pending.finish();
			await expect(pending.done).resolves.toMatchObject({
				projection: "applied",
			});
			expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
		},
	);

	it("retains newer Hmux census metadata instead of replaying the Ready summary", async () => {
		const pending = await startResume();
		const observed = {
			...nativeResumeCreateFixture(1).session,
			outputSeq: "42",
			hostProcessAlive: true,
		};
		useStore.getState().setHmuxSessionMetadata(observed);
		const key = hmuxSessionMetadataKey("workspace-1", "session-1");
		const current = useStore.getState().hmuxSessionMetadata[key];
		pending.finish();
		await pending.done;
		expect(useStore.getState().hmuxSessionMetadata[key]).toBe(current);
	});

	it("does not change a later successor when an earlier pane lookup finishes last", async () => {
		const first = await startResume();
		generation = 2;
		const second = await startResume();
		second.finish();
		await second.done;
		observe("working");
		first.finish();
		await expect(first.done).resolves.toMatchObject({ projection: "pending" });
		expect(useStore.getState().agents[0].sessionId).toBe("session-2");
		expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
	});

	it("does not recreate activity for an Agent removed during presentation", async () => {
		const pending = await startResume();
		useStore.setState({ agents: [], agentActivity: {} });
		pending.finish();
		await expect(pending.done).resolves.toMatchObject({
			projection: "pending",
		});
		expect(useStore.getState().agents).toEqual([]);
		expect(useStore.getState().agentActivity).toEqual({});
	});

	it("does not initialize activity again for the same Ready while publication is lost", async () => {
		const pending = await startResume();
		pending.finish();
		await pending.done;
		await vi.waitFor(() => expect(backend.pending).toHaveLength(1));
		backend.pending[0].lose();
		observe("working");
		const payload = nativeResumePayloadFixture(1);
		backend.prepare(payload);
		const replay = commitManagedAgentRehostReceipt(payload);
		completions.push(replay);
		expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
		presentations[1]();
		await replay;
		expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
	});
});

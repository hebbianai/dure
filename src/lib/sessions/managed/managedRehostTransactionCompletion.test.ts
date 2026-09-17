// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriCoreModule } from "@/lib/ipc/core";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	inspect: vi.fn(),
	execute: vi.fn(),
	reconcile: vi.fn(),
	reconcileOperation: vi.fn(),
	resolvePane: vi.fn(),
	emit: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@/lib/workspace/dock", () => ({ resolvePaneById: mocks.resolvePane }));
vi.mock("@/lib/agents/agentAttentionNotifier", () => ({
	notifyAgentEvent: vi.fn(),
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: vi.fn(async () => true),
}));
vi.mock("@/lib/sessions/recovery/exitedManagedAgentRecovery", () => ({
	inspectManagedAgentRecoveryRequest: mocks.inspect,
	executeManagedAgentRecoveryRequest: mocks.execute,
}));
vi.mock("@/lib/sessions/managed/managedAgentRecoveryReceipt", () => ({
	reconcileManagedAgentRecoveryOperation: mocks.reconcileOperation,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehost", async (original) => ({
	...(await original<
		typeof import("@/lib/sessions/managed/managedAgentRehost")
	>()),
	reconcileManagedAgentRehost: mocks.reconcile,
}));

import { installAgentTracker } from "@/lib/agents/agentTracker";
import { handleCliHmuxRehost } from "@/lib/cli/cliHmuxRehost";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { resetFrameBudgetSchedulerForTest } from "@/lib/scheduling/frameBudgetScheduler";
import { commitManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { rehostManagedBuild } from "@/lib/sessions/managed/managedBuildRehostWorkflow";
import { durableAppStorage, useStore } from "@/store";
import { createNativeRehostBackendFixture } from "@/test/managedNativeRehostFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";
import { managedRehostTransactionFixture } from "@/test/managedRehostTransactionFixtures";

const first = managedRehostTransactionFixture(1);
const key = hmuxSessionMetadataKey("workspace-1", "session-1");
type Consumer = "ui" | "cli" | "operation replay";
let backend: ReturnType<typeof createNativeRehostBackendFixture>;
let presentations: Array<() => void>;
let operations: Array<Promise<unknown>>;
let stopTracker: () => void;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	resetFrameBudgetSchedulerForTest();
	backend = createNativeRehostBackendFixture();
	backend.prepare(first.payload);
	presentations = [];
	operations = [];
	mocks.invoke.mockReset().mockImplementation(backend.handleRequest);
	mocks.emit.mockReset().mockResolvedValue(undefined);
	mocks.inspect.mockReset().mockResolvedValue(first.inspection);
	mocks.execute.mockReset().mockResolvedValue({ recovery: first.recovery });
	mocks.reconcile.mockReset().mockResolvedValue(null);
	mocks.reconcileOperation.mockReset().mockResolvedValue(first.recovery);
	mocks.resolvePane
		.mockReset()
		.mockImplementation(
			() => new Promise((resolve) => presentations.push(() => resolve(null))),
		);
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
		spaces: [{ id: "desk-1", name: "Desktop" }],
		activeSpaceId: "desk-1",
		layouts: {},
		agentActivity: {},
		sessionAgentRuntimeState: {},
		hmuxSessionMetadata: {},
		agentRuntimeLaunchPresentation: {},
		sessionCwd: {},
		sshHosts: [],
	});
	stopTracker = installAgentTracker();
});

afterEach(async () => {
	stopTracker();
	for (let index = 0; index < 3; index += 1) {
		for (const response of backend.pending) response.reply();
		for (const finish of presentations) finish();
		await flush();
	}
	await Promise.allSettled(operations);
	resetFrameBudgetSchedulerForTest();
	vi.useRealTimers();
	await durableAppStorage.flush();
});

function start(consumer: Consumer) {
	const operation =
		consumer === "ui"
			? rehostManagedBuild("agent-1", "agent:agent-1")
			: handleCliHmuxRehost(
					{
						name: "agent-1",
						targetPanelId: "agent:agent-1",
						confirmRestart: consumer === "cli",
						...(consumer === "operation replay"
							? { operationId: first.payload.operationId }
							: {}),
					},
					"request-1",
				);
	operations.push(operation);
	void operation.catch(() => undefined);
	return operation;
}

async function begin(consumer: Consumer) {
	const completion = start(consumer);
	await flush();
	expect(backend.pending).toHaveLength(1);
	backend.pending[0].reply();
	await flush();
	expect(presentations).toHaveLength(1);
	expect(useStore.getState().agents[0].sessionId).toBe("session-1");
	expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
	return { completion };
}

async function finish(
	consumer: Consumer,
	completion: ReturnType<typeof start>,
) {
	presentations[0]();
	const result = await completion;
	if (consumer !== "ui") {
		expect(result).toMatchObject({
			ok: true,
			rehost: {
				outcome: "rehosted",
				replayed: consumer === "operation replay",
				replacementSession: { sessionId: "session-1" },
			},
		});
	}
	expect(mocks.execute).toHaveBeenCalledTimes(
		consumer === "operation replay" ? 0 : 1,
	);
	if (consumer === "operation replay") {
		expect(mocks.reconcileOperation).toHaveBeenCalledWith(
			first.inspection.sourceBinding,
			first.payload.operationId,
		);
	}
}

function observe(activity: "working" | "waiting" | "exited", generation = 1) {
	useStore.getState().setSessionAgentRuntimeState(`session-${generation}`, {
		terminalEpoch: `terminal-${generation}`,
		revision: "1",
		observedThroughOutputSeq: "42",
		lifecycle: activity === "exited" ? "exited" : "running",
		activity: activity === "exited" ? "waiting" : activity,
		attention: "none",
		source: "controller_input",
		turnCompletedCount: "0",
	});
}

describe.each(["ui", "cli", "operation replay"] as const)(
	"shared rehost completion through %s",
	(consumer) => {
		it("initializes activity once and completes without a mounted pane", async () => {
			const { completion } = await begin(consumer);
			await finish(consumer, completion);
			expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
		});

		it.each(["working", "waiting", "exited"] as const)(
			"preserves a newer %s observation while pane lookup settles",
			async (activity) => {
				const { completion } = await begin(consumer);
				observe(activity);
				expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
				await finish(consumer, completion);
				expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
			},
		);

		it.each(["backend", "pane"])(
			"preserves census metadata received during the delayed %s response",
			async (boundary) => {
				const completion = start(consumer);
				await flush();
				expect(backend.pending).toHaveLength(1);
				if (boundary === "pane") {
					backend.pending[0].reply();
					await flush();
				}
				useStore.getState().setHmuxSessionMetadata({
					...first.recovery.replacement,
					outputSeq: "42",
				});
				const current = useStore.getState().hmuxSessionMetadata[key];
				backend.pending[0].reply();
				await flush();
				await finish(consumer, completion);
				expect(useStore.getState().hmuxSessionMetadata[key]?.outputSeq).toBe(
					"42",
				);
				expect(useStore.getState().hmuxSessionMetadata[key]).toBe(current);
			},
		);

		it("does not recreate activity after Agent removal", async () => {
			const { completion } = await begin(consumer);
			useStore.setState({ agents: [], agentActivity: {} });
			await finish(consumer, completion);
			expect(useStore.getState().agents).toEqual([]);
			expect(useStore.getState().agentActivity).toEqual({});
		});

		it("keeps a newer successor when the old pane lookup finishes last", async () => {
			const { completion } = await begin(consumer);
			const next = managedRehostTransactionFixture(2, "conversation-0");
			backend.prepare(next.payload);
			const successor = commitManagedAgentRehostReceipt(next.payload);
			operations.push(successor);
			await flush();
			backend.pending[1].reply();
			await flush();
			presentations[1]();
			await successor;
			observe("working", 2);
			await finish(consumer, completion);
			expect(useStore.getState().agents[0].sessionId).toBe("session-2");
			expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
		});

		it("recovers a lost commit response by querying the same operation", async () => {
			const completion = start(consumer);
			await flush();
			expect(backend.pending).toHaveLength(1);
			backend.pending[0].lose();
			await flush();
			if (consumer === "ui") {
				await expect(completion).rejects.toThrow(
					"Fixture response lost after commit",
				);
			} else {
				expect(await completion).toMatchObject({ ok: false });
			}
			expect(useStore.getState().agents[0].sessionId).toBe("session-0");
			const replay = start("operation replay");
			await flush();
			expect(presentations).toHaveLength(1);
			observe("working");
			presentations[0]();
			expect(await replay).toMatchObject({
				ok: true,
				rehost: {
					replayed: true,
					replacementSession: { sessionId: "session-1" },
				},
			});
			expect(mocks.execute).toHaveBeenCalledTimes(
				consumer === "operation replay" ? 0 : 1,
			);
			expect(backend.pending).toHaveLength(1);
			expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
		});

		it("keeps newer activity when notification fails after commit", async () => {
			mocks.emit.mockRejectedValue(new Error("Fixture notification lost"));
			const { completion } = await begin(consumer);
			observe("working");
			await finish(consumer, completion);
			expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
		});
	},
);

it("does not execute a CLI preview or replace an unavailable exact operation", async () => {
	const params = { name: "agent-1", targetPanelId: "agent:agent-1" };
	await expect(handleCliHmuxRehost(params, "preview")).resolves.toMatchObject({
		ok: false,
		error: { code: "update_requires_confirmation" },
	});
	mocks.reconcileOperation.mockResolvedValueOnce(null);
	await expect(
		handleCliHmuxRehost({ ...params, operationId: "missing" }, "lookup"),
	).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
	expect(mocks.execute).not.toHaveBeenCalled();
	expect(backend.pending).toHaveLength(0);
	expect(useStore.getState().agents[0].sessionId).toBe("session-0");
});

import { describe, expect, it } from "vitest";
import type { DelegateOnceReceiptV1 } from "@/lib/ipc/dureWorkflow";
import {
	beginDelegateOnceIntent,
	completeDelegateOnceIntent,
	type DelegateOnceIntentStorage,
	delegateOnceContributionId,
	delegateOnceIntentStorageKey,
	projectDelegateOnceWorker,
	readDelegateOnceIntents,
	recordDelegateOnceBinding,
	recordDelegateOnceRouteAuthority,
} from "@/lib/workflows/delegateOnce";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

function storage(): DelegateOnceIntentStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

const stopFence = {
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "terminal",
};

const coordinator: Agent = agentFixture({
	name: "coordinator",
	displayName: "Coordinator",
	worktreePath: "/repo",
	branch: "agent/coordinator",
	sessionId: "coordinator-session",
	runtimeBinding: managedBindingFixture({
		sessionId: "coordinator-session",
		createIdempotencyKey: undefined,
		stopFence,
	}),
});

function activeReceipt(): DelegateOnceReceiptV1 {
	const digest = "b".repeat(64);
	return {
		schemaVersion: 1,
		idempotencyKey: "delegate-once-test",
		runId: `run.${digest}`,
		taskId: `task.${digest}`,
		dispatchId: `dispatch.${digest}`,
		generation: 1,
		status: "active",
		launchIdempotencyKey: `workflow:${digest}`,
		effectiveLaunchIdempotencyKey: "workflow:successor",
		session: {
			sessionId: "worker-session",
			workspaceId: "workspace-1",
			providerId: "codex",
			...stopFence,
		},
		promptDelivery: {
			idempotencyKey: "workflow-prompt",
			state: "written_to_pty",
		},
		createdAtMs: 1,
		updatedAtMs: 2,
	};
}

function begin(memory: DelegateOnceIntentStorage) {
	return beginDelegateOnceIntent(
		{
			contributionId: "dure.core.delegate-once",
			desktopId: "desktop-1",
			coordinator,
			task: { summary: "Review", instructions: "Review only this change." },
			providerId: "codex",
		},
		memory,
	);
}

describe("delegate-once intent", () => {
	it("persists every input before adding the exact binding generation", () => {
		const memory = storage();
		const intent = begin(memory);
		expect(readDelegateOnceIntents(memory)).toEqual([intent]);
		expect(intent.contributionId).toBe("dure.core.delegate-once");
		const bound = recordDelegateOnceBinding(intent, 3, memory);
		expect(readDelegateOnceIntents(memory)[0]).toEqual(bound);
		expect(bound.coordinator.bindingGeneration).toBe(3);
		completeDelegateOnceIntent(intent.idempotencyKey, memory);
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("maps legacy schema-v1 journals to the bundled core contribution", () => {
		const memory = storage();
		begin(memory);
		const journal = JSON.parse(
			memory.getItem(delegateOnceIntentStorageKey) ?? "null",
		) as { intents: Array<{ contributionId?: string }> };
		delete journal.intents[0]?.contributionId;
		memory.setItem(delegateOnceIntentStorageKey, JSON.stringify(journal));
		const [legacy] = readDelegateOnceIntents(memory);
		expect(delegateOnceContributionId(legacy)).toBe("dure.core.delegate-once");
	});

	it("reads a legacy route-less journal and persists its first exact lease once", () => {
		const memory = storage();
		const legacy = begin(memory);
		expect(legacy.routeAuthority).toBeUndefined();
		const route = testDureBackendRouteAuthority("backend-a", "generation-a");
		const leased = recordDelegateOnceRouteAuthority(legacy, route, memory);
		expect(readDelegateOnceIntents(memory)[0]?.routeAuthority).toEqual(route);
		expect(recordDelegateOnceRouteAuthority(leased, route, memory)).toEqual(
			leased,
		);
		expect(() =>
			recordDelegateOnceRouteAuthority(
				leased,
				testDureBackendRouteAuthority("backend-b", "generation-b"),
				memory,
			),
		).toThrow();
	});

	it("returns the same pending intent instead of creating a second dispatch", () => {
		const memory = storage();
		const first = begin(memory);
		const second = beginDelegateOnceIntent(
			{
				contributionId: "dure.core.delegate-once",
				desktopId: "desktop-1",
				coordinator,
				task: { summary: "Different", instructions: "Must not replace." },
				providerId: "claude",
			},
			memory,
		);
		expect(second).toEqual(first);
		expect(readDelegateOnceIntents(memory)).toHaveLength(1);
	});

	it("fails closed on a malformed journal", () => {
		const memory = storage();
		memory.setItem(
			delegateOnceIntentStorageKey,
			'{"schemaVersion":1,"intents":[null]}',
		);
		expect(() => readDelegateOnceIntents(memory)).toThrow(/형식/);
		expect(() => begin(memory)).toThrow(/형식/);
		memory.setItem(
			delegateOnceIntentStorageKey,
			'{"schemaVersion":1,"intents":[],"unexpected":true}',
		);
		expect(() => readDelegateOnceIntents(memory)).toThrow(/형식/);
	});

	it("projects the exact worker generation once and rejects identity collisions", () => {
		const memory = storage();
		const intent = begin(memory);
		const receipt = {
			...activeReceipt(),
			idempotencyKey: intent.idempotencyKey,
		};
		const first = projectDelegateOnceWorker(intent, receipt, []);
		expect(first.inserted).toBe(true);
		expect(first.agent).toMatchObject({
			id: `agent-workflow-${"b".repeat(64)}`,
			sessionId: "worker-session",
			workflowDispatch: {
				taskId: `task.${"b".repeat(64)}`,
				dispatchId: `dispatch.${"b".repeat(64)}`,
				generation: 1,
			},
		});
		expect(projectDelegateOnceWorker(intent, receipt, [first.agent])).toEqual({
			agent: first.agent,
			inserted: false,
		});
		const workerBinding = first.agent.runtimeBinding;
		if (
			workerBinding?.runtime !== "hmux_managed_v1" ||
			workerBinding.source !== "local"
		) {
			throw new Error("expected a local managed worker binding");
		}
		const agentWithHostProjection: Agent = {
			...first.agent,
			runtimeBinding: {
				...workerBinding,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "worker-session",
					workspaceId: "workspace-1",
					...stopFence,
					revision: "1",
					observedThroughOutputSeq: "2",
					providerId: "codex",
					conversationId: "conversation-1",
					source: "provider_event",
				},
			},
		};
		expect(
			projectDelegateOnceWorker(intent, receipt, [agentWithHostProjection]),
		).toEqual({ agent: agentWithHostProjection, inserted: false });
		expect(() =>
			projectDelegateOnceWorker(intent, receipt, [
				{ ...first.agent, sessionId: "other-session" },
			]),
		).toThrow(/다른 세션/);
	});
});

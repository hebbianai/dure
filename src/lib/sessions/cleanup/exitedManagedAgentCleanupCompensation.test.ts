import { describe, expect, it } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";
import {
	type CleanupCompensationStorage,
	EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY,
	exitedManagedAgentCleanupCompensations,
	replacementAgentFromCleanupCompensation,
	replacementAgentFromRemoteCleanupCompensation,
	stageExitedManagedAgentCleanupCompensation,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensation";
import type {
	HmuxManagedPaneBindingV1,
	RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

function memoryStorage(initial?: string): CleanupCompensationStorage {
	const values = new Map<string, string>();
	if (initial !== undefined) {
		values.set(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY, initial);
	}
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

const sourceFence = {
	runnerPrincipal: "runner",
	runnerInstance: "runner-1",
	channelEpoch: "1",
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
};

function binding(
	patch: Partial<HmuxManagedPaneBindingV1> = {},
): HmuxManagedPaneBindingV1 {
	return managedBindingFixture({
		credentialId: "credential-1",
		credentialGeneration: 2,
		stopFence: sourceFence,
		...patch,
	});
}

function agent(runtimeBinding = binding()): Agent {
	return agentFixture({
		name: "codex-1",
		worktreePath: "/repo/.worktrees/codex-1",
		branch: "agent/codex-1",
		sessionId: runtimeBinding.sessionId,
		runtimeBinding,
		pendingCmd: "codex --token must-not-persist",
		conversationIdentity: {
			state: "ready",
			conversationId: "source-conversation",
		},
	});
}

function session(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
	return hmuxSessionSummaryFixture({
		manifestLifecycle: "ready",
		inputAllowed: true,
		terminalEpoch: "terminal-2",
		stopFence: {
			runnerPrincipal: "runner",
			runnerInstance: "runner-2",
			channelEpoch: "2",
			hostInstanceId: "host-2",
			terminalEpoch: "terminal-2",
		},
		...patch,
	});
}

describe("exited managed Agent cleanup compensation", () => {
	it("stages one sanitized record idempotently", () => {
		const storage = memoryStorage();
		const input = {
			agent: agent(),
			sourceBinding: binding(),
			sourceTerminalEpoch: "terminal-1",
			desktopIds: ["desktop-1"],
			storage,
			nowMs: 10_000,
		};

		expect(stageExitedManagedAgentCleanupCompensation(input)).toBe(true);
		expect(stageExitedManagedAgentCleanupCompensation(input)).toBe(true);
		expect(
			exitedManagedAgentCleanupCompensations(storage, 10_000),
		).toHaveLength(1);
		const encoded = storage.getItem(
			EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY,
		);
		expect(encoded).not.toContain("must-not-persist");
		expect(encoded).not.toContain("conversationIdentity");
	});

	it("fails closed without overwriting corrupt or unavailable storage", () => {
		const corrupt = memoryStorage('{"schemaVersion":1,"records":[null]}');
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: agent(),
				sourceBinding: binding(),
				desktopIds: [],
				storage: corrupt,
				nowMs: 10_000,
			}),
		).toBe(false);
		expect(corrupt.getItem(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY)).toBe(
			'{"schemaVersion":1,"records":[null]}',
		);
		const corruptExpired = memoryStorage(
			'{"schemaVersion":1,"records":[{"createdAtMs":1}]}',
		);
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: agent(),
				sourceBinding: binding(),
				desktopIds: [],
				storage: corruptExpired,
				nowMs: 1_000_000,
			}),
		).toBe(false);

		const unavailable: CleanupCompensationStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota exceeded");
			},
			removeItem: () => {},
		};
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: agent(),
				sourceBinding: binding(),
				desktopIds: [],
				storage: unavailable,
				nowMs: 10_000,
			}),
		).toBe(false);
	});

	it("refuses a changed source binding", () => {
		const storage = memoryStorage();
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: agent(),
				sourceBinding: binding({ createIdempotencyKey: "other-create" }),
				desktopIds: [],
				storage,
				nowMs: 10_000,
			}),
		).toBe(false);
		expect(storage.getItem(EXITED_MANAGED_AGENT_COMPENSATION_STORAGE_KEY)).toBe(
			null,
		);
	});

	it("accepts only a live different Host generation", () => {
		const storage = memoryStorage();
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: agent(),
				sourceBinding: binding(),
				sourceTerminalEpoch: "terminal-1",
				desktopIds: [],
				storage,
				nowMs: 10_000,
			}),
		).toBe(true);
		const record = exitedManagedAgentCleanupCompensations(storage, 10_000)[0];
		expect(record).toBeDefined();
		if (!record) return;

		expect(
			replacementAgentFromCleanupCompensation(
				record,
				session({ terminalEpoch: "terminal-1", stopFence: sourceFence }),
			),
		).toBeUndefined();
		expect(
			replacementAgentFromCleanupCompensation(
				record,
				session({ health: "stale_transport" }),
			),
		).toBeUndefined();
		const replacement = replacementAgentFromCleanupCompensation(
			record,
			session(),
		);
		expect(replacement).toMatchObject({
			id: "agent-1",
			sessionId: "session-1",
			started: true,
			runtimeBinding: {
				stopFence: { terminalEpoch: "terminal-2" },
			},
		});
		expect(replacement?.pendingCmd).toBeUndefined();
		expect(replacement?.conversationIdentity).toBeUndefined();
	});

	it("durably stages and restores an exact remote replacement generation", () => {
		const storage = memoryStorage();
		const remoteBinding: RemoteHmuxManagedPaneBindingV1 = {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "remote-1",
			sessionId: "remote-session",
			workspaceId: "remote-workspace",
			createIdempotencyKey: "remote-create",
			commandBridgeNonce: "remote-bridge",
		};
		const remoteAgent: Agent = {
			...agent(),
			sessionId: remoteBinding.sessionId,
			sessionKind: "ssh",
			started: false,
			runtimeBinding: remoteBinding,
		};
		expect(
			stageExitedManagedAgentCleanupCompensation({
				agent: remoteAgent,
				sourceBinding: remoteBinding,
				desktopIds: ["desktop-1"],
				storage,
				nowMs: 10_000,
			}),
		).toBe(true);
		const record = exitedManagedAgentCleanupCompensations(storage, 10_000)[0];
		if (!record) throw new Error("remote compensation missing");
		const replacement = replacementAgentFromRemoteCleanupCompensation(record, {
			sessionId: remoteBinding.sessionId,
			workspaceId: remoteBinding.workspaceId,
			sessionClass: "managed",
			lifecycle: "ready",
			providerId: "codex",
			runnerPrincipal: "runner",
			runnerInstance: "instance",
			channelEpoch: "1",
			hostInstanceId: "host-instance",
			terminalEpoch: "terminal-remote",
			supportedProtocol: {
				minimum: { major: 1, minor: 0 },
				maximum: { major: 1, minor: 0 },
			},
			capabilities: [],
		});
		expect(replacement).toMatchObject({
			id: remoteAgent.id,
			started: true,
			runtimeBinding: {
				source: "ssh",
				commandBridgeNonce: "remote-bridge",
				stopFence: { terminalEpoch: "terminal-remote" },
			},
		});
	});
});

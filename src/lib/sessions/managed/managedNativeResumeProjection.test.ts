import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriCoreModule } from "@/lib/ipc/core";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: mocks.invoke,
}));
vi.mock("@/lib/workspace/dock", () => ({ resolvePaneById: async () => null }));

import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { commitManagedAgentNativeResume } from "@/lib/sessions/managed/managedAgentRehostCommit";
import { commitManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import {
	createNativeRehostBackendFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

let backend: ReturnType<typeof createNativeRehostBackendFixture>;
const drain = async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await durableAppStorage.flush();
};
const persistedAgent = () =>
	JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null").state
		.agents[0];

beforeEach(async () => {
	backend = createNativeRehostBackendFixture();
	mocks.invoke.mockReset().mockImplementation(backend.handleRequest);
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
		agentRuntimeLaunchPresentation: {},
		sessionCwd: {},
	});
	await drain();
});
afterEach(async () => {
	for (const pending of backend.pending) pending.lose();
	await drain();
});

async function resume(generation: number, credentialId: string | null = null) {
	const pendingCount = backend.pending.length;
	const payload = nativeResumePayloadFixture(generation, credentialId);
	backend.prepare(payload);
	await expect(commitManagedAgentRehostReceipt(payload)).resolves.toMatchObject(
		{
			projection: "applied",
			payload: { binding: { sessionId: `session-${generation}` } },
		},
	);
	await vi.waitFor(() =>
		expect(backend.pending[pendingCount]?.sessionId).toBe(
			`session-${generation}`,
		),
	);
	return backend.pending[pendingCount];
}

describe("native Resume projection ownership", () => {
	it.each(["pending", "lost", "completed"])(
		"preserves later user work on Ready replay with %s publication",
		async (publication) => {
			const first = await resume(1, "account-current");
			if (publication === "lost") first.lose();
			if (publication === "completed") first.reply();
			await drain();
			useStore.setState({
				agents: [
					{
						...useStore.getState().agents[0],
						pendingCmd: "next explicit launch",
						skipPermissions: true,
						pendingCredentialSwitch: {
							schemaVersion: 1,
							requestId: "later-user-choice",
							targetCredentialId: null,
							targetCredentialDirectory: null,
							sourceSessionId: "session-1",
							sourceWorkspaceId: "workspace-1",
							sourceConversationId: "conversation-1",
							sourceCredentialId: "account-current",
							sourceCreateIdempotencyKey: "create-1",
							sourceCredentialGeneration: null,
							sourceTerminalEpoch: "terminal-1",
							baselineRuntimeRevision: "1",
							baselineTurnCompletedCount: "0",
							panelId: "agent:agent-1",
							requestedAtMs: 1,
						},
					},
				],
			});
			const current = useStore.getState().agents[0];
			const replay = await resume(1, "account-current");
			expect(useStore.getState().agents[0]).toBe(current);
			expect(persistedAgent()).toEqual(current);
			expect(backend.pending).toHaveLength(2);
			replay.reply();
			first.reply();
			await drain();
			expect(useStore.getState().agents[0]).toEqual(current);
		},
	);

	it("does not replace a backend-observed credential generation with launch-time unknown", async () => {
		const first = await resume(1, "account-current");
		first.reply();
		await drain();
		backend.observeCredentialGeneration("credential-observed-7");
		const observed = await createDureAgentRuntimeClient({
			profileId: "local",
		}).inspectExact(
			"agent-1",
			nativeResumePayloadFixture(1).backendRouteAuthority!,
		);
		if (observed.state !== "stable")
			throw new Error("Expected a stable fixture");
		projectAgentRuntimeTransition("agent-1", observed);
		await drain();
		const current = useStore.getState().agents[0];
		expect(current.executionProfile).toMatchObject({
			credential_generation: "credential-observed-7",
		});
		const replay = await resume(1, "account-current");
		expect(useStore.getState().agents[0]).toBe(current);
		expect(persistedAgent()).toEqual(current);
		replay.reply();
	});

	it("installs a different exact Host generation even when the session name is unchanged", async () => {
		const first = await resume(1, "account-current");
		first.reply();
		await drain();
		const next = nativeResumePayloadFixture(2, "account-next");
		useStore.setState({
			agents: [
				{
					...useStore.getState().agents[0],
					sessionId: next.binding.sessionId,
					runtimeBinding: {
						...next.binding,
						stopFence: nativeResumePayloadFixture(1).binding.stopFence,
					},
					pendingCmd: "old launch",
				},
			],
		});
		backend.prepare(next);
		await expect(commitManagedAgentRehostReceipt(next)).resolves.toMatchObject({
			projection: "applied",
		});
		await vi.waitFor(() => expect(backend.pending).toHaveLength(2));
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-2",
			runtimeBinding: next.binding,
			credentialId: "account-next",
			pendingCmd: undefined,
		});
		backend.pending[1].reply();
	});

	it.each(["missing-binding", "session-drift"])(
		"repairs %s instead of treating it as an installed Ready",
		async (drift) => {
			const first = await resume(1);
			first.reply();
			await drain();
			useStore.setState({
				agents: [
					{
						...useStore.getState().agents[0],
						...(drift === "missing-binding"
							? { runtimeBinding: undefined }
							: { sessionId: "wrong-session" }),
					},
				],
			});
			const retry = await resume(1);
			expect(useStore.getState().agents[0]).toMatchObject({
				sessionId: "session-1",
				runtimeBinding: nativeResumePayloadFixture(1).binding,
			});
			retry.reply();
		},
	);

	it("keeps the newer Host and durable Agent when an older backend response arrives", async () => {
		const first = await resume(1, "account-first");
		const second = await resume(2, "account-second");
		second.reply();
		await drain();
		const current = useStore.getState().agents[0];
		expect(current.sessionId).toBe("session-2");
		first.reply();
		await drain();

		expect(backend.currentSessionId()).toBe("session-2");
		expect(useStore.getState().agents[0]).toEqual(current);
		expect(persistedAgent()).toEqual(current);
		expect(useStore.getState().sessionCwd).not.toHaveProperty("session-1");
	});

	it("keeps a newer Host after two in-flight completions of the same older operation", async () => {
		const first = await resume(1);
		const duplicate = await resume(1);
		const second = await resume(2);
		second.reply();
		await drain();
		const current = useStore.getState().agents[0];
		for (const pending of [duplicate, first]) {
			pending.reply();
			await drain();
			expect(useStore.getState().agents[0]).toEqual(current);
			expect(persistedAgent()).toEqual(current);
		}
	});

	it.each([null, "account-current"])(
		"projects the ready credential %s before backend completion",
		async (credentialId) => {
			useStore.setState({
				agents: [
					{
						...managedRehostAgentFixture(0),
						executionProfile: {
							kind: "credential_reference",
							reference_id: "old-account",
							credential_generation: "old-generation",
						},
					},
				],
			});
			const pending = await resume(1, credentialId);
			expect(useStore.getState().agents[0].executionProfile).toEqual(
				credentialId
					? {
							kind: "credential_reference",
							reference_id: credentialId,
							credential_generation: null,
						}
					: { kind: "provider_default" },
			);
			pending.lose();
			await drain();
			expect(useStore.getState().agents[0].sessionId).toBe("session-1");
		},
	);

	it("does not clear a later action in the same Host when bookkeeping completes", async () => {
		const pending = await resume(1);
		useStore.setState({
			agents: [
				{
					...useStore.getState().agents[0],
					pendingCmd: "next explicit launch",
					skipPermissions: true,
				},
			],
		});
		const current = useStore.getState().agents[0];
		pending.reply();
		await drain();
		expect(useStore.getState().agents[0]).toEqual(current);
		expect(persistedAgent()).toEqual(current);
	});

	it("does not recreate a removed Agent on backend completion", async () => {
		const pending = await resume(1);
		useStore.setState({ agents: [] });
		pending.reply();
		await drain();
		expect(useStore.getState().agents).toEqual([]);
		expect(persistedAgent()).toBeUndefined();
	});

	it("parses and accepts the delayed fixture through the real backend commit adapter", async () => {
		const payload = nativeResumePayloadFixture(1, "account-current");
		backend.prepare(payload);
		const commit = commitManagedAgentNativeResume(
			payload,
			payload.backendRouteAuthority!,
			{ accounts: [] },
		);
		await vi.waitFor(() => expect(backend.pending).toHaveLength(1));
		backend.pending[0].reply();
		await expect(commit).resolves.toMatchObject({
			sessionId: "session-1",
			providerConversationRef: "conversation-1",
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-current",
				credential_generation: null,
			},
		});
	});
});

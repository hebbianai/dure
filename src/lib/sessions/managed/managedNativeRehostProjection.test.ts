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
		sessionCwd: { "session-0": "/repo/old" },
		sessionTitle: { "session-0": "old terminal" },
	});
	await drain();
});
afterEach(async () => {
	for (const pending of backend.pending) pending.lose();
	await drain();
});

async function start(generation: number, launchKind: "fresh" | "exact_resume") {
	const payload = {
		...nativeResumePayloadFixture(generation, `account-${generation}`),
		launchKind,
		sourceConversationId: "conversation-exact",
		conversationId: launchKind === "fresh" ? null : "conversation-exact",
	};
	backend.prepare(
		payload,
		launchKind === "fresh" ? `conversation-${generation}` : undefined,
	);
	const result = commitManagedAgentRehostReceipt(payload);
	// Retain a rejection observer even if an assertion fails before reply.
	void result.catch(() => undefined);
	await vi.waitFor(() =>
		expect(backend.pending[generation - 1]?.sessionId).toBe(
			`session-${generation}`,
		),
	);
	return { result, payload, reply: backend.pending[generation - 1].reply };
}

describe.each(["fresh", "exact_resume"] as const)(
	"%s backend projection",
	(launchKind) => {
		it("keeps the newer committed Host when the older response arrives last", async () => {
			const first = await start(1, launchKind);
			const second = await start(2, launchKind);
			second.reply();
			await second.result;
			await drain();
			const current = useStore.getState().agents[0];
			expect(current).toMatchObject({
				sessionId: "session-2",
				accountId: "account-2",
				conversationId:
					launchKind === "fresh" ? "conversation-2" : "conversation-exact",
			});
			first.reply();
			await first.result;
			await drain();

			expect(backend.currentSessionId()).toBe("session-2");
			expect(useStore.getState().agents[0]).toEqual(current);
			expect(persistedAgent()).toEqual(current);
			expect(useStore.getState().sessionCwd).toEqual({
				"session-2": current.worktreePath,
			});
			expect(useStore.getState().sessionTitle).toEqual({});
			expect(
				useStore.getState().agentRuntimeLaunchPresentation["agent-1"]
					?.selectionRevision,
			).toBe(3);
		});

		it("still applies a genuinely later revision when responses arrive in order", async () => {
			const first = await start(1, launchKind);
			const second = await start(2, launchKind);
			first.reply();
			await first.result;
			expect(useStore.getState().agents[0].sessionId).toBe("session-1");
			second.reply();
			await second.result;
			await drain();
			expect(useStore.getState().agents[0].sessionId).toBe("session-2");
			expect(persistedAgent().sessionId).toBe("session-2");
		});

		it("does not replay the same receipt over later user work", async () => {
			const first = await start(1, launchKind);
			first.reply();
			await first.result;
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
			await commitManagedAgentRehostReceipt(first.payload);
			await drain();
			expect(useStore.getState().agents[0]).toEqual(current);
			expect(persistedAgent()).toEqual(current);
		});

		it("does not recreate an Agent removed before its response", async () => {
			const first = await start(1, launchKind);
			useStore.setState({ agents: [] });
			first.reply();
			await first.result;
			await drain();
			expect(useStore.getState().agents).toEqual([]);
			expect(persistedAgent()).toBeUndefined();
		});

		it("recovers a lost response through the same committed request", async () => {
			const first = await start(1, launchKind);
			backend.pending[0].lose();
			await expect(first.result).rejects.toThrow();
			expect(backend.currentSessionId()).toBe("session-1");
			expect(useStore.getState().agents[0].sessionId).toBe("session-0");
			await expect(
				commitManagedAgentRehostReceipt(first.payload),
			).resolves.toMatchObject({ projection: "applied" });
			await drain();
			expect(persistedAgent().sessionId).toBe("session-1");
			expect(backend.pending).toHaveLength(1);
		});

		it("does not overwrite a newer shared runtime projection", async () => {
			const first = await start(1, launchKind);
			const second = await start(2, launchKind);
			const latest = await createDureAgentRuntimeClient({
				profileId: "local",
			}).inspectExact("agent-1", second.payload.backendRouteAuthority!);
			if (latest.state !== "stable")
				throw new Error("Expected a stable fixture");
			projectAgentRuntimeTransition("agent-1", latest);
			const current = useStore.getState().agents[0];
			first.reply();
			await first.result;
			await drain();
			expect(useStore.getState().agents[0]).toEqual(current);
			expect(persistedAgent()).toEqual(current);
			second.reply();
			await second.result;
		});

		it("keeps a newer rehost when the shared projector receives an older observation", async () => {
			const first = await start(1, launchKind);
			const earlier = await createDureAgentRuntimeClient({
				profileId: "local",
			}).inspectExact("agent-1", first.payload.backendRouteAuthority!);
			if (earlier.state !== "stable")
				throw new Error("Expected a stable fixture");
			const second = await start(2, launchKind);
			second.reply();
			await second.result;
			const current = useStore.getState().agents[0];
			expect(
				projectAgentRuntimeTransition("agent-1", earlier).selectionRevision,
			).toBe(3);
			first.reply();
			await first.result;
			await drain();
			expect(useStore.getState().agents[0]).toEqual(current);
			expect(persistedAgent()).toEqual(current);
		});
	},
);

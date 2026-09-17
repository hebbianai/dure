// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import {
	type AgentChatSubmission,
	agentChatSubmissionKey,
	normalizeAgentChatSubmissions,
} from "./agentChatSubmission";
import { agentChatSubmissionStore } from "./agentChatSubmissionStore";

function submission(id: string, backend = "backend"): AgentChatSubmission {
	return {
		agentId: "agent-1",
		kind: "start",
		routeAuthority: testDureBackendRouteAuthority(backend, "generation-1"),
		request: {
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			clientMessageId: id,
			turnId: `turn-${id}`,
			input: `input ${id}`,
			requestedAtMs: 1,
			runtime: { runtimeGeneration: "runtime-1", providerEpoch: "epoch-1" },
		},
	};
}

beforeEach(async () => {
	await durableAppStorage.flush();
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: {
			version: PERSIST_VERSION,
			state: normalizePersistedState({ chatSubmissions: {} }),
		},
		result: undefined,
	}));
	await rehydrateAppStoreFromDurableStorage();
});

describe("durable chat submissions", () => {
	it("preserves multiple submissions across projection writes and app rehydration", async () => {
		const a = submission("a"),
			b = submission("b");
		await Promise.all([
			agentChatSubmissionStore.put(a),
			agentChatSubmissionStore.put(b),
		]);
		useStore.getState().setFileTreeSelected("/repo", "/repo/readme");
		await durableAppStorage.flush();
		await rehydrateAppStoreFromDurableStorage();
		expect(
			await agentChatSubmissionStore.list("agent-1", "interaction-1"),
		).toEqual([a, b]);
		expect(Object.keys(useStore.getState().chatSubmissions ?? {})).toHaveLength(
			2,
		);
	});

	it("does not resurrect a confirmed submission when a stale window saves unrelated preferences", async () => {
		const a = submission("a");
		await agentChatSubmissionStore.put(a);
		const otherWindow = createReferenceAwareLocalStorage<PersistedAppState>({
			convergeState: convergePersistedAppState,
		});
		const ancestor = await otherWindow.getItem(DURABLE_APP_STORE_NAME);
		expect(ancestor).not.toBeNull();
		await agentChatSubmissionStore.remove(a);
		otherWindow.setItem(DURABLE_APP_STORE_NAME, {
			...ancestor!,
			state: { ...ancestor!.state, language: "ko" },
		});
		await otherWindow.flush();
		expect(
			await agentChatSubmissionStore.list("agent-1", "interaction-1"),
		).toEqual([]);
	});

	it("retains identical message IDs on distinct backends and refuses altered replay content", async () => {
		const a = submission("a"),
			foreign = submission("a", "other-backend");
		await agentChatSubmissionStore.put(a);
		await agentChatSubmissionStore.put(foreign);
		await agentChatSubmissionStore.put(a);
		await expect(
			agentChatSubmissionStore.put({
				...a,
				request: { ...a.request, input: "changed" },
			}),
		).rejects.toThrow("conflict");
		await agentChatSubmissionStore.remove(a);
		expect(
			await agentChatSubmissionStore.list("agent-1", "interaction-1"),
		).toEqual([foreign]);
	});

	it("rejects mis-keyed stored identities while retaining a complete original request", () => {
		const a = submission("a");
		expect(
			normalizeAgentChatSubmissions({
				wrong: a,
				[agentChatSubmissionKey(a)]: a,
			}),
		).toEqual({ [agentChatSubmissionKey(a)]: a });
	});
});

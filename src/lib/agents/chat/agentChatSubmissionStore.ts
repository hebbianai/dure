import { DURABLE_APP_STORE_NAME } from "@/lib/persistence/durableAppStoreName";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { subscribeDurableStoreChanged } from "@/lib/workspace/window/durableStoreBroadcast";
import {
	type AgentChatSubmission,
	type AgentChatSubmissionStore,
	agentChatSubmissionKey,
	parseAgentChatSubmission,
} from "./agentChatSubmission";

/** Uses the existing app-state transaction and cross-window writer authority. */
export const agentChatSubmissionStore: AgentChatSubmissionStore = {
	subscribe: (onChanged) =>
		subscribeDurableStoreChanged(
			DURABLE_APP_STORE_NAME,
			onChanged,
			undefined,
			true,
		),
	async list(agentId, interactionSessionId) {
		const { durableAppStorage, DURABLE_APP_STORE_NAME } = await import(
			"@/store"
		);
		return durableAppStorage.read(DURABLE_APP_STORE_NAME, (current) =>
			Object.values(
				normalizePersistedState(current?.state).chatSubmissions ?? {},
			).filter(
				(input) =>
					input.agentId === agentId &&
					input.request.interactionSessionId === interactionSessionId,
			),
		);
	},
	async put(input) {
		await write(input, false);
	},
	async remove(input) {
		await write(input, true);
	},
};

async function write(
	input: AgentChatSubmission,
	remove: boolean,
): Promise<void> {
	const parsed = parseAgentChatSubmission(input);
	if (!parsed) throw new Error("agent_chat_submission_invalid");
	const {
		durableAppStorage,
		DURABLE_APP_STORE_NAME,
		PERSIST_VERSION,
		useStore,
	} = await import("@/store");
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		const state = normalizePersistedState(
			current?.state ?? persistedSlice(useStore.getState()),
		);
		const chatSubmissions = { ...state.chatSubmissions };
		const key = agentChatSubmissionKey(parsed);
		const prior = chatSubmissions[key];
		if (prior && JSON.stringify(prior) !== JSON.stringify(parsed))
			throw new Error("agent_chat_submission_conflict");
		if (remove) delete chatSubmissions[key];
		else chatSubmissions[key] = parsed;
		return {
			value: { version: PERSIST_VERSION, state: { ...state, chatSubmissions } },
			result: undefined,
		};
	});
}

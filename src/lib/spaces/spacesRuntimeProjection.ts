import { shallow } from "zustand/shallow";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { SessionRuntimeStoreSlice } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";

export type SpacesRuntimeRecords = Pick<
	SessionRuntimeStoreSlice,
	| "agentActivity"
	| "sessionAgentRuntimeState"
	| "sessionCwd"
	| "sessionTitle"
	| "sessionAgent"
	| "sessionAgentPin"
	| "sessionActivity"
>;

type AttentionRecords = {
	displayStates: Record<string, AgentDisplayState>;
	episodes: Record<string, number>;
	acks: Record<string, number>;
};

/** Each store remains authoritative. Keep one projection of its referenced
 * records, and skip reading entries when an immutable source is unchanged. */
function createScopedRecordsSelector<
	Records extends {
		[Key in keyof Records]: Readonly<Record<string, unknown>>;
	},
>(scope: { [Key in keyof Records]: readonly string[] }) {
	const fields = Object.keys(scope) as (keyof Records)[];
	const sources: Partial<Records> = {};
	let projection = Object.fromEntries(
		fields.map((field) => [field, {}]),
	) as Records;
	return (state: Records): Records => {
		let next = projection;
		for (const field of fields) {
			const record = state[field];
			if (sources[field] === record) continue;
			const entries = Object.fromEntries(
				scope[field]
					.filter(
						(id) => Object.getOwnPropertyDescriptor(record, id) !== undefined,
					)
					.map((id) => [id, record[id]]),
			) as Records[typeof field];
			if (!shallow(projection[field], entries)) {
				if (next === projection) next = { ...projection };
				next[field] = entries;
			}
			sources[field] = record;
		}
		projection = next;
		return projection;
	};
}

export function createSpacesRuntimeSelector(
	sessionIds: readonly string[],
	agentIds: readonly string[],
) {
	return createScopedRecordsSelector<SpacesRuntimeRecords>({
		agentActivity: agentIds,
		sessionAgentRuntimeState: sessionIds,
		sessionCwd: sessionIds,
		sessionTitle: sessionIds,
		sessionAgent: sessionIds,
		sessionAgentPin: sessionIds,
		sessionActivity: sessionIds,
	});
}

export function createSpacesAttentionSelector(agentIds: readonly string[]) {
	return createScopedRecordsSelector<AttentionRecords>({
		displayStates: agentIds,
		episodes: agentIds,
		acks: agentIds,
	});
}

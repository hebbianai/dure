import {
	createDureBackendRequester,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { readDureProjects } from "@/lib/ipc/dureProjects";
import {
	parseSlackConnection,
	parseSlackShare,
	type SlackConnectIntent,
	type SlackConnection,
	type SlackShareIntent,
	slackConnectionContractError,
} from "@/lib/plugins/slackConnection";
import { parseSlackTask } from "@/lib/plugins/slackTask";

export interface SlackConnectionSnapshot {
	authority: DureBackendRouteAuthorityV1;
	connections: SlackConnection[];
}

export function createSlackConnectorClient(
	options: { profileId?: string; invokeCommand?: DureBackendInvoke } = {},
) {
	const request = createDureBackendRequester({
		...options,
		invalidResponseCode: "slack_connection_response_invalid",
		invalidResponseMessage: "plugins.slack.invalidResponse",
		backendChangedCode: "slack_connection_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "slack_connection_request_failed",
		requestFailedMessage: "plugins.slack.requestFailed",
	});
	async function send(
		body: Record<string, unknown>,
		authority?: DureBackendRouteAuthorityV1,
	): Promise<SlackConnectionSnapshot> {
		const { result, routeAuthority } = await request(
			"slack.connector",
			{ schemaVersion: 1, ...body },
			authority
				? { kind: "exact", authority }
				: { kind: "complete_selected_snapshot" },
		);
		if (!Array.isArray(result.connections)) slackConnectionContractError();
		return {
			authority: routeAuthority,
			connections: result.connections.map(parseSlackConnection),
		};
	}
	return {
		tasks: async (teamId: string, authority: DureBackendRouteAuthorityV1) => {
			const { result } = await request(
				"slack.connector",
				{ schemaVersion: 1, kind: "tasks", teamId },
				{ kind: "exact", authority },
			);
			if (!Array.isArray(result.tasks)) slackConnectionContractError();
			return result.tasks.map((task) => parseSlackTask(task, teamId));
		},
		share: async (
			intent: SlackShareIntent,
			authority: DureBackendRouteAuthorityV1,
		) => {
			const { result } = await request(
				"slack.connector",
				{
					schemaVersion: 1,
					kind: "share",
					...intent,
				},
				{ kind: "exact", authority },
			);
			return parseSlackShare(result.share, intent);
		},
		list: (authority?: DureBackendRouteAuthorityV1) =>
			send({ kind: "list" }, authority),
		connect: (
			intent: SlackConnectIntent,
			authority: DureBackendRouteAuthorityV1,
		) => send({ kind: "connect", ...intent }, authority),
		disconnect: (teamId: string, authority: DureBackendRouteAuthorityV1) =>
			send({ kind: "disconnect", teamId }, authority),
		projects: (authority: DureBackendRouteAuthorityV1) =>
			readDureProjects(request, authority, slackConnectionContractError),
	};
}

export type SlackConnectorClient = ReturnType<
	typeof createSlackConnectorClient
>;

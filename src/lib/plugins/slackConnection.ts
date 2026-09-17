import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { asRecord } from "@/lib/payloadGuards";

export interface SlackChannelRoute {
	channelId: string;
	projectId: string;
	providerId: string;
	backend?: string;
	objective?: string;
	space?: string;
}

export interface SlackConfiguration {
	schemaVersion: 1;
	teamId: string;
	channels: SlackChannelRoute[];
}

type SlackConnectionState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "stopping"
	| "stopped"
	| "failed";

export interface SlackConnection {
	config: SlackConfiguration;
	enabled: boolean;
	credentialsConfigured: boolean;
	connection: SlackConnectionState;
	generation: string | null;
	failure: string | null;
}

export interface SlackConnectIntent {
	config: SlackConfiguration;
	appToken?: string;
	botToken?: string;
}

export interface SlackShareIntent {
	requestId: string;
	teamId: string;
	channelId: string;
	agentId: string;
	interactionSessionId: string;
	backend?: string;
}

export function parseSlackShare(value: unknown, intent: SlackShareIntent) {
	const receipt = asRecord(value);
	if (
		receipt?.state !== "succeeded" ||
		receipt.teamId !== intent.teamId ||
		receipt.channelId !== intent.channelId ||
		receipt.agentId !== intent.agentId ||
		receipt.interactionSessionId !== intent.interactionSessionId ||
		typeof receipt.threadTs !== "string" ||
		!/^\d+\.\d+$/.test(receipt.threadTs)
	)
		slackConnectionContractError();
	return {
		teamId: intent.teamId,
		channelId: intent.channelId,
		threadTs: receipt.threadTs,
	};
}

export function slackShareError(reason: unknown): string {
	if (reason instanceof DureBackendRequestError) {
		if (reason.failure.kind === "authority_changed")
			return t("ipc.dureBackend.generationChanged");
		if (reason.code === "slack_pro_development_only")
			return t("plugins.slack.proRequired");
		if (reason.code === "slack_share_conversation_changed")
			return t("plugins.slack.shareConversationChanged");
		if (reason.code === "slack_share_connector_unavailable")
			return t("plugins.slack.shareUnavailable");
	}
	return t("plugins.slack.shareFailed");
}

export function slackConnectionContractError(): never {
	throw new DureBackendRequestError(
		"slack_connection_response_invalid",
		t("plugins.slack.invalidResponse"),
		{ kind: "contract" },
	);
}

export function parseSlackConnection(value: unknown): SlackConnection {
	const record = asRecord(value);
	const config = asRecord(record?.config);
	if (
		!record ||
		!config ||
		config.schemaVersion !== 1 ||
		typeof config.teamId !== "string" ||
		!Array.isArray(config.channels) ||
		typeof record.enabled !== "boolean" ||
		typeof record.credentialsConfigured !== "boolean" ||
		![
			"connecting",
			"connected",
			"disconnected",
			"stopping",
			"stopped",
			"failed",
		].includes(String(record.connection)) ||
		(record.generation !== null && typeof record.generation !== "string") ||
		(record.failure !== null && typeof record.failure !== "string")
	)
		slackConnectionContractError();
	const channels = config.channels.map((value) => {
		const route = asRecord(value);
		if (
			!route ||
			typeof route.channelId !== "string" ||
			typeof route.projectId !== "string" ||
			typeof route.providerId !== "string" ||
			["backend", "objective", "space"].some(
				(key) => route[key] !== undefined && typeof route[key] !== "string",
			)
		)
			slackConnectionContractError();
		return {
			channelId: route.channelId,
			projectId: route.projectId,
			providerId: route.providerId,
			...(typeof route.backend === "string" ? { backend: route.backend } : {}),
			...(typeof route.objective === "string"
				? { objective: route.objective }
				: {}),
			...(typeof route.space === "string" ? { space: route.space } : {}),
		};
	});
	return {
		config: { schemaVersion: 1, teamId: config.teamId, channels },
		enabled: record.enabled,
		credentialsConfigured: record.credentialsConfigured,
		connection: record.connection as SlackConnectionState,
		generation: record.generation as string | null,
		failure: record.failure as string | null,
	};
}

/** Accept copied Slack links at the form boundary. Other input reaches the
 * connection operation unchanged, where its actual configuration is resolved. */
export function slackReference(
	value: string,
	kind: "workspace" | "channel",
): string {
	const text = value.trim();
	try {
		const url = new URL(text);
		if (
			url.protocol === "slack:" ||
			(url.protocol === "https:" && url.hostname.endsWith(".slack.com"))
		) {
			const candidate =
				url.searchParams.get(kind === "workspace" ? "team" : "channel") ??
				url.pathname
					.split("/")
					.find((part) =>
						(kind === "workspace" ? /^T[A-Z0-9]+$/ : /^[CDG][A-Z0-9]+$/).test(
							part,
						),
					);
			if (candidate) return candidate;
		}
	} catch {
		/* An ID is also valid input; no network preflight is needed. */
	}
	return text;
}

export function slackConnectIntent(
	config: SlackConfiguration,
	appToken: string,
	botToken: string,
): SlackConnectIntent {
	return {
		config: {
			schemaVersion: 1,
			teamId: slackReference(config.teamId, "workspace"),
			channels: config.channels.map((route) => ({
				channelId: slackReference(route.channelId, "channel"),
				projectId: route.projectId.trim(),
				providerId: route.providerId.trim(),
				...(route.backend?.trim() ? { backend: route.backend.trim() } : {}),
				...(route.objective?.trim()
					? { objective: route.objective.trim() }
					: {}),
				...(route.space?.trim() ? { space: route.space.trim() } : {}),
			})),
		},
		...(appToken.trim() ? { appToken: appToken.trim() } : {}),
		...(botToken.trim() ? { botToken: botToken.trim() } : {}),
	};
}

export function slackConnectionError(reason: unknown): string {
	if (reason instanceof DureBackendRequestError) {
		if (reason.failure.kind === "authority_changed")
			return t("ipc.dureBackend.generationChanged");
		if (reason.code === "slack_pro_development_only")
			return t("plugins.slack.proRequired");
	}
	return t("plugins.slack.requestFailed");
}

export function slackFailureMessage(code: string | null): string {
	if (
		code === "slack_invalid_auth" ||
		code === "slack_not_authed" ||
		code === "slack_token_revoked"
	)
		return t("plugins.slack.tokenFailed");
	if (code === "slack_connector_launch_failed")
		return t("plugins.slack.launchFailed");
	return t("plugins.slack.connectionFailed");
}

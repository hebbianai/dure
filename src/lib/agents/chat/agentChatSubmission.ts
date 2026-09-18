import {
	type DureBackendRouteAuthorityV1,
	parseDureBackendRouteAuthority,
	sameDureBackendRouteTarget,
} from "@/lib/ipc/dureBackendRoute";
import { asRecord, hasOnlyKeys } from "@/lib/payloadGuards";
import {
	type AgentStartTurnIntentV1,
	parseAgentStartTurnIntentV1,
} from "./agentConversationContract";

/** Client input intent, retained until admission or return to its draft is confirmed. */
export interface AgentChatSubmission {
	agentId: string;
	kind: "start" | "enqueue" | "edit";
	routeAuthority: DureBackendRouteAuthorityV1;
	request: AgentStartTurnIntentV1;
}

export type AgentChatDeliverySubmission = AgentChatSubmission & {
	kind: "start" | "enqueue";
};

export function agentChatSubmissionKey(value: AgentChatSubmission): string {
	const route = value.routeAuthority;
	const key = [
		route.profileId,
		route.revision,
		route.backend.id,
		route.backend.generation,
		value.agentId,
		value.request.interactionSessionId,
		value.request.clientMessageId,
	];
	// Existing delivery keys stay stable; editing is a distinct user operation.
	if (value.kind === "edit") key.push("edit");
	return JSON.stringify(key);
}

export function parseAgentChatSubmission(
	value: unknown,
): AgentChatSubmission | undefined {
	const input = asRecord(value);
	const routeAuthority = parseDureBackendRouteAuthority(input?.routeAuthority);
	const request = parseAgentStartTurnIntentV1(input?.request);
	if (
		!input ||
		!hasOnlyKeys(input, ["agentId", "kind", "routeAuthority", "request"]) ||
		typeof input.agentId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.agentId) ||
		(input.kind !== "start" &&
			input.kind !== "enqueue" &&
			input.kind !== "edit") ||
		!routeAuthority ||
		!request
	)
		return undefined;
	return { agentId: input.agentId, kind: input.kind, routeAuthority, request };
}

export function normalizeAgentChatSubmissions(
	value: unknown,
): Record<string, AgentChatSubmission> {
	return Object.fromEntries(
		Object.entries(asRecord(value) ?? {}).flatMap(([key, value]) => {
			const parsed = parseAgentChatSubmission(value);
			return parsed && agentChatSubmissionKey(parsed) === key
				? [[key, parsed]]
				: [];
		}),
	);
}

export function submissionBelongsToRoute(
	input: AgentChatSubmission,
	route: DureBackendRouteAuthorityV1,
): boolean {
	return (
		input.routeAuthority.profileId === route.profileId &&
		input.routeAuthority.backend.id === route.backend.id &&
		sameDureBackendRouteTarget(input.routeAuthority.target, route.target)
	);
}

export interface AgentChatSubmissionStore {
	subscribe(onChanged: () => void): () => void;
	list(
		agentId: string,
		interactionSessionId: string,
	): Promise<AgentChatSubmission[]>;
	put(input: AgentChatSubmission): Promise<void>;
	remove(input: AgentChatSubmission): Promise<void>;
}

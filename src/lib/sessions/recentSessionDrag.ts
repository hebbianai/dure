import type { RecentWorkItem } from "@/lib/sessions/recentWork";
import { PROVIDERS, type Provider } from "@/types";

export const RECENT_SESSION_DRAG_TYPE = "recent-session" as const;
const KNOWN_PROVIDERS = new Set<string>(Object.keys(PROVIDERS));

export interface RecentSessionDragPayload {
	type: typeof RECENT_SESSION_DRAG_TYPE;
	provider: Provider;
	conversationId: string;
	executionLocation: "local" | "ssh";
	cwd: string;
	workspaceRoot: string;
	hostId?: string;
	ownerAgentId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function knownProvider(value: unknown): value is Provider {
	return typeof value === "string" && KNOWN_PROVIDERS.has(value);
}

/** Build the small provider-neutral projection that can cross a browser drag.
 * Remote history without an existing Agent still requires the registration
 * decision dialog, so it deliberately has no pane-placement affordance. */
export function recentSessionDragPayload(
	item: RecentWorkItem,
): RecentSessionDragPayload | null {
	if (item.action.kind === "needs_registration_decision") return null;
	const ownerAgentId =
		item.action.kind === "focus" ? item.action.agentId : undefined;
	if (item.executionLocation === "ssh" && (!item.hostId || !ownerAgentId)) {
		return null;
	}
	return {
		type: RECENT_SESSION_DRAG_TYPE,
		provider: item.provider,
		conversationId: item.conversationId,
		executionLocation: item.executionLocation,
		cwd: item.cwd,
		workspaceRoot: item.workspaceRoot,
		...(item.hostId ? { hostId: item.hostId } : {}),
		...(ownerAgentId ? { ownerAgentId } : {}),
	};
}

/** Parse untrusted text/plain drag data before it reaches launch authority. */
export function parseRecentSessionDragPayload(
	value: unknown,
): RecentSessionDragPayload | null {
	const candidate = record(value);
	if (
		candidate?.type !== RECENT_SESSION_DRAG_TYPE ||
		!knownProvider(candidate.provider)
	) {
		return null;
	}
	const conversationId = boundedText(candidate.conversationId, 256);
	const cwd = boundedText(candidate.cwd, 4_096);
	const workspaceRoot = boundedText(candidate.workspaceRoot, 4_096);
	const executionLocation = candidate.executionLocation;
	const hostId = boundedText(candidate.hostId, 256);
	const ownerAgentId = boundedText(candidate.ownerAgentId, 512);
	if (
		!conversationId ||
		!cwd ||
		!workspaceRoot ||
		(executionLocation !== "local" && executionLocation !== "ssh") ||
		(executionLocation === "ssh" && (!hostId || !ownerAgentId)) ||
		(executionLocation === "local" && hostId !== undefined)
	) {
		return null;
	}
	return {
		type: RECENT_SESSION_DRAG_TYPE,
		provider: candidate.provider,
		conversationId,
		executionLocation,
		cwd,
		workspaceRoot,
		...(hostId ? { hostId } : {}),
		...(ownerAgentId ? { ownerAgentId } : {}),
	};
}

import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import type { ObservedProviderModelV1 } from "@/lib/agents/providerModels";
import { parseProviderModels } from "@/lib/agents/providerModels";

export interface ObservedSessionInit {
	readonly model: string | null;
	readonly permissionMode: string | null;
}

const EMPTY: ObservedSessionInit = { model: null, permissionMode: null };

/** Shared sidebar activity from durable rows and the current live projection.
 * Loading an older page cannot make the latest observed activity go backwards. */
export function observedConversationActivity(page: AgentTimelinePageV1): {
	text: string;
	at: number | undefined;
} {
	let text = "";
	let at: number | undefined;
	for (const row of page.rows) {
		const body = row.item.body;
		if (
			body.type === "provider_evidence" || body.type === "history_boundary" ||
			(body.type === "lifecycle" && !body.state.startsWith("turn_"))
		) continue;
		at = Math.max(at ?? 0, row.item.createdAtMs);
		if (row.item.body.type === "message" && row.item.body.role === "user") {
			text = row.item.body.markdown;
		}
	}
	for (const live of page.liveText) at = Math.max(at ?? 0, live.updatedAtMs);
	for (const pending of page.pendingRequests) {
		at = Math.max(at ?? 0, pending.request.createdAtMs);
	}
	return { text, at };
}

/** What the running provider session reported about itself at initialization
 * (Claude's `system:init` travels as durable provider evidence). This is the
 * honest answer to "which model is the CLI default actually using" — an
 * observation, shown only when the provider reported it, never guessed. */
export function observedSessionInit(
	page: Pick<AgentTimelinePageV1, "rows"> | undefined,
): ObservedSessionInit {
	if (!page) return EMPTY;
	for (let index = page.rows.length - 1; index >= 0; index -= 1) {
		const body = page.rows[index]?.item.body;
		if (
			!body ||
			body.type !== "provider_evidence" ||
			body.kind !== "provider_session_initialized" ||
			typeof body.value !== "object" ||
			body.value === null
		) {
			continue;
		}
		const value = body.value as Record<string, unknown>;
		return {
			model: typeof value.model === "string" && value.model ? value.model : null,
			permissionMode:
				typeof value.permissionMode === "string" && value.permissionMode
					? value.permissionMode
					: null,
		};
	}
	return EMPTY;
}

/** The provider-reported conversation title (codex thread name; a Claude
 * session summary later). A description, never an identity — the agent name
 * stays the only user-renamable label. Newest evidence wins. */
export function observedConversationTitle(
	page: AgentTimelinePageV1 | undefined,
): string | null {
	if (!page) return null;
	for (let index = page.rows.length - 1; index >= 0; index -= 1) {
		const body = page.rows[index]?.item.body;
		if (
			!body ||
			body.type !== "provider_evidence" ||
			body.kind !== "conversation_title" ||
			typeof body.value !== "object" ||
			body.value === null
		) {
			continue;
		}
		const title = (body.value as Record<string, unknown>).title;
		if (typeof title !== "string") return null;
		const trimmed = title.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return null;
}

/** The running provider's own model/effort catalog, published once per
 * session init as durable evidence. Null until (or unless) the provider
 * reported one. An explicit empty report clears previous choices. */
export function observedProviderCatalog(
	page: Pick<AgentTimelinePageV1, "rows"> | undefined,
): readonly ObservedProviderModelV1[] | null {
	if (!page) return null;
	for (let index = page.rows.length - 1; index >= 0; index -= 1) {
		const body = page.rows[index]?.item.body;
		if (
			!body ||
			body.type !== "provider_evidence" ||
			body.kind !== "provider_catalog" ||
			typeof body.value !== "object" ||
			body.value === null
		) {
			continue;
		}
		const models = (body.value as Record<string, unknown>).models;
		if (!Array.isArray(models)) return null;
		return parseProviderModels(models);
	}
	return null;
}

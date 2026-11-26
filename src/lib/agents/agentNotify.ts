// `dure notify`: one message from an agent, or from a command run outside
// any agent, shown to the person. The Rust admission owns the text rules and
// each sender's rate limit; the notifier's policy table owns how the message
// reaches each surface. The sender is self-declared within the same OS user,
// as with `dure send`.

import {
	type AgentNotificationReceipt,
	agentNotificationSender,
	notifyAgentEvent,
	skippedAgentNotification,
} from "@/lib/agents/agentAttentionNotifier";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import { presenterAgentIdForSession } from "@/lib/files/filePresentation";
import { agentSeatKey } from "@/lib/hub/sidebarLayout";
import {
	type AgentNoticeTextRefusal,
	agentNoticeAdmit,
} from "@/lib/ipc/notifications";
import { useStore } from "@/store";

const AGENT_NOTIFY_ACTION = "agent.notify";
/** The rate-limit sender for a command run outside any agent. */
const PERSON_NOTICE_SENDER = "person";
// Bounds what is handed to the admission; the exact limit is its own.
const MAX_MESSAGE_UNITS = 4096;
const MAX_SESSION_ID_LENGTH = 512;

const TEXT_REFUSALS: Readonly<Record<AgentNoticeTextRefusal, string>> = {
	empty: "The message is empty.",
	too_long: "The message is longer than 280 characters.",
	control_character:
		"The message contains a control character; only line breaks are allowed.",
	format_character:
		"The message contains an invisible character that reorders or hides text.",
};

export type AgentNotifyResult =
	| ({
			ok: true;
			/** `delivered` when any surface showed the message. */
			status: "delivered" | "not_delivered" | "rate_limited";
			retryAfterMs?: number;
	  } & AgentNotificationReceipt)
	| {
			ok: false;
			error: {
				code: "invalid_request" | "notify_message_invalid" | "notify_failed";
				message: string;
				reason?: AgentNoticeTextRefusal;
			};
	  };

function invalidRequest(message: string): AgentNotifyResult {
	return { ok: false, error: { code: "invalid_request", message } };
}

/** Shows one admitted message and reports what each surface did. */
export async function handleAgentNotify(
	params: Record<string, unknown>,
): Promise<AgentNotifyResult> {
	const { message, sessionId } = params;
	if (typeof message !== "string" || message.length > MAX_MESSAGE_UNITS) {
		return invalidRequest("message must be text of at most 280 characters");
	}
	if (
		sessionId !== undefined &&
		(typeof sessionId !== "string" ||
			sessionId.length > MAX_SESSION_ID_LENGTH ||
			containsCliControlCharacter(sessionId))
	) {
		return invalidRequest("sessionId is invalid");
	}
	const { agents } = useStore.getState();
	const agentId = presenterAgentIdForSession(agents, sessionId?.trim() || undefined);
	const agent = agents.find((candidate) => candidate.id === agentId) ?? null;
	const admission = await agentNoticeAdmit(
		agent ? (agentSeatKey(agent) ?? agent.id) : PERSON_NOTICE_SENDER,
		message,
	);
	if (admission.outcome === "invalid") {
		return {
			ok: false,
			error: {
				code: "notify_message_invalid",
				reason: admission.reason,
				message: TEXT_REFUSALS[admission.reason],
			},
		};
	}
	if (admission.outcome === "rate_limited") {
		return {
			ok: true,
			status: "rate_limited",
			retryAfterMs: admission.retryAfterMs,
			...skippedAgentNotification(agentNotificationSender(agent).sender, "rate_limited"),
		};
	}
	const receipt = await notifyAgentEvent(agent?.id ?? null, "message", message, {
		eventId: `notify:${admission.notice}`,
	});
	// The phone does not carry messages yet, so the desktop decides.
	return {
		ok: true,
		status: receipt.desktop.status === "shown" ? "delivered" : "not_delivered",
		...receipt,
	};
}

interface AgentNotifyDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(reqId: string, result: unknown, action: string): Promise<unknown>;
	isMainWindow(): boolean;
}

/** Claims `agent.notify` in the main window, which owns notifications. */
export async function dispatchCliAgentNotifyRequest(
	request: { reqId: string; action: string; params: Record<string, unknown> },
	dependencies: AgentNotifyDependencies,
): Promise<boolean> {
	if (request.action !== AGENT_NOTIFY_ACTION) return false;
	if (!dependencies.isMainWindow() || !(await dependencies.claim(request.reqId)))
		return true;
	const result = await handleAgentNotify(request.params).catch(
		(error): AgentNotifyResult => ({
			ok: false,
			error: {
				code: "notify_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		}),
	);
	await dependencies.complete(request.reqId, result, request.action);
	return true;
}

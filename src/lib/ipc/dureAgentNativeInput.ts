import { t } from "@/lib/i18n";
import { createDureAgentRuntimeClient } from "./dureAgentRuntime";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "./dureBackend";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "./dureProtocolIdentity";
import type { AgentApprovalChoice } from "@/lib/agents/approvalRequest";

export interface NativeAgentPromptTargetV1 {
	readonly agentId: string;
	readonly backendProfileId: string;
	/** Terminal generation the pane presents; any other generation refuses. */
	readonly expectedTerminalEpoch: string;
}

export interface NativeAgentPromptReceiptV1 {
	readonly terminalEpoch: string;
	readonly recordId: string | null;
}

const MAX_PROMPT_BYTES = 64 * 1024;

function refused(code: string, message: string): DureBackendRequestError {
	return new DureBackendRequestError(code, t(message), {
		kind: "operation",
		disposition: "terminal",
	});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Sends one prompt through `agent_runtime.native.input`: the Host admits it
 * only at an idle prompt for the observed conversation, in one body+submit
 * write. The exact selection revision is read fresh first, so a replaced
 * runtime or terminal generation refuses instead of typing into another one.
 * There is no retry: an uncertain PTY write must never be sent twice. */
export async function sendNativeAgentPrompt(
	target: NativeAgentPromptTargetV1,
	text: string,
	options?: { invokeCommand?: DureBackendInvoke },
): Promise<NativeAgentPromptReceiptV1> {
	if (
		!isDureDomainIdV1(target.agentId) ||
		!isDureBackendProfileIdV1(target.backendProfileId) ||
		!target.expectedTerminalEpoch ||
		!text.trim() ||
		text.includes("\0") ||
		new TextEncoder().encode(text).length > MAX_PROMPT_BYTES
	) {
		throw refused(
			"agent_runtime_native_request_invalid",
			"agents.nativeChat.error.requestInvalid",
		);
	}
	const projection = await createDureAgentRuntimeClient({
		profileId: target.backendProfileId,
		invokeCommand: options?.invokeCommand,
	}).inspect(target.agentId);
	if (
		projection.state !== "stable" ||
		projection.interactionProfile !== "native_cli" ||
		projection.stopFence.terminalEpoch !== target.expectedTerminalEpoch
	) {
		throw refused(
			"agent_runtime_native_changed",
			"agents.nativeChat.error.changed",
		);
	}
	const request = createDureBackendRequester({
		profileId: target.backendProfileId,
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "agent_runtime_native_input_unconfirmed",
		invalidResponseMessage: "agents.nativeChat.error.unconfirmed",
		backendChangedCode: "agent_runtime_native_changed",
		backendChangedMessage: "agents.nativeChat.error.changed",
		requestFailedCode: "agent_runtime_native_input_failed",
		requestFailedMessage: "agents.nativeChat.error.refused",
	});
	const response = await request(
		"agent_runtime.native.input",
		{
			schemaVersion: 1,
			agentId: target.agentId,
			expectedSelectionRevision: projection.selectionRevision,
			expectedTerminalEpoch: target.expectedTerminalEpoch,
			text,
		},
		{ kind: "exact", authority: projection.routeAuthority },
	);
	const result = record(response.result);
	const receipt = record(result?.receipt);
	if (
		result?.schemaVersion !== 1 ||
		receipt?.terminalEpoch !== target.expectedTerminalEpoch ||
		receipt.state !== "written_to_pty"
	) {
		throw refused(
			"agent_runtime_native_input_unconfirmed",
			"agents.nativeChat.error.unconfirmed",
		);
	}
	return {
		terminalEpoch: target.expectedTerminalEpoch,
		recordId: typeof receipt.recordId === "string" ? receipt.recordId : null,
	};
}

export interface NativeAgentApprovalReceiptV1 {
	readonly terminalEpoch: string;
	readonly attentionId: string;
}

const APPROVAL_CHOICES: ReadonlySet<string> = new Set([
	"approve",
	"approve_always",
	"deny",
]);

/** Answers the native agent's pending approval through
 * `agent_runtime.native.answer`: the Host writes the provider's keys only
 * while the approval `attentionId` names is pending and no one has typed
 * into the terminal since it was raised, so a stale card types nothing. The
 * exact selection revision is read fresh first, as for a prompt. There is no
 * retry: an uncertain PTY write must never be sent twice. */
export async function answerNativeAgentApproval(
	target: NativeAgentPromptTargetV1,
	attentionId: string,
	choice: AgentApprovalChoice,
	options?: { invokeCommand?: DureBackendInvoke },
): Promise<NativeAgentApprovalReceiptV1> {
	if (
		!isDureDomainIdV1(target.agentId) ||
		!isDureBackendProfileIdV1(target.backendProfileId) ||
		!target.expectedTerminalEpoch ||
		!attentionId ||
		!APPROVAL_CHOICES.has(choice)
	) {
		throw refused(
			"agent_runtime_native_request_invalid",
			"agents.nativeChat.error.requestInvalid",
		);
	}
	const projection = await createDureAgentRuntimeClient({
		profileId: target.backendProfileId,
		invokeCommand: options?.invokeCommand,
	}).inspect(target.agentId);
	if (
		projection.state !== "stable" ||
		projection.interactionProfile !== "native_cli" ||
		projection.stopFence.terminalEpoch !== target.expectedTerminalEpoch
	) {
		throw refused(
			"agent_runtime_native_changed",
			"agents.nativeChat.approval.error.changed",
		);
	}
	const request = createDureBackendRequester({
		profileId: target.backendProfileId,
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "agent_runtime_native_answer_unconfirmed",
		invalidResponseMessage: "agents.nativeChat.approval.error.unconfirmed",
		backendChangedCode: "agent_runtime_native_changed",
		backendChangedMessage: "agents.nativeChat.approval.error.changed",
		requestFailedCode: "agent_runtime_native_answer_failed",
		requestFailedMessage: "agents.nativeChat.approval.error.failed",
	});
	const response = await request(
		"agent_runtime.native.answer",
		{
			schemaVersion: 1,
			agentId: target.agentId,
			expectedSelectionRevision: projection.selectionRevision,
			expectedTerminalEpoch: target.expectedTerminalEpoch,
			attentionId,
			choice,
		},
		{ kind: "exact", authority: projection.routeAuthority },
	);
	const result = record(response.result);
	const receipt = record(result?.receipt);
	if (
		result?.schemaVersion !== 1 ||
		receipt?.terminalEpoch !== target.expectedTerminalEpoch ||
		receipt.attentionId !== attentionId ||
		receipt.state !== "written_to_pty"
	) {
		throw refused(
			"agent_runtime_native_answer_unconfirmed",
			"agents.nativeChat.approval.error.unconfirmed",
		);
	}
	return { terminalEpoch: target.expectedTerminalEpoch, attentionId };
}

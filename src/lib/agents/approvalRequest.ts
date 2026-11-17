/** A native agent's pending approval as the Host projects it, shared by the
 * desktop and phone chats. The Host names the approval (`attentionId`) and
 * carries what its provider asked; the chats show it and answer it through
 * the Host, which writes the provider's keys only while this exact approval
 * is pending and no one has typed into the terminal since it was raised.
 * This module imports nothing, so the phone's build can share it. */

/** One answer a provider offers for an approval. */
export type AgentApprovalChoice = "approve" | "approve_always" | "deny";

/** A pending approval's tool, bounded input summary and offered answers. */
export interface AgentApprovalRequest {
	readonly toolName: string;
	readonly summary?: string;
	readonly choices: readonly AgentApprovalChoice[];
}

const CHOICES: ReadonlySet<string> = new Set<AgentApprovalChoice>([
	"approve",
	"approve_always",
	"deny",
]);
const TOOL_NAME_MAX_BYTES = 128;
const SUMMARY_MAX_BYTES = 2048;
// The Host bounds what it carries; rendering removes formatting characters
// again so no Host version can reorder what the person approves.
const FORMATTING = /\p{Cf}/gu;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** A control character, other than the line breaks and tabs a multi-line
 * command keeps when `lineBreaks` allows them. */
function hasControl(value: string, lineBreaks: boolean): boolean {
	return [...value].some((character) => {
		if (lineBreaks && (character === "\n" || character === "\t")) return false;
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code < 0xa0);
	});
}

/** What a pending approval asks, from its `toolName`, `summary` and
 * `choices`. Optional presentation from newer Hosts must never invalidate
 * the Host's semantic state: anything malformed is simply absent, and the
 * approval is answered in the terminal as before. */
export function parseAgentApprovalRequest(
	value: unknown,
): AgentApprovalRequest | undefined {
	if (!record(value)) return undefined;
	const { toolName, summary, choices } = value;
	if (
		typeof toolName !== "string" ||
		!toolName ||
		bytes(toolName) > TOOL_NAME_MAX_BYTES ||
		hasControl(toolName, false) ||
		(summary !== undefined &&
			(typeof summary !== "string" ||
				bytes(summary) > SUMMARY_MAX_BYTES ||
				hasControl(summary, true))) ||
		!Array.isArray(choices) ||
		choices.length === 0 ||
		!choices.every((choice) => CHOICES.has(choice)) ||
		new Set(choices).size !== choices.length ||
		!choices.includes("approve") ||
		!choices.includes("deny")
	) {
		return undefined;
	}
	const shown =
		typeof summary === "string" ? summary.replace(FORMATTING, "") : "";
	return {
		toolName: toolName.replace(FORMATTING, ""),
		...(shown ? { summary: shown } : {}),
		choices: choices as AgentApprovalChoice[],
	};
}

/** An approval a chat can show and answer. */
export interface PendingApproval {
	readonly attentionId: string;
	readonly request: AgentApprovalRequest;
}

/** The approval the agent waits on now, when its provider said what it asks.
 * An approval without content (an older Host, or a prompt that is not a
 * plain approval) stays the terminal's to answer. */
export function pendingApproval(
	runtime:
		| {
				readonly lifecycle: string;
				readonly attention: string;
				readonly attentionId?: string;
				readonly approvalRequest?: AgentApprovalRequest;
		  }
		| undefined,
): PendingApproval | undefined {
	if (
		runtime?.lifecycle !== "running" ||
		runtime.attention !== "approval_required" ||
		!runtime.attentionId ||
		!runtime.approvalRequest
	) {
		return undefined;
	}
	return { attentionId: runtime.attentionId, request: runtime.approvalRequest };
}

/** Where one answer from this chat stands, for the approval it names. */
export interface ApprovalAnswerState {
	readonly attentionId: string;
	readonly state: "sending" | "sent" | "failed";
}

/** The card shows until this chat's answer reached the terminal; the Host
 * then moves on to the next state on its own. */
export function approvalShown(
	approval: PendingApproval | undefined,
	answer: ApprovalAnswerState | undefined,
): approval is PendingApproval {
	return (
		approval !== undefined &&
		!(answer?.attentionId === approval.attentionId && answer.state === "sent")
	);
}

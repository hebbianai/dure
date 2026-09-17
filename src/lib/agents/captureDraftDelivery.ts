/** Place captured content in an editable draft. The user can review it
 * and add their request before submitting; capture delivery never sends Enter
 * or starts, steers or queues a structured chat turn. */

import { buildPromptWithAttachments } from "@/lib/agents/attachmentPrompt";
import { deliverAgentChatDraft } from "@/lib/agents/chat/agentChatDraftDelivery";
import { revalidateAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
import {
	type DroppedFilePayload,
	preparedFilePaths,
} from "@/lib/files/externalFileDrop";
import { saveSessionFiles } from "@/lib/files/sessionFileTransfer";
import { revalidateHmuxExactInputTarget } from "@/lib/hmux/identity/hmuxExactInputTarget";
import { readFile } from "@/lib/ipc";
import {
	executeExactHmuxInput,
	executeManagedAgentInput,
	prepareHmuxInputForTarget,
	prepareManagedAgentInput,
} from "@/lib/sessions/managed/managedAgentInput";
import { useStore } from "@/store";

type CaptureDraftAttachment =
	| { kind: "bytes"; file: DroppedFilePayload }
	| { kind: "local_file"; path: string };

class CaptureDraftDeliveryError extends Error {
	constructor(
		readonly code: "agent_missing" | "write_failed",
		message: string,
	) {
		super(message);
		this.name = "CaptureDraftDeliveryError";
	}
}

export async function deliverCaptureToAgent(
	agentId: string,
	text: string,
	attachments: CaptureDraftAttachment[] = [],
): Promise<void> {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	if (!agent) {
		throw new CaptureDraftDeliveryError(
			"agent_missing",
			`agent is no longer open: ${agentId}`,
		);
	}
	try {
		const prepared = prepareManagedAgentInput({
			name: agent.id,
			text,
			enter: false,
		});
		if (!attachments.length) {
			if (prepared.kind === "structured_draft")
				await deliverAgentChatDraft(prepared.target, text);
			else await executeManagedAgentInput(prepared);
			return;
		}
		if (prepared.kind !== "hmux" && prepared.kind !== "structured_draft")
			throw new Error("capture_target_requires_draft_input");
		if (prepared.kind === "structured_draft") {
			revalidateAgentChatDraftTarget(prepared.target);
			if (prepared.target.project?.kind !== "local")
				throw new Error("capture_chat_attachments_unavailable");
		}
		const files = await Promise.all(
			attachments.map(async (attachment) => {
				if (attachment.kind === "bytes") return attachment.file;
				const file = await readFile(attachment.path);
				if (
					file.kind !== "image" ||
					file.truncated ||
					!file.content ||
					!file.mime?.startsWith("image/")
				)
					throw new Error("capture_attachment_unavailable");
				return { fileName: file.name, dataB64: file.content };
			}),
		);
		if (prepared.kind === "structured_draft") {
			await deliverAgentChatDraft(prepared.target, text, files);
			return;
		}
		const { binding } = prepared.target;
		revalidateHmuxExactInputTarget(prepared.target);
		const paths = preparedFilePaths(
			await saveSessionFiles(
				binding.source === "ssh" ? binding.hostId : undefined,
				files,
			),
			files.length,
		);
		// Validate the final text without replacing the original recipient.
		await executeExactHmuxInput(
			prepareHmuxInputForTarget(prepared.target, {
				text: buildPromptWithAttachments(text, paths),
				enter: false,
			}),
		);
	} catch (error) {
		throw new CaptureDraftDeliveryError(
			"write_failed",
			`could not type the capture into ${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

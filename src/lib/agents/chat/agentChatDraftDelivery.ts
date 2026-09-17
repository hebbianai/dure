import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	appendAgentChatDraft,
	type PreparedAgentChatDraftTarget,
	revalidateAgentChatDraftTarget,
} from "@/lib/agents/chat/agentChatDraftInput";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { requestAgentSessionDraftAppend } from "@/lib/workspace/window/agentSessionWindowCommand";
import {
	resolveMountedPaneWindow,
	revalidateMountedPaneWindow,
} from "@/lib/workspace/window/mountedPaneWindow";

/** Add external content where the user can edit it, including from a Browser
 * pane in another window. A missing/uncertain owner never creates a local draft. */
export async function deliverAgentChatDraft(
	target: PreparedAgentChatDraftTarget,
	text: string,
	attachments: readonly DroppedFilePayload[] = [],
): Promise<void> {
	const owner = await resolveMountedPaneWindow({
		agentId: target.identity.agentId,
	});
	if (owner.windowLabel === getCurrentWebviewWindow().label) {
		revalidateMountedPaneWindow(owner);
		appendAgentChatDraft(target, text, attachments, {
			desktopId: owner.desktopId,
			panelId: owner.paneId,
		});
		return;
	}
	revalidateAgentChatDraftTarget(target);
	await requestAgentSessionDraftAppend({ target, owner, text, attachments });
}

import { useState } from "react";
import { Alert, FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AgentChatDraftMove } from "@/lib/agents/chat/agentChatDraftMove";
import {
	type AgentChatDraftRecoveryIntent,
	recoverAgentChatDraftMove,
} from "@/lib/agents/chat/agentChatDraftMoveRecovery";
import { useChatDraftMoveNotices } from "@/components/workspace/useChatDraftMoveNotices";
import { t } from "@/lib/i18n";

function DraftMove({
	move,
	name,
	canCancel,
}: {
	move: AgentChatDraftMove;
	name: string;
	canCancel: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function recover(intent: AgentChatDraftRecoveryIntent) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const receipt = await recoverAgentChatDraftMove({
				transfer: move.transfer,
				intent,
			});
			if (receipt.status === "staged" || receipt.status === "moved")
				setError(t("agents.chat.draftMoveUnfinished"));
		} catch {
			setError(t("agents.chat.draftMoveRecoveryFailed"));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className={`p-3 text-xs ${FLOATING_CARD}`}>
			<p role="status">{t("agents.chat.draftMovePending", { name })}</p>
			{error && <Alert className="mt-2">{error}</Alert>}
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					size="xs"
					variant="outline"
					disabled={busy}
					onClick={() => void recover("finish")}
				>
					{t("agents.chat.draftMoveCheck")}
				</Button>
				<Button
					size="xs"
					variant="outline"
					disabled={busy || !canCancel}
					onClick={() => void recover("cancel")}
				>
					{t("agents.chat.draftMoveKeepSource")}
				</Button>
			</div>
		</div>
	);
}

/** Lives with the workspace so a removed source pane still exposes recovery. */
export function ChatDraftMoveNotice({ desktopId }: { desktopId: string }) {
	const pending = useChatDraftMoveNotices(desktopId);
	if (!pending.length) return null;
	return (
		<div className="absolute right-2 top-2 z-20 flex max-w-sm flex-col gap-2">
			{pending.map(({ move, name, canCancel }) => (
				<DraftMove
					key={move.transfer.id}
					move={move}
					canCancel={canCancel}
					name={name}
				/>
			))}
		</div>
	);
}

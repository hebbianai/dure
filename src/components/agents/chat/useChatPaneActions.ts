import { usePaneActions } from "@/components/workspace/usePaneActions";
import {
	type ChatPaneHandlers,
	type ChatPaneIdentity,
	type ChatPaneSessionFacts,
	chatPaneActionEntry,
} from "@/lib/workspace/pane/chatPaneActions";

/** Keeps the mounted chat pane registered in the shared pane action registry
 * with the composer's exact handlers, so `dure client pane state` and
 * `pane act <pane> <action>` see and do what the user sees and does. Handlers
 * refresh only after commit and remain bound to the same runtime and turn. */
export function useChatPaneActions(
	identity: ChatPaneIdentity,
	session: ChatPaneSessionFacts & ChatPaneHandlers,
	runtimeOwnerKey: string,
): void {
	usePaneActions(
		JSON.stringify([
			runtimeOwnerKey,
			identity.conversationId,
			session.activeTurn?.turnId,
			session.resendLastMessage?.failureId,
		]),
		chatPaneActionEntry(identity, session, session),
	);
}

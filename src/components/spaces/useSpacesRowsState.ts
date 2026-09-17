// SpacesRows' designated store-wiring point (cluster wiring hook). Every
// global-store subscription the row components need lives here — one hook per
// consumer (the account-menu helper, OpenSpaceRow, UnopenedAgentRow); the
// components consume the returned values and keep rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { conversationActivityAt, conversationPrompt } from "@/lib/agents/chat/conversationPresentationState";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { isPanePinned, panePinKey } from "@/lib/workspace/pane/panePin";
import type { Agent } from "@/types";
import { useStore } from "@/store";

/** Store wiring for useSpaceMenuAccounts — the account-menu derivation itself
 *  stays beside the rows. */
export function useSpaceMenuAccountsState(agentId: string | undefined) {
  const accounts = useStore((s) => s.accounts);
  const activeAccounts = useStore((s) => s.activeAccounts);
  const assigned = useStore((s) => {
    if (!agentId) return undefined;
    const agent = s.agents.find((candidate) => candidate.id === agentId);
    return agent ? (agentCredentialReferenceId(agent) ?? null) : null;
  });
  return { accounts, activeAccounts, assigned };
}

export function useOpenSpaceRowState(space: { desktopId: string; key: string }) {
  const isFocused = useStore(
    (state) =>
      state.activeSpaceId === space.desktopId &&
      state.focusCtx?.key === space.key,
  );
  return { isFocused };
}

/** Pane pin and move targets — subscribed only while a row menu is open
 *  (OpenSpaceRowMenu mounts inside the Radix content). */
export function useOpenSpaceMenuState(space: { desktopId: string; key: string }) {
  const desktops = useStore((state) => state.desktops);
  const pinKey = panePinKey(space.desktopId, space.key);
  const pinned = useStore((state) => isPanePinned(state.pinnedPanes, pinKey));
  const togglePanePin = useStore((state) => state.togglePanePin);
  return { desktops, pinned, togglePin: () => togglePanePin(pinKey) };
}

export function useUnopenedAgentRowState(agent: Agent) {
  const promptActivity = useStore(
    (state) => state.sessionActivity[agent.sessionId],
  );
  const sessionTitle = useStore((state) => state.sessionTitle[agent.sessionId]);
  const conversationTitle = useConversationTitle(agent.id);
  const visibleFields = useStore((state) => state.uiPrefs.spacesViewOptions.visibleFields);
  const restoredPrompt = conversationPrompt(agent.id, managedConversationId(agent));
  return { promptActivity: promptActivity?.text ? promptActivity : restoredPrompt ? { ...promptActivity, text: restoredPrompt } : promptActivity,
    sessionTitle, conversationTitle, visibleFields,
    conversationActivityAt: conversationActivityAt(agent.id, managedConversationId(agent)),
  };
}

import type { Provider } from "@/types";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from "@/lib/settings/notifyPrefs";

export interface TerminalBellNotificationInput {
  enabled: boolean;
  terminalBell: boolean;
  suppressWhenVisible: boolean;
  visible: boolean;
  provider?: Provider | null;
}

/** Provider TUIs own their semantic attention notifications. Their BEL is a
 * rendering detail and must not leak out as a generic terminal notification,
 * especially from standalone terminals that are not registered Agents. */
export function shouldDeliverTerminalBellNotification({
  enabled,
  terminalBell,
  suppressWhenVisible,
  visible,
  provider,
}: TerminalBellNotificationInput): boolean {
  if (!enabled || !terminalBell || provider) return false;
  return !(suppressWhenVisible && visible);
}

interface TerminalBellNotificationState {
  notifyPrefs: Partial<NotifyPrefs>;
  agents: ReadonlyArray<{ sessionId: string; provider: Provider }>;
  sessionAgentPin: Record<string, Provider | undefined>;
  sessionAgent: Record<string, Provider | null | undefined>;
  sessionTitle: Record<string, string | undefined>;
}

interface TerminalBellNotificationHandlerOptions {
  sessionId: string;
  providerHint?: Provider | null;
  getState: () => TerminalBellNotificationState;
  isVisible: () => boolean;
  notify: (title: string, body: string) => unknown;
  translate: (source: string) => string;
  now?: () => number;
  debounceMs?: number;
}

/** Build the xterm BEL callback without making the terminal component own
 * provider lookup, notification policy, or burst suppression. */
export function createTerminalBellNotificationHandler({
  sessionId,
  providerHint,
  getState,
  isVisible,
  notify,
  translate: t,
  now = Date.now,
  debounceMs = 3000,
}: TerminalBellNotificationHandlerOptions): () => void {
  let lastBell: number | undefined;
  return () => {
    const state = getState();
    const prefs = { ...DEFAULT_NOTIFY_PREFS, ...state.notifyPrefs };
    const registeredAgent = state.agents.find((agent) => agent.sessionId === sessionId);
    const provider =
      providerHint ??
      state.sessionAgentPin[sessionId] ??
      state.sessionAgent[sessionId] ??
      registeredAgent?.provider;
    if (
      !shouldDeliverTerminalBellNotification({
        enabled: prefs.enabled,
        provider,
        suppressWhenVisible: prefs.suppressWhenVisible,
        terminalBell: prefs.terminalBell,
        visible: isVisible(),
      })
    ) {
      return;
    }
    const currentTime = now();
    if (lastBell !== undefined && currentTime - lastBell < debounceMs) return;
    lastBell = currentTime;
    const title = state.sessionTitle[sessionId]?.trim() || t("common.terminal");
    void notify(title, t("terminal.bell.rang"));
  };
}

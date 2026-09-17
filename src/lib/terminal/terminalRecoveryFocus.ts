export interface TerminalRecoveryFocusContext {
  requested: boolean;
  documentFocused: boolean;
  workspaceActive: boolean;
  paneVisible: boolean;
  paneActive: boolean;
  geometryVisible: boolean;
  focusTargetAvailable: boolean;
  focusOwnershipUnchanged: boolean;
}

export class TerminalRecoveryFocusTracker {
  private revision = 0;

  snapshot() {
    return this.revision;
  }

  markFocusIntent() {
    this.revision += 1;
  }

  unchanged(snapshot: number) {
    return this.revision === snapshot;
  }
}

export const terminalRecoveryFocusTracker = new TerminalRecoveryFocusTracker();
const trackedDocuments = new WeakSet<Document>();

/**
 * Track explicit focus intent for the lifetime of one WebView document.
 * Pointer intent matters in addition to `focusin`: clicking a non-focusable
 * split must still invalidate a renderer remount's stale focus claim.
 */
export function installTerminalRecoveryFocusTracking(target: Document) {
  if (trackedDocuments.has(target)) return;
  trackedDocuments.add(target);
  const markFocusIntent = () => terminalRecoveryFocusTracker.markFocusIntent();
  target.addEventListener("pointerdown", markFocusIntent, true);
  target.addEventListener("focusin", markFocusIntent, true);
}

/**
 * Reacquire the controller only when the same pane still owns every local
 * focus signal. This preserves input across a renderer-only recovery without
 * stealing the Hmux lease from a pane or window the user selected meanwhile.
 */
export function shouldRestoreTerminalRecoveryFocus(
  context: TerminalRecoveryFocusContext,
) {
  return (
    context.requested &&
    context.documentFocused &&
    context.workspaceActive &&
    context.paneVisible &&
    context.paneActive &&
    context.geometryVisible &&
    context.focusTargetAvailable &&
    context.focusOwnershipUnchanged
  );
}

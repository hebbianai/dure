// Very small global toast channel — brief feedback ("Copied to clipboard")
// that stacks at the bottom of the workspace. No dependencies: subscribers are
// handed the current stack.
//
// Errors travel this channel too, so a last-write-wins single slot would let
// consecutive failures erase each other (2026-08-01 UX review). Keep it short
// but stacked: at most three rows, an ordinary toast auto-dismisses, and an
// error stays until the reader closes it.
//
// A report that belongs to a pane names it (`paneId`), and the column that
// pane mounts shows it at the pane's own bottom edge — a copy made in one
// terminal is answered in that terminal, not in the middle of the workspace
// (owner call 2026-09-13). A pane column claims its id while its pane is on
// screen; a pane-scoped toast whose pane has no column (a hidden tab, a pane
// on another desktop, a window without pane columns) falls back to the
// workspace column.

import { createBroadcast } from "@/lib/state/broadcast";

type ToastSeverity = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  text: string;
  severity: ToastSeverity;
  /** The pane the report belongs to; absent for a workspace-level report. */
  paneId?: string;
}

export interface ToastOptions {
  paneId?: string;
}

type Listener = (toasts: readonly ToastItem[]) => void;

/** Visible stack depth. Beyond this the oldest row is dropped immediately
 *  rather than queued — a notice nobody has read yet is not worth delaying the
 *  one that just happened. */
const MAX_STACK = 3;

/** Default lifetime of an ordinary toast. */
const AUTO_DISMISS_MS = 2500;

const changes = createBroadcast<readonly ToastItem[]>();
let toasts: readonly ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** Pane ids with a mounted column, counted so two columns for one pane
 *  (a pane shown twice during a layout move) release cleanly. */
const claims = new Map<string, number>();

function publish() {
  changes.publish(toasts);
}

function push(
  text: string,
  severity: ToastSeverity,
  ms: number | null,
  paneId: string | undefined,
): number {
  const id = nextId++;
  // Oldest first out — the evicted toast's timer is harmless because dismiss is
  // a no-op once the row is gone.
  toasts = [
    ...toasts,
    { id, text, severity, ...(paneId ? { paneId } : {}) },
  ].slice(-MAX_STACK);
  publish();
  if (ms !== null) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), ms),
    );
  }
  return id;
}

/** Informational toast. Consecutive calls stack (at most three). Returns the id
 *  for dismissToast. The second argument is a lifetime in ms, or options
 *  (`ms`, and `paneId` for a report that belongs to a pane). */
export function showToast(
  text: string,
  msOrOptions: number | (ToastOptions & { ms?: number }) = AUTO_DISMISS_MS,
): number {
  const options = typeof msOrOptions === "number" ? { ms: msOrOptions } : msOrOptions;
  return push(text, "info", options.ms ?? AUTO_DISMISS_MS, options.paneId);
}

/** Failure toast — stays until it is dismissed, and the Toaster lets the reader
 *  select and copy it. A failure that vanishes on a timer cannot be read back. */
export function showErrorToast(text: string, options?: ToastOptions): number {
  return push(text, "error", null, options?.paneId);
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  publish();
}

export function subscribeToast(listener: Listener): () => void {
  const unsubscribe = changes.subscribe(listener);
  // Replay the live stack on subscribe — a window that opens late still agrees.
  listener(toasts);
  return unsubscribe;
}

/** A pane's toast column announces itself while mounted; returns the release.
 *  Subscribers are republished either way, since which column shows a
 *  pane-scoped toast depends on the claim. */
export function claimPaneToasts(paneId: string): () => void {
  claims.set(paneId, (claims.get(paneId) ?? 0) + 1);
  republish();
  return () => {
    const remaining = (claims.get(paneId) ?? 1) - 1;
    if (remaining <= 0) claims.delete(paneId);
    else claims.set(paneId, remaining);
    republish();
  };
}

function republish() {
  toasts = [...toasts];
  publish();
}

/** The toasts a column shows: a pane column, its own pane's; the workspace
 *  column, every workspace-level toast plus any pane-scoped toast whose pane
 *  has no column of its own right now. */
export function toastsForColumn(
  paneId: string | undefined,
  all: readonly ToastItem[],
): readonly ToastItem[] {
  return paneId
    ? all.filter((toast) => toast.paneId === paneId)
    : all.filter((toast) => !toast.paneId || !claims.has(toast.paneId));
}

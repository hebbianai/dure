import { useEffect, useState } from "react";
import { UpdateNoticeQueue } from "@/components/common/UpdateNoticeQueue";
import { RestartPreparationNotice } from "@/components/common/RestartPreparationNotice";
import { TelemetryNotice } from "@/components/common/TelemetryNotice";
import { Alert } from "@/components/ui/alert";
import { t } from "@/lib/i18n";
import {
  claimPaneToasts,
  dismissToast,
  subscribeToast,
  type ToastItem,
  toastsForColumn,
} from "@/lib/toast";
import { useModalOpen } from "@/lib/ui/modalPresence";
import { useUpdateNoticeSnapshot } from "@/lib/updates/useUpdateNoticeSnapshot";
import { cn } from "@/lib/utils";
import { isMainWindow } from "@/lib/workspace/window/windows";

/** The brief-toast column. `className` places it: the main window puts it
 * inside the workspace `<main>` (absolute, so "centre" is the workspace's
 * centre, not the window's — with the sidebar open a window-centred toast
 * sat half a sidebar to the left; owner call 2026-09-13); a secondary window
 * has no sidebar and lets Toaster fix it to the window. With `paneId` it is
 * a pane's own column: every pane mounts one at its bottom edge, and a
 * report made in that pane lands there (owner call 2026-09-13). */
export function BriefToasts({
  className,
  paneId,
}: {
  className: string;
  paneId?: string;
}) {
  const [all, setAll] = useState<readonly ToastItem[]>([]);
  useEffect(() => subscribeToast(setAll), []);
  useEffect(() => (paneId ? claimPaneToasts(paneId) : undefined), [paneId]);
  const toasts = toastsForColumn(paneId, all);
  if (toasts.length === 0) return null;
  return (
    // A brief toast is the one notice component on its floating surface
    // (Alert surface="toast"): the sidebar band's anatomy on the menu's
    // material, since it floats over content it is unrelated to. A
    // failure wears the destructive tone and its glyph; a plain report
    // is neutral (owner call 2026-09-12 — one form for every notice that
    // floats, here or in a pane's corner).
    // Each toast is its own live region — a plain report is polite, a
    // failure asserts (Alert's default for the destructive tone). The
    // column itself carries none, so an error is not announced twice.
    // px-2: the column spans its box edge to edge, so without a gutter a
    // toast as wide as the box touches the pane's rim (owner report
    // 2026-09-13, a report clipped on both sides in a narrow pane).
    <div
      className={cn(
        "pointer-events-none z-[110] flex flex-col items-center gap-2 px-2",
        className,
      )}
    >
      {toasts.map((toast) => {
        const failure = toast.severity === "error";
        return (
          <Alert
            key={toast.id}
            surface="toast"
            tone={failure ? "destructive" : "neutral"}
            role={failure ? "alert" : "status"}
            dismiss={
              failure
                ? { label: t("common.close"), onClick: () => dismissToast(toast.id) }
                : undefined
            }
            className={cn(
              // 24rem, the update card's width: at 35rem a centred toast
              // reached the bottom-right card on any workspace under
              // ~1370px (owner report 2026-09-13); a fixed, modest width is
              // how two notice regions usually keep out of each other's way.
              // The other half of the cap is the column itself, not the
              // viewport: a pane's column is as wide as that pane, and 80vw
              // let a report grow past a narrow pane and be clipped on both
              // sides (owner report 2026-09-13).
              "max-w-[min(100%,24rem)] animate-in duration-[160ms] ease-out fade-in slide-in-from-bottom-2",
              // A failure stays until it is closed, so it takes the
              // pointer: the close control, and text one can select.
              failure && "pointer-events-auto select-text",
            )}
          >
            {toast.text}
          </Alert>
        );
      })}
    </div>
  );
}

/** Render one update action at bottom-right, the restart band, and — unless
 * the window places BriefToasts itself — the brief toasts at bottom-centre.
 * Each window root mounts one instance; only the main window publishes updates.
 *
 * Layers, bottom to top: a notice pinned inside a pane sits at z-20 in that
 * pane; a floating card (update, capture) at 100; the brief toasts at 110 so
 * a report is never under a card; the restart band at 200 over everything. */
export function Toaster({ brief = true }: { brief?: boolean } = {}) {
  // Held, not dropped, while a modal is up: this notice stays until someone
  // dismisses it, so waiting costs nothing and it comes back the moment the
  // modal closes. Brief toasts below are left alone — they run a 2.5s clock,
  // so hiding one would silently spend it, and a small low-contrast row at the
  // bottom edge is not what pulls the eye off a modal (owner report
  // 2026-09-08: the bright notice card and its white button were).
  const modalOpen = useModalOpen();
  const updateNotices = useUpdateNoticeSnapshot().notices;
  const updateNotice = updateNotices.find(
    (notice) => !notice.dismissed,
  );
  const visibleNotice = modalOpen ? undefined : updateNotice;
  const mainWindow = isMainWindow();
  return (
    <>
      <RestartPreparationNotice />
      {visibleNotice ? (
        <div
          aria-live="polite"
          className="pointer-events-none fixed right-5 bottom-5 z-[100] w-[min(24rem,calc(100vw-2.5rem))]"
        >
          <UpdateNoticeQueue notices={updateNotices} />
        </div>
      ) : null}
      {mainWindow ? (
        // The same corner and the same hold-while-modal rule as the update
        // card; an update outranks the question, which waits its turn. Kept
        // mounted so the window asks the native side once, not per toggle.
        <TelemetryNotice hidden={modalOpen || visibleNotice !== undefined} />
      ) : null}
      {brief ? <BriefToasts className="fixed inset-x-0 bottom-4" /> : null}
    </>
  );
}

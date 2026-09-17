"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { t } from "@/lib/i18n"
import { registerOpenModal } from "@/lib/ui/modalPresence"
import { ConfirmationButton } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // 스크림 '색'은 두 모드 모두 검정이다 — foreground 기반으로 바꾸면
        // 다크에서 흰색이 얹혀 오히려 배경이 밝아진다.
        //
        // 반면 '알파'는 모드별로 갈려야 한다. 같은 22%라도 눌리는 정도가 전혀
        // 다르기 때문이다: 라이트는 뒤 패널이 흰색(#ffffff)이라 22% 검정이 확
        // 내려앉지만, 다크는 이미 #242424라 22%를 덮어도 #1c1c1c 언저리로
        // 눈에 변화가 없다 — 어두운 것을 더 어둡게 하는 데는 훨씬 큰 알파가
        // 든다. 실제로 다크에서 뒤가 그대로 보인다는 보고가 나왔다
        // (2026-08-01). macOS에서 모달이 뜨면 뒤 창은 계속 보이되 확실히
        // 물러나는데, 두 모드가 그 지점에 닿는 알파가 다르다.
        //
        // 스크림은 흐리지 않는다. 유리로 뜨는 대화상자(설정)가 자기
        // backdrop-filter로 뒤를 흐리는데, 스크림이 먼저 흐려 놓으면 이중으로
        // 뭉개져서 뒤 내용이 형체를 잃고 유리가 아니라 판때기로 읽힌다.
        // 흐림은 흐리려는 표면이 직접 건다.
        //
        // The dark alpha comes back down to 30% (2026-09-08). The 50% above was
        // set when DialogContent was an opaque panel with no blur and no
        // shadow — the scrim was the only thing separating it, so it had to
        // crush the app to do that job. The panel now carries a material, a
        // shadow and a tint lighter than the panes behind it, and macOS panels
        // that read as glass (an NSOpenPanel over a dark app) dim their parent
        // by nothing at all: separation is the material's job, and a heavy
        // scrim only makes what shows through the glass muddy.
        "fixed inset-0 isolate z-50 bg-black/22 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 dark:bg-black/30",
        className
      )}
      {...props}
    />
  )
}

function DialogPresence() {
  // Follow Radix's rendered content, including its exit animation. The outer
  // DialogContent wrapper may stay mounted even while the dialog is closed.
  React.useEffect(() => registerOpenModal(), [])
  return null
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  dismiss = "all",
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Which light-dismiss gestures may close the dialog. Caller-supplied
   *  onInteractOutside/onEscapeKeyDown handlers still run afterwards and
   *  may add their own preventDefault on top of the mapping. */
  dismiss?: "all" | "escape-only" | "none"
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onInteractOutside={(event) => {
          if (dismiss !== "all") event.preventDefault()
          onInteractOutside?.(event)
        }}
        onEscapeKeyDown={(event) => {
          if (dismiss === "none") event.preventDefault()
          onEscapeKeyDown?.(event)
        }}
        className={cn(
          // grid-cols-1 (minmax(0,1fr)) is required: an implicit auto column's
          // min-width:auto propagates nowrap children's min-content width (e.g.
          // truncated paths) into the column, pushing content past the max-w panel.
          //
          // The surface is the window's own glass — the shell tint at the
          // shell alpha over a blur, exactly what the sidebar paints — with
          // `shadow-dialog` to lift it. It was `glass-dialog` at 80% over a
          // 20px blur until 2026-09-09: that read as a third tone next to the
          // sidebar's glass and the panes' surface (owner report on the Add
          // SSH host dialog), and the settings dialog had already moved to
          // the sidebar's material for its nav. One material for every
          // floating panel, so a dialog and the sidebar beside it move with
          // the wallpaper together. DialogOverlay deliberately does not blur
          // precisely so the dialog can blur its own backdrop.
          //
          // 40px of blur, not 20: at the shell's 50% the app's own UI behind
          // the panel needs more blur than the desktop does behind the
          // sidebar, or terminal lines come through as smears (the
          // 2026-08-01 finding). Text is sidebar-foreground for the same
          // reason the sidebar's is — it sits on the shell glass.
          //
          // No outer stroke: the shadow alone lifts the panel, as it does the
          // pane card and the sidebar. The menu hairline it carried until
          // 2026-09-09 was the brightest thing at the edge once the panel
          // took the shell glass over a dark scrim, so it read as a drawn
          // outline rather than a glass edge (owner report). Menus keep their
          // own hairline; a dialog is a sheet, not a menu.
          //
          // The corner follows that too: the pane card's 12px, shared with the
          // notice card, not the menu's 10px (owner call 2026-09-15). Every
          // dialog takes it — the palette and quick-dispatch overlays dropped
          // their own 18px the same day.
          //
          // Saturate after the blur, the way an AppKit material does. Blur is
          // an average of neighbouring pixels, and averaging unlike hues walks
          // them towards grey — a pure blur turns a colourful backdrop into
          // neutral soup, which reads as frosted plastic rather than glass.
          // Over this app's near-black panes there is little chroma to bring
          // back, so it earns its keep in light mode and over anything
          // coloured (an image preview, highlighted code) rather than today.
          // MENU_GLASS_FILL_CLASS deliberately does not do this: its tint and
          // alpha were measured off a native macOS menu, so the saturation is
          // already baked into the numbers and applying it again would double
          // up.
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] grid-cols-1 -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--glass-radius-pane)] bg-glass-pane/92 dark:bg-glass-pane/88 p-6 text-sm text-sidebar-foreground shadow-dialog backdrop-blur-[40px] backdrop-saturate-150 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        <DialogPresence />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <IconButton
              title={t("common.close")}
              className="absolute top-2.5 right-2.5"
            >
              <XIcon />
            </IconButton>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      // 6px between the title and its description (Figma 17375:198691,
      // spacing/1-5) — they read as one block, not two.
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // No band: the comp (Figma 17375:198691) ends the dialog with a plain
        // right-aligned row inside the container's own inset, and on glass the
        // filled strip read as a second surface stuck to the bottom edge
        // (owner call 2026-09-08). The buttons keep the 24px column the fields
        // above them stand on, because they no longer break out of it.
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <ConfirmationButton variant="glass">Close</ConfirmationButton>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        // 16px semibold (Figma 17375:198691, text-base/leading-none/semibold).
        "font-heading text-base leading-none font-semibold",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-xs text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };

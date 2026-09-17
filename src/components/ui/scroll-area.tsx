import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string
  viewportRef?: React.RefObject<HTMLDivElement | null>
  revealOnSidebarHover?: boolean
  /** 스크롤로 잘린 가장자리를 페이드로 흐린다. 균일한 높이의 행 목록에서
   *  위/아래 끝의 행이 중간에서 딱 잘려 보이는 것을 없앤다(사용자 지적
   *  2026-09-04, 커밋 목록). 끝에 닿은 쪽은 페이드를 걸지 않는다 — 걸면
   *  맨 위에서도 첫 행이 흐려져 "가려진 것"처럼 읽힌다. */
  edgeFade?: boolean
}

/** 페이드 폭. 12px(행 높이의 절반)에서 8px로 줄였다(2026-09-04): 절반이면
 *  잘린 행의 글자가 흐릿하게 *읽히는* 상태로 남아 "비활성 행"처럼 보였다.
 *  8px은 컷을 부드럽게만 하고 글자를 반쯤 살려두지 않는다. */
const EDGE_FADE = "8px"

/** 스크롤이 멎은 뒤 사이드바 막대가 사라지기까지. macOS overlay scrollbar와
 *  비슷한 한 박자 — Radix 기본 600ms는 트랙패드 관성이 끝나기 전에 사라져
 *  깜빡였다. */
const SIDEBAR_SCROLL_HIDE_DELAY = 800

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(function ScrollArea(
  {
    className,
    children,
    viewportClassName,
    viewportRef: suppliedViewportRef,
    revealOnSidebarHover = false,
    edgeFade = false,
    type,
    ...props
  },
  ref,
) {
  const internalViewportRef = React.useRef<HTMLDivElement>(null)
  const viewportRef = suppliedViewportRef ?? internalViewportRef
  const [edges, setEdges] = React.useState({ top: false, bottom: false })

  // 스크롤 위치로만 정한다. CSS 하나로 항상 걸어두면 목록이 짧거나 맨 위일
  // 때도 첫 행이 흐려진다.
  const syncEdges = React.useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const top = el.scrollTop > 1
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [viewportRef])

  React.useEffect(() => {
    if (!edgeFade) return
    const el = viewportRef.current
    if (!el) return
    syncEdges()
    // 내용이 늘거나 뷰포트가 리사이즈되면 끝에 닿았는지가 바뀐다 — 스크롤
    // 이벤트만으로는 그 순간을 못 잡는다.
    const observer = new ResizeObserver(syncEdges)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [edgeFade, syncEdges, viewportRef])

  const maskImage =
    edgeFade && (edges.top || edges.bottom)
      ? `linear-gradient(to bottom, ${
          edges.top ? `transparent 0, var(--mask-opaque) ${EDGE_FADE}` : "var(--mask-opaque) 0"
        }, ${edges.bottom ? `var(--mask-opaque) calc(100% - ${EDGE_FADE}), transparent 100%` : "var(--mask-opaque) 100%"})`
      : undefined

  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      data-slot="scroll-area"
      data-sidebar-scroll-area={revealOnSidebarHover ? "" : undefined}
      className={cn("relative", className)}
      // "scroll": the bar appears while the viewport scrolls and hides
      // scrollHideDelay after it stops, staying while the pointer is on it —
      // the macOS overlay scrollbar's behaviour (owner call 2026-09-09: a bar
      // should show up when the user scrolls, not sit there). A list that
      // does not overflow emits no scroll events, so it never shows one. The
      // previous form (2026-09-08) was "auto" revealed by aside hover, which
      // in practice meant always visible: the pointer is on the sidebar
      // whenever it is in use.
      // Explicit modes belong to the consumer; other sidebar lists keep
      // their scroll-only default.
      type={type ?? (revealOnSidebarHover ? "scroll" : undefined)}
      scrollHideDelay={revealOnSidebarHover ? SIDEBAR_SCROLL_HIDE_DELAY : undefined}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        onScroll={edgeFade ? syncEdges : undefined}
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar sidebarHover={revealOnSidebarHover} />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
})

function ScrollBar({
  className,
  orientation = "vertical",
  sidebarHover = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  sidebarHover?: boolean
}) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-sidebar-scrollbar={sidebarHover ? "" : undefined}
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none transition-colors select-none data-horizontal:flex-col data-vertical:h-full",
        sidebarHover
          // An 8px lane — the rows' own 8px inset — with a 4px thumb in the middle
          // of it: 2px off the sidebar's edge (flush there the thumb read as part
          // of the workspace card next to it, owner report 2026-09-09) and 2px off
          // the row fill (a 6px thumb touched it, owner report 2026-09-10). The
          // fade follows Radix's data-state so the bar eases in as scrolling
          // starts and out after it stops.
          ? "data-horizontal:h-2 data-horizontal:py-0.5 data-vertical:w-2 data-vertical:px-0.5 data-[state=visible]:animate-in data-[state=visible]:fade-in-0 data-[state=visible]:duration-100 data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0 data-[state=hidden]:duration-300"
          : "p-px data-horizontal:h-1.5 data-vertical:w-1.5",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className={cn(
          "relative flex-1 rounded-full",
          sidebarHover ? "bg-border" : "bg-[var(--sb-thumb)] hover:bg-[var(--sb-thumb-hover)]",
        )}
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

const SidebarScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  Omit<ScrollAreaProps, "revealOnSidebarHover">
>(function SidebarScrollArea(props, ref) {
  return <ScrollArea ref={ref} revealOnSidebarHover {...props} />
})

export { ScrollArea, SidebarScrollArea };

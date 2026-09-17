import type * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import {
  MENU_ITEM_CHECKABLE_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_HOVER_CLASS,
  MENU_ITEM_INDICATOR_CLASS,
  MENU_ITEM_PLAIN_CLASS,
  MENU_LABEL_CLASS,
  MENU_SIDE_OFFSET,
  MENU_SURFACE_CLASS,
} from "@/lib/ui/menuSurface"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"

// Desktop dropdowns must not swallow the first pointer action outside them.
// Callers can still opt into a truly modal menu explicitly.
function DropdownMenu({
  modal = false,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return (
    <DropdownMenuPrimitive.Root
      data-slot="dropdown-menu"
      modal={modal}
      {...props}
    />
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

// 닫힘(exit) 애니메이션을 일부러 두지 않는다 — 항목이 상태를 바꾸면(고정
// 토글·pane 제거·교체) exit 프레임의 리렌더가 popper 앵커 계산을 무너뜨려
// 메뉴가 좌측상단으로 튀었다(2026-08-01, 세 경로에서 재발). 닫히면 즉시
// 언마운트가 구조적 해법이고, 열림 애니메이션은 유지한다.
function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = MENU_SIDE_OFFSET,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 max-h-(--radix-dropdown-menu-content-available-height) w-(--radix-dropdown-menu-trigger-width) min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95", MENU_SURFACE_CLASS, className )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center outline-hidden select-none data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[variant=destructive]:*:[svg]:text-destructive",
        MENU_ITEM_CLASS,
        MENU_ITEM_HOVER_CLASS,
        MENU_ITEM_PLAIN_CLASS,
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center outline-hidden select-none data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        MENU_ITEM_CLASS,
        MENU_ITEM_HOVER_CLASS,
        MENU_ITEM_CHECKABLE_CLASS,
        className
      )}
      checked={checked}
      {...props}
    >
      <span
        className={MENU_ITEM_INDICATOR_CLASS}
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

// One-of-N choice inside a menu (view options such as "Group by"). Same box
// and indicator slot as the checkbox item so mixed menus keep one text column.
// The mark is a filled dot, not a check. One glyph everywhere was tried and
// left a menu unable to say which of its groups took one answer and which took
// several — Show and Grouping sit side by side in the same menu and both wore
// a check (owner call 2026-09-14, reversing 2026-09-13). A check now means "on,
// and its neighbours can be too"; a dot means "this one, instead of the
// others".
function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center outline-hidden select-none data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        MENU_ITEM_CLASS,
        MENU_ITEM_HOVER_CLASS,
        MENU_ITEM_CHECKABLE_CLASS,
        className
      )}
      {...props}
    >
      <span
        className={MENU_ITEM_INDICATOR_CLASS}
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          {/* 8px, and it has to say so twice: the menu item sizes every svg
              inside it to 12 (MENU_ITEM_CLASS), and a lucide circle keeps its
              2px stroke on top of the fill, which drew a 14px disc where a
              check is 12 (owner report 2026-09-14). */}
          <CircleIcon className="size-2! fill-current stroke-none" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        MENU_LABEL_CLASS,
        "font-medium data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center outline-hidden select-none data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        MENU_ITEM_CLASS,
        MENU_ITEM_HOVER_CLASS,
        MENU_ITEM_PLAIN_CLASS,
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  // The same gap the top-level menu keeps from its trigger. Radix defaults a
  // submenu to 0, so one only sat 4px off its parent where a call site
  // remembered to say so, and menus opened at two different distances
  // depending on which one you were in (owner report 2026-09-08).
  sideOffset = MENU_SIDE_OFFSET,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    // Portal이 없으면 Radix는 서브메뉴를 부모 Content 안에 그대로 렌더한다.
    // 그 부모가 overflow-x-hidden/overflow-y-auto 스크롤 컨테이너라, 옆으로
    // 열린 서브메뉴가 부모 박스를 벗어나는 순간 잘린다(사용자 제보).
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        sideOffset={sideOffset}
        className={cn("z-50 min-w-[96px] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95", MENU_SURFACE_CLASS, className )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent };

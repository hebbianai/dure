"use client"

import type * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import {
  MENU_ITEM_CHECKABLE_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_HOVER_CLASS,
  MENU_ITEM_INDICATOR_CLASS,
  MENU_SIDE_OFFSET,
  MENU_SURFACE_CLASS } from "@/lib/ui/menuSurface"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

const SELECT_TRIGGER_CLASS =
  "flex h-8 w-fit min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-background/70 py-2 pr-2 pl-3 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 *:data-[slot=select-value]:truncate *:data-[slot=select-value]:text-left dark:bg-input/30 dark:hover:bg-input/50 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

/** The same control surface for menus that also contain actions. */
function SelectButton({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="select-trigger"
      className={cn(SELECT_TRIGGER_CLASS, className)}
      {...props}
    >
      {children}
      <ChevronDownIcon aria-hidden="true" className="pointer-events-none size-4 text-muted-foreground" />
    </button>
  )
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        // rounded-md for the same reason as Button — the trigger is a control
        // inside a 10px surface, not a surface itself.
        SELECT_TRIGGER_CLASS,
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = MENU_SIDE_OFFSET,
  container,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  container?: React.ComponentProps<typeof SelectPrimitive.Portal>["container"]
}) {
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        data-slot="select-content"
        // Open at the final geometry, without scaling or sliding over pane output.
        className={cn("relative z-50 max-h-(--radix-select-content-available-height) overflow-x-hidden overflow-y-auto",
          // 메뉴 폭은 트리거(인풋)와 같게 둔다. item-aligned로 여는 쪽은 트리거
          // 폭을 알 수 없어 예전 최소폭을 그대로 쓴다.
          position === "popper" ? "w-(--radix-select-trigger-width)" : "min-w-36",
          MENU_SURFACE_CLASS, className )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className="data-[position=popper]:w-full"
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  description,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  description?: React.ReactNode
}) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_[data-slot=select-item-text]]:flex [&_[data-slot=select-item-text]]:items-center [&_[data-slot=select-item-text]]:gap-2",
        MENU_ITEM_CLASS,
        MENU_ITEM_HOVER_CLASS,
        MENU_ITEM_CHECKABLE_CLASS,
        className
      )}
      {...props}
    >
      <span className={MENU_ITEM_INDICATOR_CLASS}>
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {description ? (
        <span className="min-w-0 flex-1">
          <SelectPrimitive.ItemText data-slot="select-item-text">{children}</SelectPrimitive.ItemText>
          <span className="mt-1 block text-meta whitespace-normal text-muted-foreground">{description}</span>
        </span>
      ) : <SelectPrimitive.ItemText data-slot="select-item-text">{children}</SelectPrimitive.ItemText>}
    </SelectPrimitive.Item>
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon
      />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon
      />
    </SelectPrimitive.ScrollDownButton>
  )
}

export { Select, SelectButton, SelectContent, SelectItem, SelectTrigger, SelectValue };

import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // 8px (--radius-md), not 10: a button sits inside surfaces that are
  // themselves 10px (a dialog, a menu), and a control as round as the panel
  // holding it makes the two corners fight (owner report 2026-09-08, the
  // settings panel). It also settles the component against itself — `xs` and
  // `sm` already rounded to --radius-md while `default` and `lg` did not — and
  // matches Figma 17375:198691, where every control in the dialog is
  // `rounded-md` inside a `rounded-lg` container.
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // Button/Glass — Figma 2629:80448. `default`(채운 primary)와 갈라 두는
        // 이유는 놓이는 자리다: 이 버튼은 사이드바 카드 안에서 바로 위 입력
        // (glass/chrome로 파인 면)과 짝을 이룬다. 파인 면 옆에 뜬 면이 있어야
        // 둘의 관계가 읽히는데, primary는 색으로 튈 뿐 높이가 없다.
        // 면·그림자·안쪽 링은 전부 --glass-shadow-tray 한 토큰이 들고 있다.
        glass:
          "bg-glass-tray text-foreground shadow-tray hover:[background:linear-gradient(var(--glass-tint-hover),var(--glass-tint-hover)),var(--glass-tray)]",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Every size pins its own line-height. Left to the metric default a
      // 13px label resolves to a 19px line box, and the odd remainder splits
      // 4.5/5.5 above and below the text — a half-pixel asymmetry that renders
      // in the browser, not just in the design tool.
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs leading-4 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-xs leading-[18px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  title,
  disabled,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const button = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      // A `title` becomes the shared tooltip, as on IconButton: the native
      // one is the OS's grey box, the one popover not in the app's glass
      // (owner call 2026-09-15). Empty, not absent, so an ancestor's native
      // title cannot show through. A disabled button keeps the native title:
      // it fires no pointer events, so the tooltip could never open, and a
      // title there is usually the reason it is disabled. An icon-size button
      // has no text to be named by, so its title names it, as on IconButton.
      title={title === undefined ? undefined : disabled ? title : ""}
      aria-label={ariaLabel ?? (size?.startsWith("icon") && title ? title : undefined)}
      disabled={disabled}
      {...props}
    />
  )
  if (!title || disabled) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild ref={setTrigger}>
        {button}
      </TooltipTrigger>
      {/* Buttons also render in secondary-window documents. */}
      <TooltipContent container={trigger?.ownerDocument.body}>{title}</TooltipContent>
    </Tooltip>
  )
}

// Shared geometry for cancellation and confirmation, including inline prompts.
// `size` is the one thing a consumer may change: an inline confirm inside a
// sidebar list takes xs so its pills weigh what the 13px rows around them do,
// and at xs the dialog-scale minimum width comes off with the size (owner call
// 2026-09-14). Variant and the rest of the geometry stay shared.
function ConfirmationButton({
  variant = "default",
  size = "lg",
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant" | "className"> & {
  variant?: "default" | "glass" | "destructive"
  size?: "lg" | "xs"
  className?: string
}) {
  return (
    <Button
      {...props}
      variant={variant}
      size={size}
      className={cn(size === "lg" && "min-w-20 px-4", className)}
    />
  )
}

export { Button, ConfirmationButton };

import type * as React from "react"

import { cn } from "@/lib/utils"

// Inputs and textareas share their surface, corners and horizontal text inset.
const TEXT_FIELD_BASE_CLASSES =
  "w-full min-w-0 rounded-md border border-input bg-background/70 px-3 transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        TEXT_FIELD_BASE_CLASSES,
        "h-8 py-1 text-xs file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

export { Input, TEXT_FIELD_BASE_CLASSES }

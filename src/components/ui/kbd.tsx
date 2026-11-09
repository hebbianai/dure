import type * as React from "react";

import { cn } from "@/lib/utils";

// Size → classes, kept verbatim from the two inline <kbd> donors this
// primitive folds:
// - md: settings/ShortcutsPage KeyCap — a real keycap block (fixed height,
//   square minimum, chrome surface).
// - sm: search/NativeSearchDialog shortcut hint — a flat inline hint beside
//   an input, muted and one step smaller.
const SIZE_CLASSES = {
  md: "flex h-6 min-w-6 items-center justify-center rounded-md border border-input bg-glass-chrome px-1.5 font-mono text-[11px] text-foreground",
  sm: "rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
} as const;

/** One keyboard-key label. Purely presentational — callers own the meaning
 * (which shortcut, which modifier glyphs) and pass it as children. Per-site
 * tweaks go through `className`; tailwind-merge lets them win. */
export function Kbd({
  children,
  size = "md",
  className,
}: {
  children: React.ReactNode;
  size?: "md" | "sm";
  className?: string;
}) {
  return <kbd className={cn(SIZE_CLASSES[size], className)}>{children}</kbd>;
}

/** A command's key-cap sequences, as a shortcut catalog spells them. A "…"
 * entry is the range separator of ⌘1…⌘9, so it reads as text, not a key. */
export function ShortcutKeys({
  keys,
  size = "md",
}: {
  keys: readonly (readonly string[])[];
  size?: "md" | "sm";
}) {
  return (
    <>
      {keys.map((sequence, sequenceIndex) => (
        <span key={sequenceIndex} className="flex items-center gap-1">
          {sequence.map((label, labelIndex) =>
            label === "…" ? (
              <span key={labelIndex} className="px-0.5 text-xs text-muted-foreground">
                …
              </span>
            ) : (
              <Kbd key={labelIndex} size={size}>
                {label}
              </Kbd>
            ),
          )}
        </span>
      ))}
    </>
  );
}

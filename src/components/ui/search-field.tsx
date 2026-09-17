import { Search, X } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { IconButton } from "@/components/ui/icon-button";
import type * as React from "react";
import { t } from "@/lib/i18n";
import { SEARCH_FIELD_SURFACE, SEARCH_FIELD_TEXT } from "@/lib/ui/searchField";
import { cn } from "@/lib/utils";

/** The sidebar/settings search input skeleton: a relative flex wrapper, a
 * leading 12px icon pinned 12px from the left, and an input on the shared
 * search surface (`SEARCH_FIELD_TEXT` + `SEARCH_FIELD_SURFACE` from
 * `@/lib/ui/searchField` — single source, same constants the panes import).
 *
 * Geometry stays with the caller: height and wrapper drift go through
 * `className`, input drift (height, corner radius overrides) through
 * `inputClassName`. Every other input prop — `role`, `aria-activedescendant`,
 * key handlers — flows through untouched so combobox wiring keeps working.
 *
 * The trailing slot mirrors the file-tree search: while `loading`, a spinning
 * LoaderCircle; otherwise, when `onClear` is given and the controlled `value`
 * is non-empty, a clear X button. A caller-supplied `trailing` node replaces
 * that default entirely. Declaring any of the three reserves the wider
 * `pr-8` inset so text never jumps when the affordance appears. */
export function SearchField({
  icon = (
    <Search className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-muted-foreground" />
  ),
  loading,
  onClear,
  trailing,
  className,
  inputClassName,
  ...inputProps
}: React.ComponentProps<"input"> & {
  icon?: React.ReactNode;
  loading?: boolean;
  onClear?: () => void;
  trailing?: React.ReactNode;
  inputClassName?: string;
}) {
  const reservesTrailing =
    trailing !== undefined || loading !== undefined || onClear !== undefined;
  const showClear = onClear !== undefined && Boolean(inputProps.value);
  return (
    <div className={cn("relative flex items-center", className)}>
      {icon}
      <input
        className={cn(
          "w-full appearance-none rounded-md border pl-7",
          reservesTrailing ? "pr-8" : "pr-3",
          SEARCH_FIELD_TEXT,
          SEARCH_FIELD_SURFACE,
          inputClassName,
        )}
        {...inputProps}
      />
      {trailing !== undefined ? (
        trailing
      ) : loading ? (
        <DureLoader
				decorative
				className="pointer-events-none absolute right-2 text-muted-foreground"
			/>
      ) : showClear ? (
        <IconButton
          className="absolute right-1"
          title={t("common.clearSearch")}
          onClick={onClear}
        >
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

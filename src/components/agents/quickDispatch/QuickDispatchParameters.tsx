import { type ComponentProps, type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { Titled } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function ParamChip({
  label,
  value,
  icon,
  className,
  ...props
}: ComponentProps<"button"> & {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  return (
    <Titled title={`${label}: ${value}`}>
      <button
        type="button"
        className={cn(
          "group flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-glass-tint-hover data-[state=open]:bg-glass-tint-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          icon && "bg-muted/50",
          className,
        )}
        {...props}
      >
        {icon && <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
        <span className={icon ? "sr-only" : "shrink-0 text-meta font-medium text-muted-foreground"}>{label}</span>
        <span className="truncate text-sm text-foreground">{value}</span>
      </button>
    </Titled>
  );
}

/** The name is free text; opening its editor leaves the committed launch
 * name unchanged until blur or Enter. Escape discards the draft. */
export function NameParamChip({ label, value, placeholder, commit }: {
  label: string;
  value: string;
  placeholder: string;
  commit: (draft: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return <ParamChip label={label} value={value || placeholder} onClick={() => {
      setDraft(value);
      setEditing(true);
    }} />;
  }
  const finish = () => {
    commit(draft);
    setEditing(false);
  };
  return (
    <label className="flex h-8 min-w-0 max-w-full items-center gap-1.5 px-2">
      <span className="shrink-0 text-meta font-medium text-muted-foreground">{label}</span>
      <Input
        autoFocus
        value={draft}
        placeholder={placeholder}
        className="h-6 w-28 min-w-0 rounded-sm px-1.5 text-sm shadow-none focus-visible:ring-1"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish();
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    </label>
  );
}

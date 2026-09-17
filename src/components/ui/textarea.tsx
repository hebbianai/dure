import type * as React from "react";

import { TEXT_FIELD_BASE_CLASSES } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        TEXT_FIELD_BASE_CLASSES,
        "min-h-16 resize-y py-1.5 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };

import type { ComponentProps } from "react";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/** Conversation notices follow the user's chat typography, like the
 * transcript. A strip keeps its own insets; it heads the composer's box. */
export function ChatAlert({
	className,
	surface,
	...props
}: ComponentProps<typeof Alert>) {
	return (
		<Alert
			surface={surface}
			className={cn(
				"gap-2 text-[0.92em] [&_[data-slot=alert-description]]:leading-relaxed [&_[data-slot=alert-glyph]>svg]:size-[1.15em]",
				surface !== "strip" && "px-3 py-2",
				className,
			)}
			{...props}
		/>
	);
}

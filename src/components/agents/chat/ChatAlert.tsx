import type { ComponentProps } from "react";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/** Conversation notices follow the user's chat typography, like the transcript. */
export function ChatAlert({
	className,
	...props
}: ComponentProps<typeof Alert>) {
	return (
		<Alert
			className={cn(
				"gap-2 px-3 py-2 text-[0.92em] [&_[data-slot=alert-description]]:leading-relaxed [&_[data-slot=alert-glyph]>svg]:size-[1.15em]",
				className,
			)}
			{...props}
		/>
	);
}

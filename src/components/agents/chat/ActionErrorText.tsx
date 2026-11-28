import type { ActionErrorPresentation } from "@/lib/agents/chat/actionErrorPresentation";
import { cn } from "@/lib/utils";

/** An action's error as words, with the raw backend token kept as quiet
 * diagnostic detail when there is one (`presentActionError`,
 * `presentBackendRefusal`). */
export function ActionErrorText({
	presentation: { message, detail },
	className,
}: {
	presentation: ActionErrorPresentation;
	className?: string;
}) {
	return (
		<span className={cn("min-w-0 flex-1", className)}>
			{message}
			{detail && (
				<code className="ml-1.5 text-[0.85em] opacity-70">{detail}</code>
			)}
		</span>
	);
}

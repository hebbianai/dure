import { BellOff } from "lucide-react";
import { t } from "@/lib/i18n";

/** The info line's sign that the person muted this agent's notifications,
 *  so a quiet agent reads as muted rather than as idle. */
export function AgentNotificationsMutedMarker() {
	const label = t("agents.notifications.muted");
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className="flex shrink-0 items-center text-muted-foreground"
		>
			<BellOff className="size-3" aria-hidden />
		</span>
	);
}

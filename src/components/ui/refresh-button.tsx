import { RefreshCw } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import type * as React from "react";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";

/** Refresh action with the busy convention baked in: while `busy` the icon
 * spins. Whether refresh stays clickable during the run is still the call
 * site's policy — pass `disabled` alongside `busy` to refuse re-entry, omit
 * it for fire-and-forget refreshes that tolerate one. The accessible name
 * defaults to t("common.refresh"); override `title` when the action needs a sharper
 * one (e.g. discarding a draft). */
export function RefreshButton({
	busy = false,
	title,
	iconClassName,
	...rest
}: {
	/** True while the refresh runs — spins the icon. */
	busy?: boolean;
	/** Accessible name override; defaults to the shared refresh label. */
	title?: string;
	/** Extra classes for the icon slot (size overrides etc.). */
	iconClassName?: string;
} & Omit<
	React.ComponentProps<typeof IconButton>,
	"title" | "children" | "pressed"
>) {
	return (
		<IconButton title={title ?? t("common.refresh")} {...rest}>
			{busy ? (
				<DureLoader decorative className={iconClassName} />
			) : (
				<RefreshCw className={iconClassName} />
			)}
		</IconButton>
	);
}

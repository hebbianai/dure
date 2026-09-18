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
 * one (e.g. discarding a draft). The plain label gets no tooltip — it only
 * repeats the glyph (owner call 2026-09-18) — while a sharper one keeps it;
 * `showTooltip` still overrides either way. */
export function RefreshButton({
	busy = false,
	title,
	iconClassName,
	showTooltip,
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
	const plain = t("common.refresh");
	const label = title ?? plain;
	return (
		<IconButton
			title={label}
			showTooltip={showTooltip ?? label !== plain}
			{...rest}
		>
			{busy ? (
				<DureLoader decorative className={iconClassName} />
			) : (
				<RefreshCw className={iconClassName} />
			)}
		</IconButton>
	);
}

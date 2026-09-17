import type { CSSProperties } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { DURE_LOADER_DOT_COUNT, dureLoaderGeometry } from "@/lib/ui/dureLoader";

const DOT_INDEXES = Array.from({ length: DURE_LOADER_DOT_COUNT }, (_, i) => i);

/** Inline progress mark in the current text colour.
 *
 * Standing alone it announces itself as a status (`label`, or the shared
 * "Loading…"). Inside a control or a row that already says what is happening
 * — a busy button, a row with `aria-busy`, a `role="status"` line — pass
 * `decorative` so assistive tech hears the sentence once, not the mark too. */
export function DureLoader({
	size = 12,
	label,
	decorative = false,
	className,
}: {
	size?: number;
	label?: string;
	/** Hidden from assistive tech; the surrounding text carries the meaning. */
	decorative?: boolean;
	className?: string;
}) {
	const geometry = dureLoaderGeometry(size);
	const style = {
		"--dl-size": `${geometry.size}px`,
		"--dl-r": `${geometry.radius}px`,
		"--dl-d": `${geometry.dot}px`,
	} as CSSProperties;
	const accessibility = decorative
		? { "aria-hidden": true as const }
		: { role: "status", "aria-label": label ?? t("common.loading") };
	return (
		<span
			{...accessibility}
			className={cn("dure-loader", className)}
			style={style}
		>
			{DOT_INDEXES.map((index) => (
				<i key={index}>
					<span />
				</i>
			))}
		</span>
	);
}

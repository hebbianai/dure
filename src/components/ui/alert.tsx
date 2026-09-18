import type { ComponentProps, ReactNode } from "react";
import { CircleAlert, TriangleAlert, X } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { MENU_GLASS_FILL_CLASS } from "@/lib/ui/menuSurface";
import { cn } from "@/lib/utils";

/* Alert — Design-system-dure 17096:4415 (shadcn Alert). A bordered card with
 * a 14px glyph over the first text line, a medium title and a regular
 * description in the tone's colour, 16×12 padding on a 10px radius, 12px
 * between glyph and copy, 4px between title and description.
 *
 * The card is opaque on purpose — base/card on base/border, the comp's own
 * tokens rather than the sidebar's translucent glass/tray. The tone lives in
 * the copy, as shadcn draws it, and coloured copy over a translucent card
 * measured 3.2:1 in dark and fell further with light content behind (owner
 * report 2026-09-09). Apple's rule for text on a material is that thicker,
 * more opaque materials keep fine text legible (HIG › Materials); an opaque
 * card holds base/destructive at 4.9:1 in light and 6.2:1 in dark whatever
 * sits behind the sidebar. Description line-height is 16px rather than the
 * comp's leading-none: a wrapped sidebar message at 13px on 13px overlaps.
 *
 * `surface="outline"` is the sidebar's form: the same glyph and copy inside
 * a glass/hairline ring with no fill. An opaque card on the glass sidebar
 * read as a black slab in dark, and plain text had nowhere to hold its
 * action; the ring gives the trailing button a home and marks the notice as
 * a different kind from the rows without laying a surface on the glass
 * (owner call 2026-09-09, chosen over the card and the text-only form). It
 * takes the search field's insets, since the two sit one above the other
 * at the top of a pane (owner call 2026-09-09): the band's edge at the
 * pane inset (12px, like the field), a 12px glyph 12px in, copy at 28px —
 * the field's icon and text positions — 12px on the right, and the
 * field's radius. Copy is on the meta tier (11px/15). Inside, the anatomy
 * is the text form's: the glyph on the first line, copy beside it, the
 * xs action centred on the trailing edge (a glyph centred on a wrapped
 * message floated mid-band).
 * Contrast on the glass is the shell tint's job — see
 * --shell-tint-alpha-dark; the ring adds no fill to help it. The card
 * stays for panes and pages, where the comp's opaque surface and 13px
 * belong.
 *
 * `surface="toast"` is the outline band's anatomy on the menu's material:
 * the glass/menu tint with its 15px blur (MENU_GLASS_FILL_CLASS), the menu
 * hairline, the menu shadow, the 8px radius. It is every notice that floats
 * over content — the brief toast at the window's bottom edge, a failure
 * pinned to a pane's corner (owner call 2026-09-12: "the sidebar error's
 * form, unified"). It wore the opaque pane fill first, and over a pane that
 * is the same #242424 the only separation left was the hairline and a
 * shadow tuned to be shallow — the owner watched it vanish (2026-09-13).
 * What lifts a panel off a pane is the hairline and the shadow, not
 * brightness (index.css, glass/menu), and a menu already floats over
 * terminal output on exactly this material, so a toast wears it too. It has
 * a fill where the outline band has none because it covers content it is
 * unrelated to. Its neutral tone is the brief toast's plain report ("Copied
 * to clipboard"): foreground copy, no glyph.
 *
 * This is the one notice component. The icon-led ErrorBanner, the page
 * Callout and the dialog chip it replaced each drew the same thing a little
 * differently, and three of them were on screen at once (owner, 2026-09-09).
 * `action` is the comp's trailing button slot; `dismiss` is a trailing close. */

/** The surface every floating one-line notice or band wears (toast Alert,
 * the restart band, the element-picker band): the menu's material and
 * shadow on the md radius. Cards take FLOATING_CARD. */
export const FLOATING_SURFACE = `rounded-md border border-glass-menu-hairline ${MENU_GLASS_FILL_CLASS} shadow-menu`;

/** The floating card (update notice, capture card, draft-move card): the
 * same menu material and shadow as FLOATING_SURFACE, on the pane radius.
 * It was the opaque pane fill under the card shadow (owner call 2026-09-10,
 * on the reading that a card sits over the shell, not a pane); on a wide
 * workspace the window's corner is a pane, and there the card was the same
 * #242424 as what it covered, with only a shallow shadow between them
 * (owner report 2026-09-13). What lifts it is the hairline and the menu
 * shadow, as for the toasts. */
export const FLOATING_CARD = `rounded-[var(--glass-radius-pane)] border border-glass-menu-hairline ${MENU_GLASS_FILL_CLASS} shadow-menu`;

type AlertTone = "destructive" | "warn" | "neutral";

const TONE_CLASSES: Record<AlertTone, string> = {
	destructive: "text-destructive",
	warn: "text-status-warn",
	neutral: "text-foreground",
};

/* The tone's own 1px line, for `surface="dock"` only. A band docked inside a
 * pane wears the pane's fill, so neither the fill nor a shadow can separate
 * it from what it covers — and in light the pane and every floating material
 * we have land within 1.4% of each other (measured 2026-09-13). A coloured
 * line is the one mark a pane's own border can never make, which is why the
 * notices we compared draw their in-pane failures with a red or amber rim
 * (and why shadcn's own destructive Alert wore `border-destructive/50`). No
 * tint: a filled band is not a form this system uses — the sidebar's notice
 * is a ring with no fill (owner call 2026-09-13, on a 20% tint comp). */
const TONE_BORDER: Record<AlertTone, string> = {
	destructive: "border-destructive/50",
	warn: "border-status-warn/50",
	neutral: "border-glass-hairline",
};

const TONE_GLYPH: Record<AlertTone, typeof CircleAlert | undefined> = {
	destructive: CircleAlert,
	warn: TriangleAlert,
	neutral: undefined,
};

function Alert({
	tone = "destructive",
	surface = "card",
	icon = true,
	title,
	action,
	dismiss,
	role,
	className,
	children,
	...props
}: Omit<ComponentProps<"div">, "title"> & {
	tone?: AlertTone;
	/** `card` is the comp; `outline` is the sidebar's hairline band; `toast`
	 * is the band's anatomy on the floating menu material; `dock` is that
	 * anatomy pinned to a pane's edge, on the pane's fill with a tone line. */
	surface?: "card" | "outline" | "toast" | "dock";
	/** The comp's glyph slot; `false` draws none. The neutral tone has none. */
	icon?: boolean;
	/** Title line (13px medium, one line). Omit for a description-only alert. */
	title?: ReactNode;
	/** The comp's trailing button slot. */
	action?: ReactNode;
	/** A trailing close control. */
	dismiss?: { label: string; onClick: () => void };
	/** Description — a sentence, or the caller's own block structure. */
	children?: ReactNode;
}) {
	const Glyph = TONE_GLYPH[tone];
	return (
		<div
			data-slot="alert"
			// A destructive notice announces itself, as the banner it replaced
			// did; a warn notice is polite unless the caller says otherwise.
			role={role ?? (tone === "destructive" ? "alert" : undefined)}
			className={cn(
				"flex items-start",
				surface === "card"
					? "gap-3 rounded-lg border border-border bg-card px-4 py-3 text-xs"
					: // The search field's anatomy (search-field.tsx: icon size-3 at
						// left-3, text at pl-7, pr-3, rounded-md): 12px padding, a 12px
						// glyph, 4px gap → copy at 28px. Callers put the band's edge at
						// the pane inset (12px), where the field sits.
						// No blend-mode "vibrancy": the glass is native, composited by
						// the window server beneath a transparent page, so a CSS
						// mix-blend-mode only ever sees the DOM's own tint layer
						// (checked 2026-09-09).
						surface === "outline"
						? "gap-1 rounded-md border border-glass-hairline px-3 py-2 text-meta"
						: surface === "dock"
							? cn(
									"gap-1 rounded-md border bg-glass-pane px-3 py-2 text-meta shadow-card",
									TONE_BORDER[tone],
								)
							: cn("gap-1 px-3 py-2 text-meta", FLOATING_SURFACE),
				TONE_CLASSES[tone],
				className,
			)}
			{...props}
		>
			{icon && Glyph && (
				<span
					data-slot="alert-glyph"
					className={cn(
						"flex shrink-0",
						surface === "card"
							? "items-start pt-0.5"
							: // 12px glyph on the 15px first line: 2px down centres it.
								"mt-0.5 size-3 items-center justify-center",
					)}
					aria-hidden="true"
				>
					<Glyph className={surface === "card" ? "size-3.5" : "size-3"} />
				</span>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1 break-words">
				{title !== undefined && title !== null && (
					<p data-slot="alert-title" className="truncate font-medium leading-[18px]">
						{title}
					</p>
				)}
				{children !== undefined && children !== null && (
					<div
						data-slot="alert-description"
						className={surface === "card" ? "leading-4" : "leading-[15px]"}
					>
						{children}
					</div>
				)}
			</div>
			{/* -my-1 like the dismiss: a 24px control must not set the row's
			    height, or a one-line message sits 4px above it (owner, 2026-09-13).
			    Centred, so on a wrapped message it still floats mid-band. */}
			{action && <div className="-my-1 shrink-0 self-center">{action}</div>}
			{/* A control, not copy: the tone lives in the glyph and the message
			    (shadcn), and the close is the same neutral IconButton as the
			    action slot's copy button (owner, 2026-09-13 — it was text-current
			    since the 2026-09-09 merge, a leftover of the banner it replaced). */}
			{dismiss && (
				<IconButton
					className="-my-1 -mr-1 shrink-0 self-start"
					title={dismiss.label}
					showTooltip={false}
					onClick={dismiss.onClick}
				>
					<X />
				</IconButton>
			)}
		</div>
	);
}

export { Alert };

import { useId } from "react";
import type { Provider } from "@/types";
import { PROVIDERS } from "@/types";
import { agentLogoUrl } from "@/lib/agents/agentLogos";
import { providerGlyphShape } from "@/lib/agents/providerGlyphs";
import { cn } from "@/lib/utils";

/** Normalize app-icon tiles to grayscale with subtly rounded corners. */
function AgentLogo({ logo, className }: { logo: string; className?: string }) {
	const src = agentLogoUrl(logo);
	if (!src) return null;
	return (
		<img
			src={src}
			alt=""
			aria-hidden
			draggable={false}
			className={cn(
				"size-3.5 shrink-0 rounded-[3px] object-contain grayscale",
				className,
			)}
		/>
	);
}
/** Crescent glyph for providers without a logo file. */
function KimiLogo({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 12 12" fill="none" className={className} aria-hidden>
			<path
				d="M9.8 7.3A4.3 4.3 0 1 1 4.7 2.2a3.4 3.4 0 0 0 5.1 5.1Z"
				stroke="currentColor"
				strokeWidth="1.1"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** Provider glyph for tabs and menus. Keep inline SVGs and image logos in the
 *  same grayscale palette. Muted by default; callers can inherit a title tone. */
export function ProviderGlyph({
	provider,
	className,
}: {
	provider: Provider;
	className?: string;
}) {
	const shape = providerGlyphShape(provider);
	if (shape) {
		return (
			<svg
				viewBox={shape.viewBox}
				fill="currentColor"
				fillRule="evenodd"
				className={cn(
					provider === "codex" ? "size-[13px]" : "size-3",
					"shrink-0 text-muted-foreground",
					className,
				)}
				aria-hidden
			>
				{shape.paths.map((path) => (
					<path key={path} d={path} />
				))}
			</svg>
		);
	}
	const logo = PROVIDERS[provider]?.logo;
	if (logo)
		return <AgentLogo logo={logo} className={cn("size-3.5", className)} />;
	// Providers without a logo use the built-in crescent glyph.
	return (
		<KimiLogo
			className={cn("size-3 shrink-0 text-muted-foreground", className)}
		/>
	);
}

/** Neutral 22px badge for sidebar agent rows; the logo shape identifies the
 *  provider, so its surrounding border and fill stay neutral too. */
export function ProviderBadge({
	provider,
	className,
}: {
	provider: Provider;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"flex size-[22px] shrink-0 items-center justify-center rounded-md border",
				"border-border bg-foreground/5 text-muted-foreground",
				className,
			)}
		>
			<ProviderGlyph provider={provider} />
		</span>
	);
}

/** The terminal's mark where it stands in a line of provider logos (rows,
 *  the repository rail, the launcher, the add menus). lucide's outline
 *  square-terminal at 12–14px carried a ~1.2px stroke and read a size smaller
 *  than the solid Claude and Codex marks beside it (owner report 2026-09-10).
 *  This is that same icon filled, so its mass matches theirs; the ink stays
 *  muted like the other glyphs. Menus that list it among lucide outline icons
 *  keep lucide's `SquareTerminal`. */
export function TerminalGlyph({ className }: { className?: string }) {
	// One mask per instance — several glyphs sit on one screen.
	const id = `terminal-glyph-${useId().replace(/:/g, "")}`;
	// lucide square-terminal's own geometry (24 grid: the 18px window at 3,3
	// rx 2, the chevron `m7 11 2-2-2-2`, the underline `M11 13h4`, 2px strokes)
	// — the window filled and the prompt cut out of it, so it is the same icon
	// the menus draw in outline, one step heavier (owner call 2026-09-10: base
	// the filled form on our icon, do not draw a new one). The viewBox crops to
	// 2..22 so the 18px window fills 90% of the box: on the 24 grid it filled
	// 75% and read a size smaller than the Claude (12px) and Codex (13px) marks
	// beside it (owner report, image 55).
	return (
		<svg
			viewBox="2 2 20 20"
			fill="none"
			className={cn("terminal-glyph size-3.5 shrink-0", className)}
			aria-hidden
		>
			<mask
				id={id}
				maskUnits="userSpaceOnUse"
				x="0"
				y="0"
				width="24"
				height="24"
			>
				<rect width="24" height="24" fill="var(--mask-luminance-reveal)" />
				<path
					d="m7 11 2-2-2-2M11 13h4"
					stroke="var(--mask-luminance-conceal)"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</mask>
			<rect
				x="3"
				y="3"
				width="18"
				height="18"
				rx="2"
				fill="currentColor"
				mask={`url(#${id})`}
			/>
		</svg>
	);
}

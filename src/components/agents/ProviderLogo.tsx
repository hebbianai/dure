import { useId } from "react";
import type { Provider } from "@/types";
import { PROVIDERS } from "@/types";
import { agentLogoUrl } from "@/lib/agents/agentLogos";
import { providerGlyphShape } from "@/lib/agents/providerGlyphs";
import { cn } from "@/lib/utils";

/** 브랜드 로고 타일 — 원본이 제각각 색이 있는 사각 앱아이콘이라, UI 톤에 맞춰
 *  회색으로 빼고 모서리를 살짝 둥글린다. */
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
/** 로고 파일이 없는 프로바이더용 폴백 글리프 (초승달). */
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

/** 프로바이더 로고 글리프 (탭·메뉴용) — 전부 회색조다.
 *
 *  왜 브랜드 색을 쓰지 않나: 매니페스트의 27개 프로바이더 중 로고 파일이 있는
 *  25개는 원본이 제각각 색인 앱아이콘이라 이미 grayscale 필터로 빼고 있었다.
 *  claude/codex만 인라인 SVG라 브랜드 틴트를 그대로 칠하고 있었고, 그래서 한
 *  줄에 나란히 서면 둘만 튀었다. 시안 2496:59514의 글리프 잉크는
 *  rgb(163,163,163)으로 보조 텍스트와 같은 값이다 — 그게 muted-foreground다.
 *
 *  Muted by default; a caller can use text-inherit to match its title tone. */
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
	// 로고 파일이 없는 프로바이더 — 내장 초승달 글리프로 폴백.
	return (
		<KimiLogo
			className={cn("size-3 shrink-0 text-muted-foreground", className)}
		/>
	);
}

/** 22px 로고 배지 (사이드바 에이전트 행) — 글리프가 회색조라 상자도 중립색이다.
 *  프로바이더별 분기가 없다: 상자 색이 프로바이더를 구분하던 유일한 이유가
 *  브랜드 틴트였고, 그 구분은 이제 로고 모양이 한다. */
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
				<rect width="24" height="24" fill="#fff" />
				<path
					d="m7 11 2-2-2-2M11 13h4"
					stroke="#000"
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

import { Popover } from "radix-ui";
import { type ReactNode, useId } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { MENU_GLASS_FILL_CLASS, MENU_SIDE_OFFSET } from "@/lib/ui/menuSurface";
import { compactUsageIndicator } from "@/lib/usage/usageMeter";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

function UsageMeter({
	provider,
	pct,
}: {
	provider: Provider;
	pct: number | null;
}) {
	const indicator = compactUsageIndicator(pct);
	const ringColor =
		indicator.level === "danger"
			? "var(--status-blocked)"
			: indicator.level === "warning"
				? "var(--status-warn)"
				: "var(--muted-foreground)";
	return (
		<span
			data-slot="usage-provider-meter"
			className="flex items-center gap-1"
		>
			<span
				data-slot="usage-meter-ring"
				data-level={indicator.level}
				data-pct={indicator.pct ?? undefined}
				className="relative grid size-[22px] shrink-0 place-items-center"
			>
				<svg
					viewBox="0 0 24 24"
					className="absolute inset-0 size-full -rotate-90"
					aria-hidden="true"
				>
					<circle
						data-slot="usage-meter-ring-track"
						cx="12"
						cy="12"
						r="10"
						fill="none"
						strokeWidth="2"
						strokeDasharray={indicator.pct == null ? "2 3" : undefined}
						className="stroke-muted-foreground/30"
					/>
					{indicator.pct != null && (
						<circle
							data-slot="usage-meter-ring-value"
							cx="12"
							cy="12"
							r="10"
							pathLength="100"
							fill="none"
							stroke={ringColor}
							strokeWidth="2"
							strokeLinecap="round"
							strokeDasharray="100"
							strokeDashoffset={100 - indicator.pct}
							className="transition-[stroke-dashoffset,stroke]"
						/>
					)}
				</svg>
				<ProviderGlyph provider={provider} className="relative size-3" />
			</span>
			{indicator.showLabel && indicator.pct != null && (
				<span
					data-slot="usage-meter-label"
					className={cn(
						"font-mono text-[11px] leading-none tabular-nums",
						indicator.level === "danger"
							? "text-status-blocked"
							: "text-status-warn",
					)}
				>
					{Math.round(indicator.pct)}%
				</span>
			)}
		</span>
	);
}

export function UsageMeterPopover({
	provider,
	pct,
	tip,
	children,
	dataSlot = "usage-provider-popover",
}: {
	provider: Provider;
	pct: number | null;
	tip: string;
	children: ReactNode;
	dataSlot?: string;
}) {
	const descriptionId = useId();
	const label = t("usage.meter.viewDetails", {
		provider: PROVIDERS[provider].label,
	});
	return (
		<Popover.Root>
			<Titled title={tip}>
				<Popover.Trigger asChild>
					<button
						type="button"
						className="inline-flex h-6 items-center rounded-md px-0.5 outline-none transition-colors hover:bg-glass-tint-hover focus-visible:ring-1 focus-visible:ring-ring"
						aria-label={label}
						aria-describedby={descriptionId}
					>
						<UsageMeter provider={provider} pct={pct} />
						<span id={descriptionId} className="sr-only">
							{tip}
						</span>
					</button>
				</Popover.Trigger>
			</Titled>
			<Popover.Portal>
				<Popover.Content
					data-slot={dataSlot}
					aria-label={label}
					side="top"
					align="end"
					sideOffset={MENU_SIDE_OFFSET}
					collisionPadding={8}
					// 메뉴와 같은 유리 재질이다. 이 팝오버는 메뉴와 같은 층에 같은
					// 방식으로 떠오르므로(트리거 옆, MENU_SIDE_OFFSET, shadow-menu)
					// 불투명 pane 면이면 그 층에서 혼자 다른 재질로 읽혔다.
					// 치수는 팝오버 것을 그대로 둔다 — 라운드·2단 여백·고정 폭.
					className={cn(
						MENU_GLASS_FILL_CLASS,
						"z-50 w-usage-popover-width max-w-[calc(100vw-16px)] origin-(--radix-popover-content-transform-origin) rounded-usage-popover p-2 text-foreground shadow-menu inset-ring-1 inset-ring-glass-menu-hairline outline-none duration-150 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none motion-reduce:transform-none motion-reduce:duration-0",
					)}
				>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

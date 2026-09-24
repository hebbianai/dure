import { ExternalLink, Plus } from "lucide-react";
import { Popover } from "radix-ui";
import type { ReactNode } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Titled } from "@/components/ui/tooltip";
import {
	type UsageAccountLimit,
	UsageAccountMenu,
	type UsagePopoverAccount,
} from "@/components/usage/UsageAccountMenu";
import { useLoginIdentity } from "@/lib/agents/loginIdentity";
import { t } from "@/lib/i18n";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import type { Provider } from "@/types";

export type { UsagePopoverAccount } from "@/components/usage/UsageAccountMenu";

export interface UsagePopoverLimit {
	id: string;
	dataSlot?: string;
	label: string;
	value: string;
	pct: number | null;
	reset?: string | null;
}

export interface UsagePopoverMetric {
	label: string;
	value?: string | null;
	mutedValue?: boolean;
}

interface SecondaryAction {
	label: string;
	detail: ReactNode;
	disabled?: boolean;
	onClick: () => void;
}

export interface UsageRefreshAction {
	busy: boolean;
	disabled: boolean;
	failed: boolean;
	onRefresh: () => void;
}

function Divider() {
	return (
		<div
			className="flex h-usage-popover-divider items-center"
			aria-hidden="true"
		>
			<div className="h-px w-full bg-glass-pane-border" />
		</div>
	);
}

function Row({ label, value, mutedValue }: UsagePopoverMetric) {
	return (
		<div className="flex h-7 items-center justify-between gap-3 px-2 text-xs">
			<span className="min-w-0 truncate text-muted-foreground">{label}</span>
			{value && (
				<span
					className={cn(
						"shrink-0 tabular-nums",
						mutedValue ? "font-normal text-muted-foreground" : "font-mono",
					)}
				>
					{value}
				</span>
			)}
		</div>
	);
}

function Action({ label, detail, disabled, onClick }: SecondaryAction) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="flex h-7 w-full items-center justify-between rounded-sm px-2 text-xs font-medium outline-none hover:bg-glass-menu-hover focus-visible:bg-glass-menu-hover focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
		>
			{label}
			{detail}
		</button>
	);
}

function Limit({ limit }: { limit: UsagePopoverLimit }) {
	return (
		<div
			data-slot={limit.dataSlot ?? "usage-popover-limit"}
			className="h-usage-popover-limit"
		>
			<div className="grid h-7 grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-2 px-2 text-meta">
				<span className="min-w-0 truncate">{limit.label}</span>
				<span className="truncate text-muted-foreground">{limit.reset}</span>
				<span className="text-right font-mono tabular-nums">{limit.value}</span>
			</div>
			<div className="h-usage-popover-track px-2">
				<div className="h-0.75 w-full overflow-hidden rounded-full bg-border">
					{limit.pct != null && (
						<div
							data-slot="usage-popover-limit-value"
							className="h-full rounded-full bg-foreground transition-[width]"
							style={{
								width: `${Math.min(100, Math.max(0, limit.pct))}%`,
							}}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

export function ProviderUsagePopoverContent({
	provider,
	title,
	limits,
	metrics,
	notices,
	accountLimit,
	secondaryAction,
	refresh,
	onAddAccount,
}: {
	provider: Provider;
	title: string;
	limits: readonly UsagePopoverLimit[];
	metrics: readonly UsagePopoverMetric[];
	notices: readonly string[];
	accountLimit?: (profile: UsagePopoverAccount) => UsageAccountLimit | null;
	secondaryAction?: SecondaryAction;
	refresh?: UsageRefreshAction;
	onAddAccount: () => void;
}) {
	const accounts = useStore((state) => state.accounts);
	const activeId = useStore((state) => state.activeAccounts[provider]);
	const active = accounts.find(
		(account) => account.provider === provider && account.id === activeId,
	);
	const identity = useLoginIdentity(provider, active?.dir);
	return (
		<div data-slot="provider-usage-popover-content" data-provider={provider}>
			<div
				data-slot="provider-usage-popover-header"
				className="flex min-h-usage-popover-header flex-col gap-0.5 pb-1"
			>
				<div className="flex min-h-6 min-w-0 items-center gap-2 px-2">
					<ProviderGlyph
						provider={provider}
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate text-xs font-medium">
						{title}
					</span>
					{identity?.plan && (
						<Titled title={identity.plan}>
							<span className="max-w-[40%] truncate text-meta text-muted-foreground">
								{identity.plan}
							</span>
						</Titled>
					)}
					{refresh && (
						<RefreshButton
							busy={refresh.busy}
							aria-busy={refresh.busy}
							disabled={refresh.disabled}
							onClick={refresh.onRefresh}
							className="shrink-0"
						/>
					)}
				</div>
				<UsageAccountMenu
					provider={provider}
					title={title}
					activeLabel={identity?.email ?? active?.name ?? t("common.default")}
					accountLimit={accountLimit}
				/>
			</div>
			{refresh?.failed && (
				<p role="alert" className="px-2 py-1 text-xs text-destructive">
					{t("usage.source.refreshFailedKeepLast")}
				</p>
			)}
			<Divider />
			{limits.map((limit) => (
				<Limit key={limit.id} limit={limit} />
			))}
			{limits.length > 0 && <Divider />}
			{metrics.map((metric) => (
				<Row key={metric.label} {...metric} />
			))}
			<Divider />
			<div
				className={cn(
					"flex flex-col justify-center gap-1 break-keep px-2 py-2 text-xs leading-[18px] text-muted-foreground",
					limits.length > 0
						? "min-h-usage-popover-notice-collected"
						: "min-h-usage-popover-notice-empty",
				)}
			>
				{notices.map((notice) => (
					<p key={notice}>{notice}</p>
				))}
			</div>
			<Divider />
			<Popover.Close asChild>
				<Action
					label={t("settings.accounts.add")}
					detail={
						<Plus aria-hidden="true" className="size-3 text-muted-foreground" />
					}
					onClick={onAddAccount}
				/>
			</Popover.Close>
			<Popover.Close asChild>
				<Action
					label={t("usage.action.statsUsage")}
					detail={<ExternalLink className="size-3 text-muted-foreground" />}
					onClick={() => openSettingsPage("usage")}
				/>
			</Popover.Close>
			{secondaryAction && <Action {...secondaryAction} />}
		</div>
	);
}

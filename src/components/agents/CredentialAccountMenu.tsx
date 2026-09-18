import { Check, Clock3, Plus } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { LoadingRow } from "@/components/common/StatusBlocks";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMenuLabel } from "@/components/usage/AccountMenuLabel";
import { useAccountUsageReport } from "@/components/usage/useAccountUsageReport";
import { t } from "@/lib/i18n";
import { providerAccountMeter } from "@/lib/usage/accountUsageMeter";
import { usageDurationLabel, usageResetLabel } from "@/lib/usage/usageLabels";
import { PROVIDERS, type Provider } from "@/types";

export interface CredentialAccountChoice {
	id: string;
	name: string;
	dir?: string;
}

/** One account menu for pane and shared conversations. Runtime changes remain
 * with the caller; usage comes from the existing local collector only. */
export function CredentialAccountMenu({
	open,
	onOpenChange,
	trigger,
	provider,
	accounts,
	currentAccountId,
	pendingAccountId,
	followsGlobal = false,
	hostName,
	localUsage = !hostName,
	disabled,
	disabledTitle,
	loading = false,
	header,
	children,
	onSwitch,
	onManageAccounts,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	trigger: ReactElement;
	provider: Provider;
	accounts: readonly CredentialAccountChoice[];
	currentAccountId: string | null;
	pendingAccountId?: string | null;
	followsGlobal?: boolean;
	hostName?: string;
	localUsage?: boolean;
	disabled: boolean;
	disabledTitle?: string;
	loading?: boolean;
	header?: ReactNode;
	children?: ReactNode;
	onSwitch(id: string | null): void;
	onManageAccounts?: () => void;
}) {
	const usage = useAccountUsageReport(provider, open && localUsage);
	const limit = (account?: CredentialAccountChoice) => {
		const meter = usage
			? providerAccountMeter(
					provider,
					usage,
					account?.id,
					account?.dir,
					Date.now() / 1000,
				)
			: null;
		return meter
			? {
					pct: meter.pct,
					reset: usageResetLabel(usageDurationLabel(meter.resetLabel)),
				}
			: null;
	};
	const choices = [
		{ id: null, name: t("agents.account.defaultCli") },
		...accounts,
	];
	return (
		<DropdownMenu open={open} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-64 max-w-(--radix-dropdown-menu-content-available-width)"
			>
				{header}
				<DropdownMenuLabel className="text-[10px] text-muted-foreground">
					{PROVIDERS[provider].label}
					{hostName ? ` · ${hostName}` : ""}
				</DropdownMenuLabel>
				{loading && (
					<DropdownMenuLabel>
						<LoadingRow />
					</DropdownMenuLabel>
				)}
				{choices.map((account) => (
					<DropdownMenuItem
						key={account.id ?? "default"}
						disabled={disabled || loading}
						title={disabledTitle}
						onSelect={() => onSwitch(account.id)}
					>
						<span className="w-3 shrink-0">
							{pendingAccountId === account.id ? (
								<Clock3 className="text-status-warn" />
							) : (
								currentAccountId === account.id && (
									<Check className="text-status-run" />
								)
							)}
						</span>
						<AccountMenuLabel
							label={account.name}
							limit={limit(account.id === null ? undefined : account)}
						/>
						{followsGlobal && currentAccountId === account.id && (
							<span className="shrink-0 text-[10px] text-muted-foreground">
								{t("agents.account.global")}
							</span>
						)}
					</DropdownMenuItem>
				))}
				{children}
				{onManageAccounts && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={onManageAccounts}>
							<Plus />
							<span className="text-xs">{t("agents.account.add")}</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

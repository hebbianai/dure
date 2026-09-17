import {
	Check,
	Clock3,
	KeyRound,
	LogIn,
	Plus,
	Upload,
	X,
	Zap,
} from "lucide-react";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DureLoader } from "@/components/ui/dure-loader";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import { AccountMenuLabel } from "@/components/usage/AccountMenuLabel";
import { useAccountUsageReport } from "@/components/usage/useAccountUsageReport";
import { t } from "@/lib/i18n";
import { useManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { providerAccountMeter } from "@/lib/usage/accountUsageMeter";
import { usageDurationLabel, usageResetLabel } from "@/lib/usage/usageLabels";
import { cn } from "@/lib/utils";
import {
	type AccountProfile,
	type DeferredCredentialSwitchIntentV1,
	PROVIDERS,
	type Provider,
} from "@/types";

interface AgentCredentialSwitcherProps {
	agentId?: string;
	provider: Provider;
	accounts: readonly AccountProfile[];
	currentAccount?: AccountProfile;
	/** The account whose failed SSH switch needs explicit Login/Copy actions. */
	recoveryAccount?: AccountProfile;
	followsGlobal: boolean;
	pending?: DeferredCredentialSwitchIntentV1;
	failure?: string;
	hostName?: string;
	accountBusy: boolean;
	/** Disables runtime mutations, not login or account management. */
	disabled: boolean;
	disabledTitle: string;
	/** Treat selecting the effective account as an explicit recovery action. */
	allowCurrentAccountReselect?: boolean;
	onSwitch: (accountId: string | null) => void;
	onApplyNow: () => void;
	onCancel: () => void;
	onRemoteLogin: (account: AccountProfile) => void;
	onCopyToHost: (account: AccountProfile) => void;
	onManageAccounts: () => void;
}

export function AgentCredentialSwitcher({
	agentId,
	provider,
	accounts,
	currentAccount,
	recoveryAccount,
	followsGlobal,
	pending,
	failure,
	hostName,
	accountBusy,
	disabled,
	disabledTitle,
	allowCurrentAccountReselect = false,
	onSwitch,
	onApplyNow,
	onCancel,
	onRemoteLogin,
	onCopyToHost,
	onManageAccounts,
}: AgentCredentialSwitcherProps) {
	const [open, setOpen] = useState(false);
	const usage = useAccountUsageReport(provider, open && !hostName);
	const accountLimit = (account?: AccountProfile) => {
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
	const replacing = useManagedCredentialSwitchTransition(agentId);
	const switching = accountBusy || replacing;
	const mutationDisabled = disabled || switching;
	const pendingAccount = pending?.targetCredentialId
		? accounts.find((account) => account.id === pending.targetCredentialId)
		: undefined;
	const pendingAccountName = pending
		? pending.targetCredentialId === null
			? t("common.default")
			: (pendingAccount?.name ?? pending.targetCredentialId)
		: undefined;
	const selectedAccountId = currentAccount?.id ?? null;
	const remoteActionAccount = recoveryAccount ?? currentAccount;
	const pendingError =
		pending?.lastError === "agent_runtime_source_retained"
			? t("agents.runtime.sourceRetained")
			: pending?.lastError;
	const switchAccount = (accountId: string | null) => {
		if (accountId === selectedAccountId && !allowCurrentAccountReselect) return;
		onSwitch(accountId);
	};
	const statusLabel = switching
		? t("agents.account.switchInProgress")
		: failure || pendingError
			? t("agents.account.switchFailed")
			: pending
				? t("agents.account.switchPending")
				: undefined;
	const title = switching
		? t("agents.account.switchInProgress")
		: failure
			? `${t("agents.account.switchFailed")}: ${failure}`
			: pendingError
				? t("agents.account.scheduleSwitchFailed", { error: pendingError })
				: pending && pendingAccountName
					? t("agents.account.switchAfterTurn", {
							name: pendingAccountName,
						})
					: disabled
						? t("common.paneAccount")
						: disabledTitle;

	return (
		<DropdownMenu onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<ToolbarControl
					label={title}
					aria-busy={switching}
					reveal={3}
					className="max-w-[150px]"
					status={
						statusLabel && (
							<span role="status" aria-live="polite">
								{statusLabel}
							</span>
						)
					}
					data-credential-state={
						switching
							? "switching"
							: failure || pending?.lastError
								? "error"
								: pending
									? "pending"
									: "ready"
					}
					icon={
						switching ? (
							<DureLoader size={14} decorative />
						) : pending ? (
							<Clock3
								className={cn(
									"size-3.5 shrink-0",
									pending.lastError ? "text-destructive" : "text-status-warn",
								)}
							/>
						) : (
							<KeyRound
								className={cn(
									"size-3.5 shrink-0",
									failure && "text-destructive",
								)}
							/>
						)
					}
				>
					<span className="truncate">
						{pending && pendingAccountName
							? pendingAccountName
							: (currentAccount?.name ?? t("common.default"))}
					</span>
				</ToolbarControl>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-64 max-w-(--radix-dropdown-menu-content-available-width)"
			>
				{statusLabel && (
					<DropdownMenuLabel className="whitespace-normal text-xs text-muted-foreground">
						{title}
					</DropdownMenuLabel>
				)}
				<DropdownMenuLabel className="text-[10px] text-muted-foreground">
					{PROVIDERS[provider].label}
					{hostName ? ` · ${hostName}` : ""}
				</DropdownMenuLabel>
				<DropdownMenuItem
					disabled={mutationDisabled}
					title={switching ? title : disabled ? disabledTitle : undefined}
					onSelect={() => switchAccount(null)}
				>
					<span className="w-3 shrink-0">
						{pending?.targetCredentialId === null ? (
							<Clock3 className="text-status-warn" />
						) : (
							!currentAccount && <Check className="text-status-run" />
						)}
					</span>
					<AccountMenuLabel
						label={t("agents.account.defaultCli")}
						limit={accountLimit()}
					/>
					{followsGlobal && !currentAccount && (
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{t("agents.account.global")}
						</span>
					)}
				</DropdownMenuItem>
				{accounts.map((account) => (
					<DropdownMenuItem
						key={account.id}
						disabled={mutationDisabled}
						title={switching ? title : disabled ? disabledTitle : undefined}
						onSelect={() => switchAccount(account.id)}
					>
						<span className="w-3 shrink-0">
							{pending?.targetCredentialId === account.id ? (
								<Clock3 className="text-status-warn" />
							) : (
								currentAccount?.id === account.id && (
									<Check className="text-status-run" />
								)
							)}
						</span>
						<AccountMenuLabel
							label={account.name}
							limit={accountLimit(account)}
						/>
						{followsGlobal && currentAccount?.id === account.id && (
							<span className="shrink-0 text-[10px] text-muted-foreground">
								{t("agents.account.global")}
							</span>
						)}
					</DropdownMenuItem>
				))}
				{pending && (
					<>
						<DropdownMenuSeparator />
						{pending.lastError && (
							<DropdownMenuLabel className="text-[10px] text-destructive">
								{t("agents.account.switchFailedReselect")}
							</DropdownMenuLabel>
						)}
						<DropdownMenuItem disabled={mutationDisabled} onSelect={onApplyNow}>
							<Zap />
							<span className="text-xs">
								{t("agents.account.interruptAndSwitchNow")}
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem disabled={mutationDisabled} onSelect={onCancel}>
							<X />
							<span className="text-xs">
								{t("agents.account.cancelScheduledSwitch")}
							</span>
						</DropdownMenuItem>
					</>
				)}
				{hostName && remoteActionAccount && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={switching}
							onSelect={() => onRemoteLogin(remoteActionAccount)}
						>
							<LogIn />
							<span className="text-xs">{t("agents.account.loginOnHost")}</span>
						</DropdownMenuItem>
						{PROVIDERS[provider].credentialFiles.length > 0 && (
							<DropdownMenuItem
								disabled={mutationDisabled}
								onSelect={() => onCopyToHost(remoteActionAccount)}
							>
								<Upload />
								<span className="text-xs">
									{t("agents.account.copyLocalToHost")}
								</span>
							</DropdownMenuItem>
						)}
					</>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onManageAccounts}>
					<Plus />
					<span className="text-xs">{t("agents.account.add")}</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

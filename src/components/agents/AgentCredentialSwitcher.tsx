import { Clock3, KeyRound, LogIn, Upload, X, Zap } from "lucide-react";
import { useState } from "react";
import { CredentialAccountMenu } from "@/components/agents/CredentialAccountMenu";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DureLoader } from "@/components/ui/dure-loader";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import { t } from "@/lib/i18n";
import { credentialSwitchFailureDescription } from "@/lib/agents/credentialSwitchFailureDescription";
import { useManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
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
	const failureDescription = credentialSwitchFailureDescription(failure);
	const pendingError = credentialSwitchFailureDescription(pending?.lastError);
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
		: failureDescription
			? `${t("agents.account.switchFailed")}: ${failureDescription}`
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
		<CredentialAccountMenu
			open={open}
			onOpenChange={setOpen}
			provider={provider}
			accounts={accounts}
			currentAccountId={selectedAccountId}
			pendingAccountId={pending?.targetCredentialId}
			followsGlobal={followsGlobal}
			hostName={hostName}
			disabled={mutationDisabled}
			disabledTitle={switching ? title : disabled ? disabledTitle : undefined}
			onSwitch={switchAccount}
			onManageAccounts={onManageAccounts}
			header={
				statusLabel && (
					<DropdownMenuLabel className="whitespace-normal text-xs text-muted-foreground">
						{title}
					</DropdownMenuLabel>
				)
			}
			trigger={
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
			}
		>
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
		</CredentialAccountMenu>
	);
}

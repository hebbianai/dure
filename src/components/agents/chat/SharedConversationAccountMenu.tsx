import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { AccountsDialog } from "@/components/agents/AccountsDialog";
import { CredentialAccountMenu } from "@/components/agents/CredentialAccountMenu";
import { useSharedConversationAccountsState } from "@/components/agents/chat/useSharedConversationAccountsState";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { DureLoader } from "@/components/ui/dure-loader";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import {
	type SharedConversationAccount,
	sharedConversationAccounts,
} from "@/lib/agents/chat/sharedConversationAccounts";
import { t } from "@/lib/i18n";
import type { Provider } from "@/types";

export function SharedConversationAccountMenu({
	target,
	provider,
	selectedId,
	currentName,
	busy,
	disabled,
	open,
	onOpenChange,
	onSelect,
}: {
	target: SharedAgentConversationTarget;
	provider: Provider;
	selectedId: string | null;
	currentName: string;
	busy: boolean;
	disabled: boolean;
	open: boolean;
	onOpenChange(open: boolean): void;
	onSelect(id: string | null, name: string): void;
}) {
	const localAccounts = useSharedConversationAccountsState();
	const local = target.authority.target.source === "local";
	const [accounts, setAccounts] = useState<SharedConversationAccount[]>();
	const [loadError, setLoadError] = useState(false);
	const [revision, setRevision] = useState(0);
	const [manageOpen, setManageOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		let current = true;
		setAccounts(undefined);
		setLoadError(false);
		void sharedConversationAccounts(target, provider, localAccounts).then(
			(options) => {
				if (current) setAccounts(options);
			},
			() => {
				if (current) setLoadError(true);
			},
		);
		return () => {
			current = false;
		};
	}, [open, target, provider, localAccounts, revision]);
	const choices = (accounts ?? []).map((account) => ({
		...account,
		dir: local
			? localAccounts.find(
					(candidate) =>
						candidate.id === account.id && candidate.provider === provider,
				)?.dir
			: undefined,
	}));
	return (
		<>
			<CredentialAccountMenu
				open={open}
				onOpenChange={onOpenChange}
				provider={provider}
				accounts={choices}
				currentAccountId={selectedId}
				localUsage={local}
				hostName={local ? undefined : target.authority.profileId}
				disabled={disabled || loadError}
				loading={open && !accounts && !loadError}
				onSwitch={(id) => {
					if (id === selectedId) return;
					onSelect(
						id,
						id === null
							? t("agents.account.defaultCli")
							: choices.find((account) => account.id === id)!.name,
					);
				}}
				onManageAccounts={local ? () => setManageOpen(true) : undefined}
				header={
					loadError && (
						<>
							<DropdownMenuLabel className="whitespace-normal text-xs text-destructive">
								{t("agents.runtime.switchFailed")}
							</DropdownMenuLabel>
							<DropdownMenuItem
								onSelect={(event) => {
									event.preventDefault();
									setRevision((value) => value + 1);
								}}
							>
								{t("common.retry")}
							</DropdownMenuItem>
						</>
					)
				}
				trigger={
					<ToolbarControl
						label={t("common.paneAccount")}
						title={busy ? t("agents.account.switchInProgress") : currentName}
						aria-busy={busy}
						icon={
							busy ? (
								<DureLoader size={14} decorative />
							) : (
								<KeyRound className="size-3.5" />
							)
						}
					/>
				}
			/>
			{manageOpen && <AccountsDialog onClose={() => setManageOpen(false)} />}
		</>
	);
}

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { LoadingRow } from "@/components/common/StatusBlocks";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import {
	sharedConversationAccounts,
	type SharedConversationAccount,
} from "@/lib/agents/chat/sharedConversationAccounts";
import { t } from "@/lib/i18n";
import { useSharedConversationAccountsState } from "@/components/agents/chat/useSharedConversationAccountsState";
import type { Provider } from "@/types";

export function SharedConversationAccountDialog({
	target,
	provider,
	selectedId,
	busy,
	disabled,
	error,
	onSelect,
	onClose,
}: {
	target: SharedAgentConversationTarget;
	provider: Provider;
	selectedId: string | null;
	busy: boolean;
	disabled: boolean;
	error?: string;
	onSelect(id: string | null, name: string): void;
	onClose(): void;
}) {
	const localAccounts = useSharedConversationAccountsState();
	const [accounts, setAccounts] = useState<SharedConversationAccount[]>();
	const [loadError, setLoadError] = useState<string>();
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let current = true;
		setAccounts(undefined);
		setLoadError(undefined);
		void sharedConversationAccounts(target, provider, localAccounts).then(
			(options) => {
				if (current) setAccounts(options);
			},
			() => {
				if (current) setLoadError(t("agents.runtime.switchFailed"));
			},
		);
		return () => {
			current = false;
		};
	}, [target, provider, localAccounts, revision]);
	const options = [
		{ id: null, name: t("agents.account.defaultCli") },
		...(accounts ?? []),
	];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("agents.chat.recovery.chooseAccount")}</DialogTitle>
				</DialogHeader>
				{loadError ? (
					<Alert>
						{loadError}
						<Button
							variant="ghost"
							onClick={() => setRevision((value) => value + 1)}
						>
							{t("common.retry")}
						</Button>
					</Alert>
				) : !accounts ? (
					<LoadingRow />
				) : (
					<div className="max-h-72 space-y-1 overflow-y-auto">
						{options.map((account) => (
							<Button
								key={account.id ?? "default"}
								variant="ghost"
								className="w-full justify-start"
								disabled={disabled || account.id === selectedId}
								onClick={() => onSelect(account.id, account.name)}
							>
								<span className="size-3.5 shrink-0">
									{account.id === selectedId && <Check className="size-3.5" />}
								</span>
								<span className="truncate">{account.name}</span>
							</Button>
						))}
					</div>
				)}
				{busy && (
					<LoadingRow>{t("agents.account.switchInProgress")}</LoadingRow>
				)}
				{error && <Alert>{error}</Alert>}
			</DialogContent>
		</Dialog>
	);
}

import { AccountsPage } from "@/components/settings/AccountsPage";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { CredentialProfileRecovery } from "@/lib/agents/credentialSwitchRecovery";
import { t } from "@/lib/i18n";

/** Agent pane entry point for the canonical provider-account settings page. */
export function AccountsDialog({
	onClose,
	recovery,
}: {
	onClose: () => void;
	recovery?: CredentialProfileRecovery;
}) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				dismiss="none"
				className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl"
			>
				<DialogTitle className="sr-only">{t("agents.settings.title")}</DialogTitle>
				<AccountsPage onClose={onClose} recovery={recovery} showLoginIdentity />
			</DialogContent>
		</Dialog>
	);
}

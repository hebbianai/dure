import { type RefObject, useRef } from "react";
import { AccountsPage } from "@/components/settings/AccountsPage";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { CredentialProfileRecovery } from "@/lib/agents/credentialSwitchRecovery";
import { t } from "@/lib/i18n";
import type { Provider } from "@/types";

/** Dialog entry point for the canonical provider-account settings page. */
export function AccountsDialog({
	onClose,
	recovery,
	initialAddingProvider,
	returnFocusRef,
}: {
	onClose: () => void;
	recovery?: CredentialProfileRecovery;
	initialAddingProvider?: Provider;
	returnFocusRef?: RefObject<HTMLElement | null>;
}) {
	const handingOffToLogin = useRef(false);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				dismiss="none"
				onOpenAutoFocus={(event) => {
					if (!initialAddingProvider) return;
					const input = (
						event.currentTarget as HTMLElement
					).querySelector<HTMLInputElement>('input[name="accountName"]');
					if (!input) return;
					event.preventDefault();
					input.focus();
				}}
				onCloseAutoFocus={(event) => {
					if (!returnFocusRef?.current) return;
					event.preventDefault();
					// Opening a login pane transfers focus there; only dismissal returns it.
					if (!handingOffToLogin.current) returnFocusRef.current.focus();
				}}
				className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl"
			>
				<DialogTitle className="sr-only">{t("agents.settings.title")}</DialogTitle>
				<AccountsPage
					onClose={() => {
						handingOffToLogin.current = true;
						onClose();
					}}
					recovery={recovery}
					initialAddingProvider={initialAddingProvider}
					showLoginIdentity
				/>
			</DialogContent>
		</Dialog>
	);
}

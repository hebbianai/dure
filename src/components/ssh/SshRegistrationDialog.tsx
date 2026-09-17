import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { useSshRegistrationDecision } from "@/components/ssh/useSshHostDialogsState";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

export function SshRegistrationDialog() {
	const decision = useSshRegistrationDecision();
	if (!decision) return null;
	return (
		<Dialog
			key={decision.requestId}
			open
			onOpenChange={(open) => {
				if (!open) decision.answer(false);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("ssh.registrationPrompt.title")}</DialogTitle>
					<DialogDescription>
						{t("ssh.registrationPrompt.description", {
							destination: decision.candidate.name,
						})}
					</DialogDescription>
				</DialogHeader>
				<p className="text-sm text-muted-foreground">
					{t("ssh.registrationPrompt.expiry")}
				</p>
				<DialogActionFooter
					cancelLabel={t("ssh.registrationPrompt.useSsh")}
					onCancel={() => decision.answer(false)}
					confirmLabel={t("ssh.registrationPrompt.save")}
					onConfirm={() => decision.answer(true)}
				/>
			</DialogContent>
		</Dialog>
	);
}

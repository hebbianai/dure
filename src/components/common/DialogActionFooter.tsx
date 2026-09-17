// Shared two-button dialog footer: cancel + a single confirm action.
// Strictly two buttons — dialogs with a third action or non-confirm
// semantics keep their own DialogFooter. Busy-guarded onOpenChange stays
// at the caller; this footer only disables its own buttons while busy.
import type { ReactNode } from "react";
import { ConfirmationButton } from "@/components/ui/button";
import { DureLoader } from "@/components/ui/dure-loader";
import { DialogFooter } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

export function DialogActionFooter({
	cancelLabel,
	onCancel,
	confirmLabel,
	busyLabel,
	busy = false,
	disabled = false,
	variant = "default",
	icon,
	onConfirm,
}: {
	/** Cancel button copy — defaults to the shared t("common.cancel"). */
	cancelLabel?: ReactNode;
	onCancel: () => void;
	confirmLabel: ReactNode;
	/** Confirm copy while busy — omitted keeps confirmLabel. */
	busyLabel?: ReactNode;
	busy?: boolean;
	/** Confirm-only disable; busy always disables both buttons. */
	disabled?: boolean;
	variant?: "default" | "destructive";
	/** Busy spinner override — defaults to a spinning Loader2. */
	icon?: ReactNode;
	onConfirm: () => void;
}) {
	return (
		<DialogFooter>
			<ConfirmationButton
				variant="glass"
				disabled={busy}
				onClick={onCancel}
			>
				{cancelLabel ?? t("common.cancel")}
			</ConfirmationButton>
			<ConfirmationButton
				variant={variant}
				disabled={busy || disabled}
				onClick={onConfirm}
			>
				{busy && (icon ?? <DureLoader decorative />)}
				{busy && busyLabel !== undefined ? busyLabel : confirmLabel}
			</ConfirmationButton>
		</DialogFooter>
	);
}

import { useEffect, useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { FormField } from "@/components/common/FormField";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

export function NameEditDialog({
	open,
	title,
	description,
	value,
	placeholder,
	onOpenChange,
	onSave,
}: {
	open: boolean;
	title: string;
	description: string;
	value: string;
	placeholder: string;
	onOpenChange: (open: boolean) => void;
	onSave: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);

	useEffect(() => {
		if (open) setDraft(value);
	}, [open, value]);

	const submit = () => {
		onSave(draft);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<FormField
					className="py-1"
					label={t("workspace.nameEdit.displayName")}
					description={t("workspace.nameEdit.emptyRestoresAuto")}
				>
					<Input
						autoFocus
						value={draft}
						placeholder={placeholder}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") submit();
						}}
					/>
				</FormField>
				<DialogActionFooter
					cancelLabel={t("common.cancel")}
					onCancel={() => onOpenChange(false)}
					confirmLabel={t("common.save")}
					onConfirm={submit}
				/>
			</DialogContent>
		</Dialog>
	);
}

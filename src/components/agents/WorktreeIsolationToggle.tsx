import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";

/** Label and switch remain siblings so a click toggles exactly once. */
export function WorktreeIsolationToggle({
	checked,
	onCheckedChange,
	disabled,
	description,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	description?: string;
}) {
	const id = useId();
	return (
		<div className="flex w-full items-center justify-between gap-3">
			<label
				htmlFor={id}
				className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground"
			>
				<span>{t("agents.worktree.isolateDedicated")}</span>
				{description && (
					<span className="text-meta leading-4">{description}</span>
				)}
			</label>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onCheckedChange}
				disabled={disabled}
				aria-label={t("agents.worktree.isolateDedicated")}
			/>
		</div>
	);
}

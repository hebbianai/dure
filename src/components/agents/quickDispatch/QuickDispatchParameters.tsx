import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function QuickDispatchField({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="grid min-w-0 content-start gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

/** The name is free text; opening its editor leaves the committed launch
 * name unchanged until blur or Enter. Escape discards the draft. */
export function NameParamChip({
	label,
	value,
	placeholder,
	commit,
}: {
	label: string;
	value: string;
	placeholder: string;
	commit: (draft: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const finish = () => {
		commit(draft);
		setEditing(false);
	};
	return (
		<QuickDispatchField label={label}>
			{!editing ? (
				<Button
					type="button"
					variant="outline"
					aria-label={`${label}: ${value || placeholder}`}
					className="h-8 min-w-0 w-full justify-start px-3 text-xs font-normal"
					onClick={() => {
						setDraft(value);
						setEditing(true);
					}}
				>
					<span className="truncate">{value || placeholder}</span>
				</Button>
			) : (
				<Input
					autoFocus
					aria-label={label}
					value={draft}
					placeholder={placeholder}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={finish}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							finish();
						} else if (event.key === "Escape") {
							setEditing(false);
						}
					}}
				/>
			)}
		</QuickDispatchField>
	);
}

import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Workflow } from "lucide-react";

export function AutomationListItem({
	name,
	detail,
	status,
	disabled,
	onOpen,
}: {
	name: string;
	detail: string;
	status: string;
	disabled: boolean;
	onOpen: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			className="group flex w-full min-w-0 gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-glass-tint-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
			onClick={onOpen}
		>
			<Workflow
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				aria-hidden="true"
			/>
			<span className="min-w-0 flex-1 space-y-1">
				<OverflowRevealText className="block text-xs font-medium" text={name} />
				<OverflowRevealText className="block text-[11px] text-muted-foreground" text={detail} />
				<span className="block text-[11px] text-muted-foreground">
					{status}
				</span>
			</span>
		</button>
	);
}

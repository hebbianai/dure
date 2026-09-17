import { ChevronDown } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/** Shared floating return control; each scroll surface owns position and state. */
export function ScrollToLatestButton({
	visible,
	label,
	onClick,
}: {
	visible: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<IconButton
			title={label}
			onClick={onClick}
			disabled={!visible}
			aria-hidden={!visible}
			className={cn(
				"size-8 rounded-full border border-glass-hairline bg-glass-tray shadow-card backdrop-blur-md transition-[opacity,translate,visibility,background-color,color] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-0 motion-reduce:translate-y-0 motion-reduce:transition-none [&_svg]:size-4",
				visible
					? "pointer-events-auto visible translate-y-0 opacity-100"
					: "pointer-events-none invisible translate-y-1 opacity-0",
			)}
		>
			<ChevronDown aria-hidden="true" />
		</IconButton>
	);
}

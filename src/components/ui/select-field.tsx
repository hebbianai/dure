import { type ComponentProps, type ReactNode, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The Tab order selector shared by settings, forms, and toolbars.
 * Prefix values at this boundary so an empty domain value remains selectable
 * without colliding with Radix's empty-string placeholder state. */
export function SelectField({
	value,
	onValueChange,
	onOpenChange,
	disabled,
	children,
	className,
	contentClassName,
	leadingIcon,
	placeholder,
	display,
	toolbar,
	...triggerProps
}: Omit<
	ComponentProps<typeof SelectTrigger>,
	"children" | "value" | "onChange" | "ref"
> & {
	value: string;
	onValueChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
	contentClassName?: string;
	leadingIcon?: ReactNode;
	placeholder?: string;
	/** A current observed value can differ from the configured selection. */
	display?: ReactNode;
	/** Keep pane density and progressive detail reveal owned by ToolbarControl. */
	toolbar?: Pick<
		ComponentProps<typeof ToolbarControl>,
		"label" | "reveal" | "tone"
	>;
}) {
	const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
	return (
		<Select
			value={`:${value}`}
			onValueChange={(next) => onValueChange(next.slice(1))}
			onOpenChange={onOpenChange}
			disabled={disabled}
		>
			{toolbar ? (
				<SelectPrimitive.Trigger ref={setTrigger} asChild {...triggerProps}>
					<ToolbarControl
						{...toolbar}
						icon={leadingIcon}
						className={className}
						tooltipContainer={trigger?.ownerDocument.body}
					>
						<span className="min-w-0 max-w-28 truncate @lg/chat:max-w-40">
							<SelectValue placeholder={placeholder}>{display}</SelectValue>
						</span>
						<ChevronDown aria-hidden="true" className="size-3 opacity-60" />
					</ToolbarControl>
				</SelectPrimitive.Trigger>
			) : (
				<SelectTrigger
					ref={setTrigger}
					className={cn("w-full", className)}
					{...triggerProps}
				>
					{leadingIcon}
					<SelectValue placeholder={placeholder}>{display}</SelectValue>
				</SelectTrigger>
			)}
			<SelectContent
				container={trigger?.ownerDocument.body}
				className={cn(
					toolbar &&
						"w-max min-w-44 max-w-[min(24rem,var(--radix-select-content-available-width))]",
					contentClassName,
				)}
			>
				{children}
			</SelectContent>
		</Select>
	);
}

export function SelectOption({
	value,
	...props
}: ComponentProps<typeof SelectItem>) {
	return <SelectItem value={`:${value}`} data-value={value} {...props} />;
}

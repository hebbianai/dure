import {
	ChevronsDownUp,
	ChevronsUpDown,
	ListChevronsUpDown,
	type LucideIcon,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

interface ListViewOptionSectionBase {
	readonly id: string;
	readonly label: string;
	readonly icon: LucideIcon;
	readonly options: readonly { value: string; label: string }[];
	readonly contentClassName?: string;
	readonly active?: boolean;
}

interface ListViewRadioSection extends ListViewOptionSectionBase {
	readonly kind?: "radio";
	readonly value: string;
	onValueChange(value: string): void;
}

interface ListViewCheckboxSection extends ListViewOptionSectionBase {
	readonly kind: "checkbox";
	readonly values: readonly string[];
	/** Options whose toggle changes nothing in the current list, with the
	 *  reason. They stay toggleable — the preference outlives the list — but
	 *  read muted, so a check with no visible effect is explained in place. */
	readonly options: readonly {
		value: string;
		label: string;
		hint?: string;
	}[];
	onCheckedChange(value: string, checked: boolean): void;
}

export type ListViewOptionSection =
	| ListViewRadioSection
	| ListViewCheckboxSection;

export interface ListViewFilterGroup {
	readonly label: string;
	readonly resetLabel: string;
	readonly resetEnabled: boolean;
	readonly sections: readonly ListViewCheckboxSection[];
	onReset(): void;
}

function ListViewSectionMenu({ section }: { section: ListViewOptionSection }) {
	const SectionIcon = section.icon;
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger
				disabled={section.options.length === 0}
				data-active={section.active || undefined}
				className={cn(section.active && "text-foreground")}
			>
				<SectionIcon className="size-3.5" />
				<span className="min-w-0 flex-1 text-xs">{section.label}</span>
				{section.active && <StatusDot tone="warn" className="size-1" />}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent
				collisionPadding={8}
				className={cn("w-44", section.contentClassName)}
			>
				{section.kind === "checkbox" ? (
					section.options.map((option) => (
						<DropdownMenuCheckboxItem
							key={option.value}
							checked={section.values.includes(option.value)}
							onCheckedChange={(checked) =>
								section.onCheckedChange(option.value, checked === true)
							}
							onSelect={(event) => event.preventDefault()}
						>
							<span
								className={cn(
									"min-w-0 flex-1 text-xs",
									option.hint && "text-muted-foreground",
								)}
							>
								{option.label}
							</span>
							{option.hint && (
								<span className="ml-2 shrink-0 text-[10px] text-muted-foreground/80">
									{option.hint}
								</span>
							)}
						</DropdownMenuCheckboxItem>
					))
				) : (
					<DropdownMenuRadioGroup
						value={section.value}
						onValueChange={section.onValueChange}
					>
						{section.options.map((option) => (
							<DropdownMenuRadioItem key={option.value} value={option.value}>
								<span className="text-xs">{option.label}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

export function ListViewOptionsMenu({
	label,
	sections,
	filterGroup,
	hasActiveFilters = false,
	canExpandAll,
	canCollapseAll,
	expandAllLabel,
	collapseAllLabel,
	onExpandAll,
	onCollapseAll,
}: {
	label: string;
	sections: readonly ListViewOptionSection[];
	filterGroup?: ListViewFilterGroup;
	hasActiveFilters?: boolean;
	canExpandAll: boolean;
	canCollapseAll: boolean;
	expandAllLabel: string;
	collapseAllLabel: string;
	onExpandAll(): void;
	onCollapseAll(): void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<IconButton
					title={label}
					showTooltip={false}
					className={cn("relative", hasActiveFilters && "text-foreground")}
					data-active-filters={hasActiveFilters || undefined}
				>
					<ListChevronsUpDown />
					{hasActiveFilters && (
						<StatusDot
							tone="warn"
							className="absolute top-0.5 right-0.5 size-1 ring-1 ring-background"
						/>
					)}
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				// Down-right from the button — the one rule for header icon-button menus
				// (HoverMenuButton; owner decision 2026-09-10).
				align="start"
				collisionPadding={8}
				className="w-48"
			>
				{sections.map((section) => (
					<ListViewSectionMenu key={section.id} section={section} />
				))}
				{filterGroup && <DropdownMenuSeparator />}
				{filterGroup && (
					<>
						<DropdownMenuItem
							disabled={!filterGroup.resetEnabled}
							onSelect={filterGroup.onReset}
							className="justify-between"
						>
							<span className="text-xs text-muted-foreground">
								{filterGroup.label}
							</span>
							<span className="text-xs text-muted-foreground">
								{filterGroup.resetLabel}
							</span>
						</DropdownMenuItem>
						{filterGroup.sections.map((section) => (
							<ListViewSectionMenu key={section.id} section={section} />
						))}
					</>
				)}
				{(canCollapseAll || canExpandAll) && <DropdownMenuSeparator />}
				{canCollapseAll ? (
					<DropdownMenuItem onClick={onCollapseAll}>
						<ChevronsDownUp />
						<span className="text-xs">{collapseAllLabel}</span>
					</DropdownMenuItem>
				) : canExpandAll ? (
					<DropdownMenuItem onClick={onExpandAll}>
						<ChevronsUpDown />
						<span className="text-xs">{expandAllLabel}</span>
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

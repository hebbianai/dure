import {
	ArrowLeft,
	ChevronRight,
	CircleDot,
	SlidersHorizontal,
	Tag,
	UserCheck,
	UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import {
	type GitHubFilterField,
	githubFilterSuggestions,
	githubQueryFilters,
} from "@/lib/github/githubFilters";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import type {
	GitHubWorkspacePreset,
	GitHubWorkspaceView,
} from "@/lib/github/githubWorkspace";
import { t } from "@/lib/i18n";

export function GitHubFilters({
	query,
	preset,
	view,
	rows,
	onFilterChange,
	onPresetChange,
}: {
	query: string;
	preset: GitHubWorkspacePreset;
	view: GitHubWorkspaceView;
	rows: readonly GitHubWorkItemRow[];
	onFilterChange: (field: GitHubFilterField, value: string) => void;
	onPresetChange: (preset: GitHubWorkspacePreset) => void;
}) {
	const [open, setOpen] = useState(false);
	const [field, setField] = useState<GitHubFilterField | null>(null);
	const [draft, setDraft] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const filters = view === "projects" ? {} : githubQueryFilters(query);
	const status = filters.status ?? (preset === "all" ? "all" : "open");
	const labels = {
		status: t("github.detail.status"),
		author: t("github.filters.author"),
		label: t("github.filters.label"),
		assignee: t("github.filters.assignee"),
	};
	const icons = {
		status: CircleDot,
		author: UserRound,
		label: Tag,
		assignee: UserCheck,
	};
	useEffect(() => {
		if (field && field !== "status") input.current?.focus();
	}, [field]);
	const apply = (selected: GitHubFilterField, value: string) => {
		onFilterChange(selected, value);
		setOpen(false);
		setField(null);
	};
	return (
		<DropdownMenu
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setField(null);
			}}
		>
			<DropdownMenuTrigger asChild>
				<IconButton
					title={t("github.filters.title")}
					showTooltip={false}
					pressed={Object.keys(filters).length > 0 || preset !== "open"}
				>
					<SlidersHorizontal />
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				// Down-right from the button, like every header icon-button menu
				// (ListViewOptionsMenu; owner decision 2026-09-10).
				align="start"
				collisionPadding={8}
				className="w-60 max-w-[calc(100vw-16px)]"
			>
				{field ? (
					<>
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								setField(null);
							}}
						>
							<ArrowLeft />
							{t("common.back")}
						</DropdownMenuItem>
						<DropdownMenuLabel>{labels[field]}</DropdownMenuLabel>
						{field === "status" ? (
							<DropdownMenuRadioGroup
								value={status}
								onValueChange={(value) => apply("status", value)}
							>
								{(view === "projects"
									? ["all", "open"]
									: view === "pullRequests"
										? ["all", "open", "closed", "merged"]
										: ["all", "open", "closed"]
								).map((value) => (
									<DropdownMenuRadioItem key={value} value={value}>
										{t(
											value === "all"
												? "github.workspace.filter.all"
												: `github.workspace.signal.${value}`,
										)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						) : (
							<>
								<form
									className="space-y-2 px-1 py-1.5"
									onKeyDown={(event) => {
										if (event.key !== "Escape") event.stopPropagation();
									}}
									onSubmit={(event) => {
										event.preventDefault();
										apply(field, draft);
									}}
								>
									<Input
										ref={input}
										aria-label={labels[field]}
										placeholder={
											field === "label"
												? t("github.filters.labelPlaceholder")
												: t("github.filters.actorPlaceholder")
										}
										value={draft}
										onChange={(event) => setDraft(event.target.value)}
										className="h-7 text-xs"
									/>
									<div className="flex justify-end gap-1">
										<Button
											type="button"
											variant="ghost"
											size="xs"
											onClick={() => apply(field, "")}
										>
											{t("github.filters.clear")}
										</Button>
										<Button type="submit" size="xs">
											{t("github.filters.apply")}
										</Button>
									</div>
								</form>
								{githubFilterSuggestions(rows, field)
									.filter((value) =>
										value
											.toLocaleLowerCase()
											.includes(draft.toLocaleLowerCase()),
									)
									.slice(0, 6)
									.map((value) => (
										<DropdownMenuItem
											key={value}
											onSelect={() => apply(field, value)}
										>
											<span className="truncate">{value}</span>
										</DropdownMenuItem>
									))}
							</>
						)}
					</>
				) : (
					<>
						<DropdownMenuLabel>{t("github.filters.title")}</DropdownMenuLabel>
						{(view === "projects"
							? (["status"] as const)
							: (["status", "author", "label", "assignee"] as const)
						).map((key) => {
							const Icon = icons[key];
							const value =
								key === "status"
									? t(
											status === "all"
												? "github.workspace.filter.all"
												: `github.workspace.signal.${status}`,
										)
									: (filters[key] ??
										(preset === "mine" &&
										key === (view === "pullRequests" ? "author" : "assignee")
											? "@me"
											: ""));
							return (
								<DropdownMenuItem
									key={key}
									onSelect={(event) => {
										event.preventDefault();
										setDraft(key === "status" ? "" : value);
										setField(key);
									}}
								>
									<Icon />
									<span>{labels[key]}</span>
									<span className="ml-auto max-w-24 truncate text-muted-foreground">
										{value}
									</span>
									<ChevronRight />
								</DropdownMenuItem>
							);
						})}
						{view !== "projects" && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuCheckboxItem
									checked={preset === "mine"}
									onCheckedChange={(checked) =>
										onPresetChange(checked ? "mine" : "open")
									}
								>
									{t("github.workspace.filter.mine")}
								</DropdownMenuCheckboxItem>
								{view === "pullRequests" && (
									<DropdownMenuCheckboxItem
										checked={preset === "needsReview"}
										onCheckedChange={(checked) =>
											onPresetChange(checked ? "needsReview" : "open")
										}
									>
										{t("github.workspace.filter.needsReview")}
									</DropdownMenuCheckboxItem>
								)}
							</>
						)}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

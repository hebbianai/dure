import { Pencil } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useEffect, useRef, useState } from "react";
import { LoadingRow} from "@/components/common/StatusBlocks";
import { GitHubActor } from "@/components/github/GitHubActor";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { githubAssigneeChoices } from "@/lib/github/githubAssignees";
import type { GitHubIssueMutation } from "@/lib/github/githubIssueDetails";
import type { GitHubQueryResult } from "@/lib/github/githubQuery";
import type { GitHubRepository } from "@/lib/github/githubResponses";
import { t } from "@/lib/i18n";
import { ghAssignableUsers } from "@/lib/ipc/github";

export function GitHubAssigneePicker({
	repository,
	values,
	disabled,
	error,
	onSave,
}: {
	repository: GitHubRepository;
	values: string[];
	disabled: boolean;
	error: string | null;
	onSave: (mutation: GitHubIssueMutation) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [revision, setRevision] = useState(0);
	const [result, setResult] = useState<GitHubQueryResult<string[]> | null>(
		null,
	);
	const menu = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!open) return;
		let active = true;
		setResult(null);
		void ghAssignableUsers(repository).then((next) => {
			if (active) setResult(next);
		});
		return () => {
			active = false;
		};
	}, [open, repository, revision]);
	const choices = githubAssigneeChoices(
		result?.ok ? result.value : [],
		values,
		query,
	);
	return (
		<div className="min-w-0 space-y-1">
			<div className="flex items-center justify-between text-[11px] text-muted-foreground">
				<span>{t("github.detail.assignees")}</span>
				<DropdownMenu
					open={open}
					onOpenChange={(next) => {
						setOpen(next);
						if (!next) setQuery("");
					}}
				>
					<DropdownMenuTrigger asChild>
						<IconButton
							title={t("github.detail.editAssignees")}
							disabled={disabled}
						>
							<Pencil />
						</IconButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						ref={menu}
						align="end"
						collisionPadding={8}
						className="w-60 max-w-[calc(100vw-16px)]"
						aria-label={t("github.detail.assignees")}
						onFocus={(event) => {
							if (event.target === event.currentTarget) {
								event.preventDefault();
								search.current?.focus();
							}
						}}
					>
						<div className="p-1">
							<SearchField
								ref={search}
								aria-label={t("github.assignees.search")}
								placeholder={t("github.assignees.search")}
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								inputClassName="h-7 text-xs"
								onKeyDown={(event) => {
									if (event.key === "Escape") return;
									event.stopPropagation();
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										event.preventDefault();
										const items = menu.current?.querySelectorAll<HTMLElement>(
											'[role="menuitemcheckbox"]:not([data-disabled])',
										);
										items?.[
											event.key === "ArrowDown" ? 0 : items.length - 1
										]?.focus();
									}
								}}
							/>
						</div>
						{error && <Alert surface="outline" className="mx-1 my-2">{error}</Alert>}
						{!result && (
							<LoadingRow className="px-2 py-3">
								{t("common.loading")}
							</LoadingRow>
						)}
						{result && !result.ok && (
							<div className="space-y-2 p-1">
								<Alert surface="outline">
									{result.error.detail ||
										t("github.workspace.error.loadFailed")}
								</Alert>
								<Button
									size="xs"
									variant="outline"
									onClick={() => setRevision((value) => value + 1)}
								>
									{t("common.retry")}
								</Button>
							</div>
						)}
						<div className="max-h-60 overflow-y-auto">
							{choices.map(({ login, selected }) => (
								<DropdownMenuCheckboxItem
									key={login}
									checked={selected}
									disabled={disabled}
									textValue={login}
									className="min-h-8"
									onSelect={(event) => event.preventDefault()}
									onCheckedChange={() => {
										void onSave({
											kind: "assignees",
											before: selected ? [login] : [],
											after: selected ? [] : [login],
										});
									}}
								>
									<GitHubActor login={login} repositoryUrl={repository.url} />
								</DropdownMenuCheckboxItem>
							))}
						</div>
						{result?.ok && choices.length === 0 && (
							<p className="px-2 py-3 text-xs text-muted-foreground">
								{t("github.assignees.empty")}
							</p>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="flex min-h-6 flex-wrap items-center gap-1.5 text-[11px]">
				{values.length ? (
					values.map((login) => (
						<GitHubActor
							key={login}
							login={login}
							repositoryUrl={repository.url}
						/>
					))
				) : (
					<span className="text-muted-foreground">
						{t("github.detail.none")}
					</span>
				)}
			</div>
		</div>
	);
}

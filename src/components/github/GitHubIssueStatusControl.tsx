import { SelectButton } from "@/components/ui/select";
import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import {
	Check,
	ChevronRight,
	CircleDot,
	CircleSlash,
	Copy,
} from "lucide-react";
import { useState } from "react";
import {
	CompactWorkItemStateIcon,
	workItemStateLabel,
} from "@/components/github/GitHubWorkspaceRows";
import { ConfirmationButton } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	type GitHubIssueDetails,
	type GitHubIssueMutation,
	parseDuplicateIssueNumber,
} from "@/lib/github/githubIssueDetails";
import { t } from "@/lib/i18n";

export function GitHubIssueStatusControl({
	detail,
	disabled,
	onSave,
}: {
	detail: GitHubIssueDetails;
	disabled: boolean;
	onSave: (
		mutation: GitHubIssueMutation,
		confirmed?: () => void,
	) => Promise<boolean>;
}) {
	const [duplicate, setDuplicate] = useState<string | null>(null);
	const number =
		duplicate === null
			? null
			: parseDuplicateIssueNumber(duplicate, detail.number);
	const closed = detail.state === "CLOSED";
	const label = workItemStateLabel(detail);
	return (
		<div className="min-w-0 space-y-2">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SelectButton
						aria-label={t("github.detail.status")}
						disabled={disabled}
						className="w-full"
					>
						<CompactWorkItemStateIcon row={detail} />
						<OverflowRevealText className="min-w-0 flex-1 text-left" text={label} />
					</SelectButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
					<DropdownMenuItem
						disabled={disabled || !closed}
						onSelect={() => void onSave({ kind: "state", state: "OPEN" })}
					>
						<CircleDot />
						{t("github.workspace.signal.open")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={disabled || closed}
						onSelect={() =>
							void onSave({
								kind: "state",
								state: "CLOSED",
								reason: "completed",
							})
						}
					>
						<Check />
						{t("github.detail.closeCompleted")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={disabled || closed}
						onSelect={() =>
							void onSave({
								kind: "state",
								state: "CLOSED",
								reason: "not planned",
							})
						}
					>
						<CircleSlash />
						{t("github.detail.closeNotPlanned")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={disabled || closed}
						onSelect={() => setDuplicate("")}
					>
						<Copy />
						{t("github.detail.closeDuplicate")}
						<ChevronRight className="ml-auto" />
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{duplicate !== null && (
				<form
					className="space-y-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						if (number !== null)
							void onSave({ kind: "duplicate", number }, () =>
								setDuplicate(null),
							);
					}}
				>
					<Input
						aria-label={t("github.detail.originalIssue")}
						placeholder="#123"
						inputMode="numeric"
						value={duplicate}
						disabled={disabled}
						onChange={(event) => setDuplicate(event.target.value)}
						className="h-7 text-xs"
					/>
					<p className="text-[10px] text-muted-foreground">
						{t("github.detail.duplicateHint")}
					</p>
					<div className="flex flex-wrap justify-end gap-2">
						<ConfirmationButton
							type="button"
							variant="glass"
							disabled={disabled}
							onClick={() => setDuplicate(null)}
						>
							{t("common.cancel")}
						</ConfirmationButton>
						<ConfirmationButton
							type="submit"
							disabled={disabled || closed || number === null}
						>
							{t("common.close")}
						</ConfirmationButton>
					</div>
				</form>
			)}
		</div>
	);
}

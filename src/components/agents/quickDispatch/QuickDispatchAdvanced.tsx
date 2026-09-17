import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Titled } from "@/components/ui/tooltip";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
	type LaunchPermissionSelection,
	launchPermissionDescription,
	launchPermissionLabel,
	providerPermissionOptions,
} from "@/lib/agents/providerPermissions";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Disclosure owns only presentation; all launch choices outlive its content. */
export function QuickDispatchAdvanced({
	children,
	action,
	summary,
	provider,
	permission,
	onPermissionChange,
	runSetup,
	onRunSetupChange,
	useWorktree,
}: {
	children: ReactNode;
	action: ReactNode;
	summary: string;
	provider: string;
	permission: LaunchPermissionSelection;
	onPermissionChange: (value: LaunchPermissionSelection) => void;
	runSetup: boolean;
	useWorktree: boolean;
	onRunSetupChange: (value: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const summaryId = useId();
	const permissionChoices: LaunchPermissionSelection[] = [
		"inherit",
		...providerPermissionOptions(provider).map((option) => option.override),
	];
	return (
		<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3">
			<div className="flex min-w-0 flex-col items-start">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="gap-1.5 px-2 text-muted-foreground"
					aria-expanded={open}
					aria-controls={contentId}
					aria-describedby={!open && summary ? summaryId : undefined}
					onClick={() => setOpen(!open)}
				>
					<DisclosureChevron open={open} />
					{t("common.advanced")}
				</Button>
				{!open && summary && (
					<Titled title={summary}>
						<p
							id={summaryId}
							className={cn(
								"max-w-full truncate px-2 text-meta text-muted-foreground",
								permission === "bypass_approvals" && "text-destructive",
							)}
						>
							{summary}
						</p>
					</Titled>
				)}
			</div>
			<div id={contentId} hidden={!open} className="col-span-2">
				{open && (
					<div className="flex min-w-0 flex-col gap-4 border-t border-glass-hairline px-1 pt-3">
						<div className="flex min-w-0 flex-wrap items-center gap-1">
							{children}
							<SelectField
								aria-label={t("agents.chat.permissionLabel")}
								value={permission}
								onValueChange={(next) =>
									onPermissionChange(next as LaunchPermissionSelection)
								}
								display={launchPermissionLabel(permission)}
								className={cn(
									"w-56",
									permission === "bypass_approvals" && "text-destructive",
								)}
								aria-describedby={
									permission === "bypass_approvals"
										? `${contentId}-permission-hint`
										: undefined
								}
							>
								{permissionChoices.map((choice) => (
									<SelectOption
										key={choice}
										value={choice}
										textValue={launchPermissionLabel(choice)}
										aria-label={launchPermissionLabel(choice)}
										aria-describedby={`${contentId}-${choice}`}
										className={
											choice === "bypass_approvals" ? "text-destructive" : undefined
										}
										description={
											<span id={`${contentId}-${choice}`}>
												{launchPermissionDescription(choice)}
											</span>
										}
									>
										{launchPermissionLabel(choice)}
									</SelectOption>
								))}
							</SelectField>
						</div>
						{permission === "bypass_approvals" && (
							<p
								id={`${contentId}-permission-hint`}
								className="px-2 text-meta text-destructive"
							>
								{launchPermissionDescription(permission)}
							</p>
						)}
						<div className="flex items-center justify-between gap-4">
							<label
								className="flex min-w-0 flex-col gap-1"
								htmlFor={`${contentId}-setup`}
							>
								<span className="text-xs font-medium">
									{t("agents.worktree.runSetupAfterCreate")}
								</span>
								<span className="text-meta text-muted-foreground">
									{t("agents.quickDispatch.setupHint")}
								</span>
							</label>
							<Switch
								id={`${contentId}-setup`}
								aria-label={t("agents.worktree.runSetupAfterCreate")}
								checked={runSetup}
								disabled={!useWorktree}
								onCheckedChange={onRunSetupChange}
							/>
						</div>
					</div>
				)}
			</div>
			<div
				className={cn("col-start-2 justify-self-end", !open && "row-start-1")}
			>
				{action}
			</div>
		</div>
	);
}

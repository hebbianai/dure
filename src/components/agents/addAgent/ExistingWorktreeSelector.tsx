import { SelectField, SelectOption } from "@/components/ui/select-field";
import { existingWorktreeOwnershipGuidance } from "@/lib/agents/existingWorktreeOwnershipPresentation";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { ExistingWorktreeCandidate } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export type WorktreeSource = "new" | "existing";

function basename(path: string): string {
	return path.replace(/\/+$/u, "").split("/").pop() || path;
}

function ownershipSuffix(candidate: ExistingWorktreeCandidate): string {
	const { ownership } = candidate;
	if (ownership.state === "unowned") return "";
	const provider = ownership.owners?.[0]?.provider;
	return provider
		? ` · ${t("agents.worktree.inUseBy", { provider })}`
		: ` · ${t("agents.worktree.ownershipNeedsReview")}`;
}

export function ExistingWorktreeSelector({
	source,
	onSourceChange,
	candidates,
	selectedPath,
	onSelectedPathChange,
	loading,
	error,
	limit,
	truncated,
	recoveringPath,
	inspectingPath,
	onRecover,
	onInspect,
	onRetry,
}: {
	source: WorktreeSource;
	onSourceChange: (source: WorktreeSource) => void;
	candidates: readonly ExistingWorktreeCandidate[];
	selectedPath: string;
	onSelectedPathChange: (path: string) => void;
	loading: boolean;
	error: string | null;
	limit: number;
	truncated: boolean;
	recoveringPath: string | null;
	inspectingPath: string | null;
	onRecover: (candidate: ExistingWorktreeCandidate) => void;
	onInspect: (candidate: ExistingWorktreeCandidate) => void;
	onRetry: () => void;
}) {
	const selected = candidates.find(
		(candidate) => candidate.reference.canonicalPath === selectedPath,
	);
	const recoverable =
		selected?.ownership.state === "stale_owned" &&
		((selected.ownership.claimReceiptId !== undefined &&
			(selected.ownership.owners?.length ?? 0) === 0) ||
			(selected.ownership.claimReceiptId === undefined &&
				selected.ownership.owners?.length === 1 &&
				selected.ownership.owners[0]?.runtimeLiveness === "dead" &&
				selected.ownership.owners[0]?.paneLiveness === "dead"))
			? selected
			: undefined;
	const inspectable =
		selected?.ownership.state === "ambiguous" ? selected : undefined;
	const ownershipNotice =
		selected && selected.ownership.state !== "unowned"
			? selected
			: undefined;
	return (
		<div className="flex w-full flex-col gap-3 rounded-md border border-border/70 bg-muted/20 p-3">
			<div className="grid grid-cols-2 gap-2" role="radiogroup">
				{(["new", "existing"] as const).map((value) => (
					<label
						key={value}
						className={cn(
							"flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs",
							source === value
								? "border-foreground/40 bg-muted/50 text-foreground"
								: "border-border text-muted-foreground",
						)}
					>
						<input
							type="radio"
							className="accent-foreground"
							name="worktree-source"
							value={value}
							checked={source === value}
							onChange={() => onSourceChange(value)}
						/>
						{value === "new" ? t("agents.worktree.new") : t("agents.worktree.existing")}
					</label>
				))}
			</div>

			{source === "existing" && (
				<div className="flex w-full flex-col gap-2">
					<SelectField
						aria-label={t("agents.worktree.existing")}
						value={selectedPath}
						disabled={loading || Boolean(error)}
						onValueChange={(nextValue) => onSelectedPathChange(nextValue)}
					>
						<SelectOption value="">
							{loading
								? t("agents.worktree.listLoading")
								: t("agents.worktree.selectExisting")}
						</SelectOption>
						{candidates.map((candidate) => (
							<SelectOption
								key={`${candidate.reference.gitDir}\0${candidate.reference.head}`}
								value={candidate.reference.canonicalPath}
							>
								{candidate.reference.canonicalPath} · {candidate.reference.branch} ·{" "}
								{candidate.reference.head.slice(0, 8)}
								{ownershipSuffix(candidate)}
							</SelectOption>
						))}
					</SelectField>
					<p className="text-meta leading-4 text-muted-foreground">
						{t("agents.worktree.preservesCheckout")}
					</p>
					{truncated && (
						<p role="status" className="text-meta leading-4 text-status-warn">
							{t("agents.worktree.listTruncated", {
								limit,
							})}
						</p>
					)}
					{error && (
						<div className="flex items-start justify-between gap-3">
							<p role="alert" className="text-meta break-all text-destructive">
								{t("agents.worktree.listLoadFailed", { error })}
							</p>
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="shrink-0"
								onClick={onRetry}
							>
								{t("agents.worktree.listRetry")}
							</Button>
						</div>
					)}
					{inspectingPath === selectedPath && (
						<p role="status" className="text-meta text-muted-foreground">
							{t("agents.worktree.ownershipChecking")}
						</p>
					)}
					{inspectable && inspectingPath !== selectedPath && (
						<button
							type="button"
							onClick={() => onInspect(inspectable)}
							className="self-start rounded-md border border-border px-2.5 py-1.5 text-meta text-foreground hover:bg-muted"
						>
							{t("common.recheck")}
						</button>
					)}
					{recoverable && (
						<button
							type="button"
							disabled={recoveringPath !== null}
							onClick={() => onRecover(recoverable)}
							className="self-start rounded-md border border-border px-2.5 py-1.5 text-meta text-foreground hover:bg-muted disabled:opacity-60"
						>
							{recoveringPath === recoverable.reference.canonicalPath
								? t("agents.worktree.ownershipRecovering")
								: t("agents.worktree.recoverStaleOwnership", {
										name: basename(recoverable.reference.canonicalPath),
									})}
						</button>
					)}
					{ownershipNotice && (
						<p className="text-meta leading-4 text-muted-foreground">
							{basename(ownershipNotice.reference.canonicalPath)} ·{" "}
							{existingWorktreeOwnershipGuidance(ownershipNotice.ownership)}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

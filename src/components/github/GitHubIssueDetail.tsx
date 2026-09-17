import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import {
	ArrowLeft,
	Check,
	Copy,
	ExternalLink,
	MessageSquare,
	Pencil,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import { LoadingRow} from "@/components/common/StatusBlocks";
import { useCopyFeedback } from "@/components/common/useCopyFeedback";
import { GitHubActor } from "@/components/github/GitHubActor";
import { GitHubAssigneePicker } from "@/components/github/GitHubAssigneePicker";
import { GitHubIssueStatusControl } from "@/components/github/GitHubIssueStatusControl";
import {
	CompactWorkItemStateIcon,
	WorkItemAction,
	workItemStateLabel,
} from "@/components/github/GitHubWorkspaceRows";
import { Button, ConfirmationButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Textarea } from "@/components/ui/textarea";
import {
	type GitHubIssueDetails,
	type GitHubIssueMutation,
	parseIssueMetadataInput,
} from "@/lib/github/githubIssueDetails";
import {
	type GitHubQueryFailure,
	githubQueryFailureMessage,
} from "@/lib/github/githubQuery";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import { t } from "@/lib/i18n";
import { ghIssueDetails, ghMutateIssue } from "@/lib/ipc/github";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import type { Agent } from "@/types";

function failureMessage(failure: GitHubQueryFailure): string {
	if (failure.kind === "invalid-duplicate")
		return t("github.detail.invalidDuplicate");
	return githubQueryFailureMessage(failure);
}

function IssueMarkdown({ body }: { body: string }) {
	return (
		<SafeMarkdown
			markdown={body}
			onOpenExternal={openExternalUrl}
			className="min-w-0 break-words [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto"
			style={{ fontSize: "12px", lineHeight: "1.7" }}
		/>
	);
}

export function GitHubIssueDetail({
	row,
	agents,
	activeSpaceId,
	onBack,
	onUpdated,
}: {
	row: GitHubWorkItemRow;
	agents: readonly Agent[];
	activeSpaceId: string;
	/** Absent in a pane, where closing the pane is the way out. */
	onBack?: () => void;
	onUpdated: (row: GitHubWorkItemRow) => void;
}) {
	const [detail, setDetail] = useState<GitHubIssueDetails | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [comment, setComment] = useState("");
	const [preview, setPreview] = useState(false);
	const request = useRef(0);
	const commentId = useId();
	const pendingWrite = useRef(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const { status: copyStatus, copy } = useCopyFeedback();

	const load = useCallback(async () => {
		const version = ++request.current;
		setLoading(true);
		setError(null);
		const result = await ghIssueDetails(row);
		if (request.current !== version) return;
		if (result.ok) {
			setDetail(result.value);
			onUpdated(result.value);
		} else setError(failureMessage(result.error));
		setLoading(false);
	}, [row, onUpdated]);

	useEffect(() => {
		heading.current?.focus();
		void load();
		return () => {
			request.current += 1;
		};
	}, [load]);

	const mutate = async (
		mutation: GitHubIssueMutation,
		confirmed?: () => void,
	): Promise<boolean> => {
		if (pendingWrite.current || loading || !detail) return false;
		pendingWrite.current = true;
		setSaving(true);
		setError(null);
		const version = request.current;
		const result = await ghMutateIssue(detail, mutation);
		if (version !== request.current) return false;
		if (result.ok) {
			// A confirmed comment is cleared before refreshing, so a failed read cannot repost it.
			confirmed?.();
			await load();
		} else
			setError(
				result.error.kind === "timed-out"
					? t("github.detail.writeUncertain")
					: failureMessage(result.error),
			);
		pendingWrite.current = false;
		setSaving(false);
		return result.ok;
	};
	const current = detail ?? row;
	const disabled = saving || loading;

	return (
		<section
			aria-label={t("github.detail.label")}
			className="@container flex min-h-0 min-w-0 flex-1 flex-col"
		>
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
				{onBack && (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={saving}
						onClick={onBack}
					>
						<ArrowLeft className="size-3.5" />
						{t("github.detail.back")}
					</Button>
				)}
				<OverflowRevealText className="min-w-0 flex-1 text-[10px] text-muted-foreground"
					title={row.repository.nameWithOwner} text={row.repository.nameWithOwner} />
				<RefreshButton
					busy={loading}
					disabled={disabled}
					onClick={() => void load()}
				/>
				<IconButton
					title={
						copyStatus === "copied"
							? t("common.copiedToClipboard")
							: copyStatus === "failed"
								? t("common.copyToClipboardFailed")
								: t("github.detail.copyLink")
					}
					onClick={() => void copy(row.url)}
				>
					{copyStatus === "copied" ? <Check /> : <Copy />}
				</IconButton>
				<IconButton
					title={t("github.workspace.openOnGitHub")}
					onClick={() => void openExternalUrl(row.url)}
				>
					<ExternalLink />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
				<header className="space-y-2 border-b border-border/60 px-3 py-3 @lg:px-5 @lg:py-4">
					<div className="flex flex-wrap items-start gap-2">
						<h2
							ref={heading}
							tabIndex={-1}
							className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 outline-none @lg:text-lg @lg:leading-7"
						>
							{current.title}{" "}
							<span className="font-normal text-muted-foreground">
								#{row.number}
							</span>
						</h2>
						<WorkItemAction
							row={current}
							agents={agents}
							activeSpaceId={activeSpaceId}
						/>
					</div>
					<div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
						<CompactWorkItemStateIcon row={current} />
						<span>{workItemStateLabel(current)}</span>
						<span className="min-w-0 font-medium text-foreground">
							<GitHubActor
								login={current.author ?? ""}
								repositoryUrl={row.repository.url}
							/>
						</span>
						<time dateTime={current.updatedAt}>
							{t("github.detail.updated", {
								date: new Date(current.updatedAt).toLocaleString(),
							})}
						</time>
					</div>
				</header>
				{error && (
					<div className="px-3 py-2">
						<Alert
							role="alert"
							action={
								<Button
									variant="outline"
									size="xs"
									disabled={disabled}
									onClick={() => void load()}
								>
									{t("common.retry")}
								</Button>
							}
						>
							{error}
						</Alert>
					</div>
				)}
				{loading && (
					<LoadingRow className="px-3 py-3">{t("common.loading")}</LoadingRow>
				)}
				{detail && (
					<>
						<div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-b border-border/60 px-3 py-3 @lg:grid-cols-3 @lg:px-5">
							<div className="min-w-0 space-y-1">
								<span className="flex h-6 items-center text-[11px] text-muted-foreground">
									{t("github.detail.status")}
								</span>
								<GitHubIssueStatusControl
									detail={detail}
									disabled={disabled}
									onSave={mutate}
								/>
							</div>
							<GitHubAssigneePicker
								repository={row.repository}
								values={detail.assignees}
								disabled={disabled}
								error={error}
								onSave={mutate}
							/>
							<IssueLabels
								values={detail.labels}
								disabled={disabled}
								onSave={mutate}
							/>
						</div>
						<div className="space-y-5 px-3 py-4 @lg:px-5">
							<IssueBody
								body={detail.body}
								disabled={disabled}
								onSave={mutate}
							/>
							<section
								className="space-y-3"
								aria-label={t("github.detail.comments")}
							>
								<h3 className="flex items-center gap-1.5 text-xs font-medium">
									<MessageSquare className="size-3.5 text-muted-foreground" />
									{t("github.detail.comments")}
									<span className="text-muted-foreground">
										{detail.comments.length}
									</span>
								</h3>
								{detail.comments.length === 0 && (
									<p className="text-xs text-muted-foreground">
										{t("github.detail.noComments")}
									</p>
								)}
								{detail.comments.map((item) => (
									<article
										key={item.id}
										className="min-w-0 space-y-2 border-l border-border pl-3"
									>
										<div className="flex flex-wrap items-center gap-x-2 text-[11px]">
											<span className="min-w-0 font-medium">
												<GitHubActor
													login={item.author}
													repositoryUrl={row.repository.url}
												/>
											</span>
											<time
												className="text-muted-foreground"
												dateTime={item.createdAt}
											>
												{new Date(item.createdAt).toLocaleString()}
											</time>
										</div>
										<IssueMarkdown body={item.body} />
									</article>
								))}
							</section>
							<form
								className="space-y-2"
								onSubmit={(event) => {
									event.preventDefault();
									void mutate({ kind: "comment", body: comment }, () => {
										setComment("");
										setPreview(false);
									});
								}}
							>
								<div className="flex items-center justify-between gap-2">
									<label htmlFor={commentId} className="text-xs font-medium">
										{t("github.detail.addComment")}
									</label>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										aria-pressed={preview}
										onClick={() => setPreview(!preview)}
									>
										{preview ? t("github.detail.write") : t("common.preview")}
									</Button>
								</div>
								{preview ? (
									<div className="min-h-24 rounded-md border border-border p-2">
										<IssueMarkdown
											body={comment || t("github.detail.nothingToPreview")}
										/>
									</div>
								) : (
									<Textarea
										id={commentId}
										value={comment}
										disabled={saving}
										onChange={(event) => setComment(event.target.value)}
										className="min-h-24 text-xs"
										placeholder={t("github.detail.commentPlaceholder")}
									/>
								)}
								<div className="flex justify-end">
									<Button
										type="submit"
										size="sm"
										disabled={disabled || !comment.trim()}
									>
										{saving
											? t("common.saving")
											: t("github.detail.postComment")}
									</Button>
								</div>
							</form>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

function IssueBody({
	body,
	disabled,
	onSave,
}: {
	body: string;
	disabled: boolean;
	onSave: (
		mutation: GitHubIssueMutation,
		confirmed?: () => void,
	) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<section className="min-w-0 space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-xs font-medium">
					{t("github.detail.description")}
				</h3>
				<IconButton
					title={t("github.detail.editBody")}
					disabled={disabled || draft !== null}
					onClick={() => setDraft(body)}
				>
					<Pencil />
				</IconButton>
			</div>
			{draft !== null ? (
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void onSave({ kind: "body", body: draft }, () => setDraft(null));
					}}
				>
					<Textarea
						aria-label={t("github.detail.description")}
						value={draft}
						disabled={disabled}
						onChange={(event) => setDraft(event.target.value)}
						className="min-h-48 text-xs"
					/>
					<div className="flex flex-wrap justify-end gap-2">
						<ConfirmationButton
							type="button"
							variant="glass"
							disabled={disabled}
							onClick={() => setDraft(null)}
						>
							{t("common.cancel")}
						</ConfirmationButton>
						<ConfirmationButton type="submit" disabled={disabled}>
							{t("common.save")}
						</ConfirmationButton>
					</div>
				</form>
			) : (
				<IssueMarkdown body={body || t("github.detail.noDescription")} />
			)}
		</section>
	);
}

function IssueLabels({
	values,
	disabled,
	onSave,
}: {
	values: string[];
	disabled: boolean;
	onSave: (
		mutation: GitHubIssueMutation,
		confirmed?: () => void,
	) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState<{ before: string[]; text: string } | null>(
		null,
	);
	const label = t("github.detail.labels");
	return (
		<div className="col-span-2 min-w-0 space-y-1 @lg:col-span-1">
			<div className="flex items-center justify-between text-[11px] text-muted-foreground">
				<span>{label}</span>
				<IconButton
					title={t("github.detail.editLabels")}
					disabled={disabled || draft !== null}
					onClick={() => setDraft({ before: values, text: values.join(", ") })}
				>
					<Pencil />
				</IconButton>
			</div>
			{draft !== null ? (
				<form
					className="space-y-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						void onSave(
							{
								kind: "labels",
								before: draft.before,
								after: parseIssueMetadataInput(draft.text),
							},
							() => setDraft(null),
						);
					}}
				>
					<Input
						aria-label={label}
						value={draft.text}
						disabled={disabled}
						onChange={(event) =>
							setDraft({ ...draft, text: event.target.value })
						}
						className="h-7 text-xs"
					/>
					<p className="text-[10px] text-muted-foreground">
						{t("github.detail.commaSeparated")}
					</p>
					<div className="flex flex-wrap justify-end gap-2">
						<ConfirmationButton
							type="button"
							variant="glass"
							disabled={disabled}
							onClick={() => setDraft(null)}
						>
							{t("common.cancel")}
						</ConfirmationButton>
						<ConfirmationButton type="submit" disabled={disabled}>
							{t("common.save")}
						</ConfirmationButton>
					</div>
				</form>
			) : (
				<div className="flex min-h-6 flex-wrap items-center gap-1 text-[11px]">
					{values.length ? (
						values.map((value) => (
							<span
								key={value}
								className="max-w-full break-words rounded bg-muted px-1.5 py-0.5"
							>
								{value}
							</span>
						))
					) : (
						<span className="text-muted-foreground">
							{t("github.detail.none")}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

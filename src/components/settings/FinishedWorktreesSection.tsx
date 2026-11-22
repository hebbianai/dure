// Settings → Storage: finished Run worktrees per local project (#623).
//
// The backend's checkout authority decides which worktrees Dure created and
// which are safe to remove; this lists its answer, totals the size and asks
// once, in place, before removing them with plain `git worktree remove`.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocalRepositoryProjects } from "@/components/scm/useLocalRepositoryProjects";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { ErrorText } from "@/components/ui/error-text";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/i18n";
import {
	keptWorktrees,
	removableBytes,
	removableWorktrees,
	type WorktreeReclaimCandidate,
	type WorktreeReclaimHold,
	type WorktreeReclaimSummary,
	worktreeDisplayPath,
} from "@/lib/scm/worktrees/worktreeReclaim";
import {
	getWorktreeReclaimState,
	type ProjectWorktreeReclaim,
	reclaimProjectWorktrees,
	scanProjectWorktrees,
	subscribeWorktreeReclaim,
} from "@/lib/scm/worktrees/worktreeReclaimStore";
import { formatBytes } from "@/lib/usage/systemResources";
import type { Project } from "@/types";

function holdLabel(hold: WorktreeReclaimHold): string {
	switch (hold) {
		case "in_use":
			return t("settings.storage.worktrees.hold.inUse");
		case "locked":
			return t("settings.storage.worktrees.hold.locked");
		case "dirty":
			return t("settings.storage.worktrees.hold.dirty");
		case "detached_unreachable":
			return t("settings.storage.worktrees.hold.detachedUnreachable");
		case "unavailable":
			return t("settings.storage.worktrees.hold.unavailable");
	}
}

function WorktreeRow({
	repositoryPath,
	checkout,
	detail,
}: {
	repositoryPath: string;
	checkout: WorktreeReclaimCandidate;
	detail: string;
}) {
	return (
		<li className="flex min-w-0 items-baseline gap-3 py-1">
			<span className="min-w-0 flex-1">
				<span className="block truncate text-xs text-foreground">
					{checkout.branch ?? t("settings.storage.worktrees.detached")}
				</span>
				<span
					className="block truncate font-mono text-xs text-muted-foreground/80"
					data-selectable
				>
					{worktreeDisplayPath(repositoryPath, checkout)}
				</span>
			</span>
			<span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
		</li>
	);
}

function SummaryText({ summary }: { summary: WorktreeReclaimSummary }) {
	return (
		<div role="status" className="flex flex-col gap-1 text-xs text-muted-foreground">
			{summary.removed > 0 ? (
				<p>
					{summary.removed === 1
						? t("settings.storage.worktrees.removedOne", {
								size: formatBytes(summary.freedBytes),
							})
						: t("settings.storage.worktrees.removedMany", {
								count: summary.removed,
								size: formatBytes(summary.freedBytes),
							})}
				</p>
			) : null}
			{summary.kept.map(({ instance, hold }) => (
				<p key={instance.instanceToken}>
					{t("settings.storage.worktrees.keptChanged", {
						path: instance.canonicalPath,
						reason: holdLabel(hold),
					})}
				</p>
			))}
			{summary.failed.map(({ instance, message }) => (
				<ErrorText key={instance.instanceToken} className="text-xs">
					{t("settings.storage.worktrees.failed", {
						path: instance.canonicalPath,
						message,
					})}
				</ErrorText>
			))}
		</div>
	);
}

function statusText(entry: ProjectWorktreeReclaim | undefined): string {
	if (entry?.status === "removing") {
		return t("settings.storage.worktrees.removing");
	}
	if (!entry?.scan) {
		return entry?.status === "error"
			? t("settings.storage.worktrees.unavailable")
			: t("settings.storage.worktrees.checking");
	}
	const count = removableWorktrees(entry.scan).length;
	const size = formatBytes(removableBytes(entry.scan));
	if (count === 0) return t("settings.storage.worktrees.none");
	return count === 1
		? t("settings.storage.worktrees.removableOne", { size })
		: t("settings.storage.worktrees.removableMany", { count, size });
}

function ProjectWorktrees({
	project,
	entry,
}: {
	project: Project;
	entry: ProjectWorktreeReclaim | undefined;
}) {
	const [confirming, setConfirming] = useState(false);
	const scan = entry?.scan;
	const removable = scan ? removableWorktrees(scan) : [];
	const kept = scan ? keptWorktrees(scan) : [];
	const busy = entry?.status === "scanning" || entry?.status === "removing";
	const ready = entry?.status === "ready";
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="flex min-w-px flex-1 flex-col gap-1">
					<p className="truncate text-sm font-medium text-foreground">
						{project.name}
					</p>
					<p className="text-xs text-muted-foreground">{statusText(entry)}</p>
				</div>
				<RefreshButton
					busy={entry?.status === "scanning"}
					disabled={busy}
					onClick={() => void scanProjectWorktrees(project.path)}
				/>
				{removable.length > 0 && !confirming ? (
					<Button
						variant="outline"
						className="h-8 shrink-0 rounded-md px-3 text-xs"
						disabled={!ready}
						onClick={() => setConfirming(true)}
					>
						{t("settings.storage.worktrees.remove")}
					</Button>
				) : null}
			</div>
			{confirming && scan ? (
				<InlineConfirmRow
					question={
						removable.length === 1
							? t("settings.storage.worktrees.confirmOne", {
									size: formatBytes(removableBytes(scan)),
								})
							: t("settings.storage.worktrees.confirmMany", {
									count: removable.length,
									size: formatBytes(removableBytes(scan)),
								})
					}
					confirmLabel={t("settings.storage.worktrees.remove")}
					busy={!ready}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						void reclaimProjectWorktrees(project.path);
					}}
				/>
			) : null}
			{entry?.status === "error" ? (
				<ErrorText className="text-xs">{entry.message}</ErrorText>
			) : null}
			{entry?.status === "ready" && entry.summary ? (
				<SummaryText summary={entry.summary} />
			) : null}
			{scan && removable.length > 0 ? (
				<Disclosure
					label={t("settings.storage.worktrees.showRemovable", {
						count: removable.length,
					})}
				>
					<ul>
						{removable.map((checkout) => (
							<WorktreeRow
								key={checkout.instance.instanceToken}
								repositoryPath={scan.repositoryPath}
								checkout={checkout}
								detail={formatBytes(checkout.sizeBytes ?? 0)}
							/>
						))}
					</ul>
				</Disclosure>
			) : null}
			{scan && kept.length > 0 ? (
				<Disclosure
					label={t("settings.storage.worktrees.showKept", {
						count: kept.length,
					})}
				>
					<ul>
						{kept.map((checkout) => (
							<WorktreeRow
								key={checkout.instance.instanceToken}
								repositoryPath={scan.repositoryPath}
								checkout={checkout}
								detail={holdLabel(checkout.hold)}
							/>
						))}
					</ul>
				</Disclosure>
			) : null}
		</div>
	);
}

/** Every registered local Git project, scanned when the page opens. */
export function FinishedWorktreesSection() {
	const local = useLocalRepositoryProjects();
	const state = useSyncExternalStore(
		subscribeWorktreeReclaim,
		getWorktreeReclaimState,
	);
	const paths = local.map((project) => project.path).join("\n");
	useEffect(() => {
		for (const path of paths ? paths.split("\n") : []) {
			void scanProjectWorktrees(path);
		}
	}, [paths]);
	if (local.length === 0) return null;
	return (
		<section className="flex w-full flex-col gap-6 border-t border-border py-8">
			<div className="flex flex-col gap-1.5">
				<p className="text-sm font-medium text-foreground">
					{t("settings.storage.worktrees.title")}
				</p>
				<p className="text-xs text-muted-foreground">
					{t("settings.storage.worktrees.desc")}
				</p>
			</div>
			{local.map((project) => (
				<ProjectWorktrees
					key={project.id}
					project={project}
					entry={state.projects[project.path]}
				/>
			))}
		</section>
	);
}

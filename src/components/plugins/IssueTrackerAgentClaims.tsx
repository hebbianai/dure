import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { GitBranch } from "lucide-react";
import { useEffect, useRef } from "react";
import { useIssueTrackerAgentClaims } from "@/components/plugins/useIssueTrackerAgentClaims";
import { DureLoader } from "@/components/ui/dure-loader";
import { ErrorText } from "@/components/ui/error-text";
import type { IssueTrackerIssueSummaryV1 } from "@/contracts/generated/extensionContracts";
import { t } from "@/lib/i18n";

const MAX_VISIBLE_UNMATCHED_CLAIMS = 5;

function ClaimIssue({
	issue,
	onOpen,
}: {
	issue: IssueTrackerIssueSummaryV1;
	onOpen?: () => void;
}) {
	return (
		<button
			type="button"
			className="mt-1 block w-full min-w-0 rounded px-1 py-0.5 text-left text-[10px] hover:bg-sidebar-accent disabled:cursor-default disabled:hover:bg-transparent"
			disabled={!onOpen}
			onClick={onOpen}
		>
			<OverflowRevealText className="block text-sidebar-foreground" text={issue.title} />
		</button>
	);
}

export function IssueTrackerAgentClaims({
	title,
	projectId,
	statuses,
	claimIssues,
	complete,
	loading,
	error,
	canOpen,
	onOpen,
}: {
	title: string;
	projectId: string | null;
	statuses: string[];
	claimIssues: IssueTrackerIssueSummaryV1[];
	complete: boolean;
	loading: boolean;
	error: string | null;
	canOpen: boolean;
	onOpen: (issueId: string) => void;
}) {
	const { groups, selectedPaneId, navigation } = useIssueTrackerAgentClaims(
		projectId,
		claimIssues,
		statuses,
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Bring the new selection into view, but never interrupt scrolling on watch updates.
		if ((selectedPaneId || navigation) && scrollRef.current) {
			scrollRef.current.scrollTop = 0;
		}
	}, [selectedPaneId, navigation]);
	return (
		<section aria-label={title} className="shrink-0 border-b border-glass-hairline px-3 pb-2">
			<div className="flex h-7 items-center gap-2 text-[11px] font-semibold text-muted-foreground">
				<span>{title}</span>
				{loading && <DureLoader decorative />}
			</div>
			<div ref={scrollRef} className="max-h-48 space-y-1 overflow-y-auto pr-1">
				{error && (
					<ErrorText className="px-1 py-1 text-[10px]">{error}</ErrorText>
				)}
				{!loading && !error && !complete && (
					<p className="px-1 py-1 text-[10px] leading-4 text-status-warn">
						{t("plugins.claims.partialResults")}
					</p>
				)}
				{groups.panes.map((pane) => (
					<div
						key={pane.id}
						aria-current={pane.id === selectedPaneId ? "true" : undefined}
						className="rounded-md bg-foreground/[0.035] px-2 py-1.5"
					>
						<div className="flex min-w-0 items-center gap-1.5">
							<OverflowRevealText text={pane.label}
								className="min-w-0 flex-1 text-[11px] font-medium text-sidebar-foreground" />
							<span className="flex min-w-0 max-w-[45%] items-center gap-1 font-mono text-[9px] text-muted-foreground">
								<GitBranch className="size-2.5 shrink-0" />
								<OverflowRevealText text={pane.branch} />
							</span>
						</div>
						{pane.issues.length === 0 && !loading && !error ? (
							<p className="mt-1 text-[10px] text-muted-foreground">
								{complete ? t("plugins.claims.none") : t("plugins.claims.incomplete")}
							</p>
						) : (
							pane.issues.map((issue) => (
								<ClaimIssue
									key={issue.id}
									issue={issue}
									onOpen={canOpen ? () => onOpen(issue.id) : undefined}
								/>
							))
						)}
					</div>
				))}
				{groups.unmatched.length > 0 && (
					<div className="rounded-md border border-dashed border-glass-hairline px-2 py-1.5">
						<div className="text-[10px] font-medium text-muted-foreground">
							{t("plugins.claims.unlinked")}
						</div>
						{groups.unmatched
							.slice(0, MAX_VISIBLE_UNMATCHED_CLAIMS)
							.map((issue) => (
								<ClaimIssue
									key={issue.id}
									issue={issue}
									onOpen={canOpen ? () => onOpen(issue.id) : undefined}
								/>
							))}
						{groups.unmatched.length > MAX_VISIBLE_UNMATCHED_CLAIMS && (
							<p className="px-1 pt-1 text-[10px] text-muted-foreground">
								{t("plugins.claims.more", {
									n: groups.unmatched.length - MAX_VISIBLE_UNMATCHED_CLAIMS,
								})}
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

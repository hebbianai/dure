import { Folder, GitBranch, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActivityDot, activityLabel } from "@/components/agents/StatusBits";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { SidebarInlineDetails } from "@/components/common/SidebarInlineDetails";
import { ProviderConversationHistory } from "@/components/sessions/ProviderConversationHistory";
import { Button } from "@/components/ui/button";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { readProviderConversationRecord } from "@/lib/agents/providerConversationRecordCache";
import { providerConversationTargetForAgent } from "@/lib/agents/providerConversationTarget";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { t } from "@/lib/i18n";
import type { RecentAgentActivity } from "@/lib/spaces/spacesDisplay";
import { useStore } from "@/store";
import { PROVIDERS, type Agent } from "@/types";

export function UnopenedAgentDetails({
	agent,
	displayState,
	unread,
	projectName,
	recentActivity,
	activityAt,
	lastActivity,
	onResume,
	onClose,
}: {
	agent: Agent;
	displayState: AgentDisplayState;
	unread: boolean;
	projectName: string;
	recentActivity?: RecentAgentActivity;
	activityAt?: number;
	lastActivity?: string;
	onResume(): void;
	/** Close this agent: opens the removal dialog, which is where the
	 *  session actually ends — one click here never kills anything. */
	onClose(): void;
}) {
	const sshHosts = useStore((state) => state.sshHosts);
	const projectLocation = useStore((state) =>
		state.projects.find((project) => project.id === agent.projectId),
	);
	const target = useMemo(
		() => providerConversationTargetForAgent(agent, projectLocation),
		[
			agent.conversationId,
			agent.provider,
			agent.runtimeBinding,
			projectLocation,
		],
	);
	const [record, setRecord] = useState<ProviderConversationRecord>();
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);

	// Session-scoped cache: re-expanding the same row reuses the last read;
	// the latest activity timestamp is the invalidation fingerprint (newer
	// checkpoint/prompt = the transcript may have grown), so it is also an
	// effect dependency — fresh activity while open refreshes the record.
	const activityFingerprint = activityAt;
	useEffect(() => {
		if (!target) return;
		let cancelled = false;
		setRecord(undefined);
		setLoading(true);
		setFailed(false);
		void readProviderConversationRecord(target, sshHosts, activityFingerprint)
			.then((next) => {
				if (!cancelled) setRecord(next);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sshHosts, target, activityFingerprint]);

	return (
		<SidebarInlineDetails
			data-agent-details=""
			// Full width: the rule above already spans the row, and an indented
			// block under a full-width rule read as misaligned (owner call
			// 2026-09-09, with the session row's details).
			// No cap and no scroller of its own. The cap (320, then 256) was for
			// three full turns that could make one card taller than the pane;
			// with the preview clamped to two turns of two lines the card's
			// height is bounded by its content, and a nested scroller only
			// sliced a turn mid-line at its edge and left the "Latest turns"
			// heading scrolled away (owner report 2026-09-14). The sidebar's own
			// list scrolls, as it does for everything else in it.
			className="flex flex-col"
		>
			<div data-agent-details-scroll="">
				{loading && (
					<p className="mb-2 text-meta text-muted-foreground">
						{t("common.loading")}
					</p>
				)}
				{failed && (
					<p className="mb-2 text-meta text-status-warn">
						{t("common.recentSessionsLoadFailed")}
					</p>
				)}
				{record && target && (
					<ProviderConversationHistory
						provider={record.provider}
						conversationId={record.id}
						executionLocation={record.executionLocation}
						hostId={record.hostId}
						recentTurns={record.recentTurns ?? []}
						subagentCount={record.subagentCount ?? 0}
						sshHosts={sshHosts}
						className="mb-2"
					/>
				)}
				{recentActivity && (
					<p
						data-agent-latest-activity=""
						className="mb-2 whitespace-pre-wrap break-words rounded-md bg-glass-tint-hover px-2 py-1.5 text-meta leading-4 text-sidebar-foreground/85"
					>
						{recentActivity.text}
					</p>
				)}
				<div className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
					<ActivityDot
						activity={displayState}
						unread={unread}
						className="size-[5px]"
					/>
					<span className="shrink-0 text-sidebar-foreground/85">
						{activityLabel(displayState)}
					</span>
					<span aria-hidden="true">·</span>
					<ProviderGlyph
						provider={agent.provider}
						className="size-3 shrink-0"
					/>
					<span className="shrink-0 text-sidebar-foreground/85">
						{PROVIDERS[agent.provider].label}
					</span>
					{lastActivity && activityAt !== undefined && (
						<>
							<span aria-hidden="true">·</span>
							<time
								className="shrink-0 font-mono"
								dateTime={new Date(activityAt).toISOString()}
							>
								{lastActivity}
							</time>
						</>
					)}
				</div>

				<section className="mt-2">
					<h4 className="flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
						<Folder className="size-3" />
						{t("common.worktree")}
					</h4>
					<div className="mt-1 space-y-1 text-meta leading-4">
						{/* No branch to name (an agent at its repository root) drops
						    the whole line rather than leaving a lone git glyph —
						    the same rule the row's info line follows. */}
						{agent.branch && (
							<div className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
								<GitBranch className="mt-px size-3 shrink-0" />
								<span className="min-w-0 break-all font-mono">
									{agent.branch}
								</span>
							</div>
						)}
						<div className="text-sidebar-foreground/85">{projectName}</div>
						<div className="break-all font-mono text-muted-foreground">
							{agent.worktreePath}
						</div>
					</div>
				</section>
			</div>
			{/* The foot asks the one question this card is open for — go on, or
			    close it — with both answers side by side. Closing was reachable
			    only through the row's context menu, as "Remove agent"; here it
			    is the outline button beside Resume, and it opens the same
			    removal dialog, so the confirmation is where the session ends.
			    Hide-from-list stays in the menu: that one only tidies the list
			    (owner call 2026-09-14). */}
			<div
				data-agent-details-footer=""
				className="mt-2 flex shrink-0 gap-2 border-t border-glass-hairline pt-2"
			>
				<Button
					type="button"
					variant="outline"
					// Half and half with Resume: the foot is one question with two
					// answers, and two equal buttons read as that. A trash glyph at
					// the right end was the other way to go and lost — it made the
					// close look like a tool rather than an answer (owner call
					// 2026-09-14).
					className="flex-1 text-xs"
					onClick={onClose}
				>
					{t("spaces.actions.closeAgent")}
				</Button>
				<Button
					type="button"
					variant="glass"
					className="flex-1 text-xs"
					onClick={onResume}
				>
					<Play data-icon="inline-start" className="fill-current" />
					{t("common.resumeContinue")}
				</Button>
			</div>
		</SidebarInlineDetails>
	);
}

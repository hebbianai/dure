import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Bot, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { StatusDot } from "@/components/ui/status-dot";
import {
	loadProviderConversationDetails,
	type ProviderConversationDetails,
	type ProviderConversationSubagent,
	type ProviderConversationTurn,
} from "@/lib/agents/providerConversationDiscovery";
import { t } from "@/lib/i18n";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider, type SshHostConfig } from "@/types";

/** The app's status vocabulary (owner rule, restated 2026-09-10): running is
 *  a spinner, never a green dot; done is blue; an error is red; a state with
 *  nothing to report shows no mark at all — the label alone says "Unknown". */
function subagentStatusPresentation(
	status: ProviderConversationSubagent["status"],
): {
	label: string;
	glyph: "spinner" | "done" | "error" | null;
} {
	switch (status) {
		case "running":
			return { label: t("sessions.status.running"), glyph: "spinner" };
		case "completed":
			return { label: t("common.done"), glyph: "done" };
		case "failed":
			return { label: t("common.failed"), glyph: "error" };
		default:
			return { label: t("common.unknown"), glyph: null };
	}
}

export function ProviderConversationHistory({
	provider,
	conversationId,
	executionLocation,
	hostId,
	recentTurns,
	subagentCount,
	sshHosts,
	className,
}: {
	provider: Provider;
	conversationId: string;
	executionLocation: "local" | "ssh";
	hostId?: string;
	recentTurns: readonly ProviderConversationTurn[];
	subagentCount: number;
	sshHosts: readonly SshHostConfig[];
	className?: string;
}) {
	const [details, setDetails] = useState<ProviderConversationDetails | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const visibleTurns = recentTurns.slice(-2);
	// Each turn keeps its own block — a role line over the text — because a
	// single collapsed line per turn read badly (owner, 2026-09-08). The text
	// folds at two lines and the block opens on click; three full
	// transcripts stacked here used to make one session taller than the pane.
	// Two turns at two lines, down from three at three: this preview is the
	// default open state of an unopened agent's card, and at three-by-three
	// the conversation took the card past the sidebar's fold before the
	// Resume / Hide row it exists for (owner call 2026-09-14). The block per
	// turn is what the 2026-09-08 call was about, and that stays.
	// The block is the sidebar's nested-content surface (the faint tint the
	// subagent rows below and the spaces tab's agent details use), not a
	// white bordered card — on glass that reads as a raised control.
	const [openTurns, setOpenTurns] = useState<ReadonlySet<number>>(
		() => new Set(),
	);

	useEffect(() => {
		if (subagentCount === 0) return;
		let cancelled = false;
		setDetails(null);
		setLoading(true);
		setFailed(false);
		void loadProviderConversationDetails(
			{
				provider,
				conversationId,
				executionLocation,
				...(hostId ? { hostId } : {}),
			},
			sshHosts,
		)
			.then((next) => {
				if (!cancelled) setDetails(next);
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
	}, [
		conversationId,
		executionLocation,
		hostId,
		provider,
		sshHosts,
		subagentCount,
	]);

	if (visibleTurns.length === 0 && subagentCount === 0) return null;

	const providerLabel = PROVIDERS[provider].label;
	// "You", as the row's preview says it: the same person in two words —
	// "You:" on the collapsed row and "User" on the open turn — read as two
	// systems (owner report 2026-09-09). The provider keeps its own name.
	const roleLabel = (role: "user" | "agent") =>
		role === "user" ? t("sessions.preview.you") : providerLabel;
	const visibleSubagents = details?.subagents ?? [];
	const visibleSubagentCount = details?.totalCount ?? subagentCount;

	return (
		<div
			data-provider-conversation-history=""
			className={cn("min-w-0", className)}
		>
			{visibleTurns.length > 0 && (
				<section>
					<h4 className="flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
						<MessageSquareText className="size-3" />
						{t("sessions.history.latestTurns")}
					</h4>
					<div className="mt-1 divide-y divide-glass-hairline overflow-hidden rounded-md bg-glass-tint-hover">
						{visibleTurns.map((turn, index) => {
							const open = openTurns.has(index);
							return (
								<button
									type="button"
									key={`${turn.role}-${index}`}
									aria-expanded={open}
									className="block w-full min-w-0 px-2 py-1.5 text-left transition-colors hover:bg-glass-tint-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									onClick={() =>
										setOpenTurns((current) => {
											const next = new Set(current);
											if (open) next.delete(index);
											else next.add(index);
											return next;
										})
									}
								>
									<p className="text-meta font-medium text-muted-foreground">
										{roleLabel(turn.role)}
									</p>
									<p
										className={cn(
											"mt-0.5 break-words text-meta leading-4 text-sidebar-foreground/85",
											open ? "whitespace-pre-wrap" : "line-clamp-2",
										)}
									>
										{turn.text}
									</p>
								</button>
							);
						})}
					</div>
				</section>
			)}

			{subagentCount > 0 && (
				<section className={visibleTurns.length > 0 ? "mt-2" : undefined}>
					<h4 className="flex items-center gap-1.5 text-meta font-medium text-muted-foreground">
						<Bot className="size-3" />
						{t("sessions.history.subagents")} ({visibleSubagentCount})
					</h4>
					{loading && (
						<p className="mt-1 text-meta text-muted-foreground">
							{t("common.loading")}
						</p>
					)}
					{failed && (
						<p className="mt-1 text-meta text-status-warn">
							{t("sessions.history.subagentsLoadFailed")}
						</p>
					)}
					{!loading && visibleSubagents.length > 0 && (
						<div className="mt-1 divide-y divide-glass-hairline overflow-hidden rounded-md bg-glass-tint-hover">
							{visibleSubagents.map((subagent) => {
								const status = subagentStatusPresentation(subagent.status);
								return (
									<div
										key={subagent.id}
										className="min-w-0 px-2 py-1.5"
									>
										<div className="flex min-w-0 items-center gap-1.5">
											<OverflowRevealText text={subagent.title}
												className="min-w-0 flex-1 text-meta text-sidebar-foreground/85" />
											{subagent.kind && (
												<span className="shrink-0 font-mono text-meta leading-none text-muted-foreground">
													{subagent.kind}
												</span>
											)}
										</div>
										<div className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
											{status.glyph === "spinner" ? (
												<DureLoader decorative size={10} className="shrink-0" />
											) : status.glyph ? (
												<StatusDot tone={status.glyph} className="size-1" />
											) : null}
											<span>{status.label}</span>
											<span aria-hidden="true">·</span>
											<span className="font-mono">{formatRelativeAge(subagent.mtime * 1000)}</span>
										</div>
									</div>
								);
							})}
							{visibleSubagentCount > visibleSubagents.length && (
								<p className="px-2 pt-0.5 text-meta text-muted-foreground">
									{t("sessions.history.moreCount", {
										n: visibleSubagentCount - visibleSubagents.length,
									})}
								</p>
							)}
						</div>
					)}
				</section>
			)}
		</div>
	);
}

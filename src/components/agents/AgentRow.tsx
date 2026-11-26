import { AgentDiffBadge } from "@/components/agents/AgentDiffBadge";
import { ActivityDot, activityLabel } from "@/components/agents/StatusBits";
import { useNowTick } from "@/components/spaces/useNowTick";
import { continuationTimeLabel } from "@/lib/agents/chat/turnFailureReason";
import type {
	AgentRowActivity,
	AgentRowManagedSummary,
	AgentRowModel,
	AgentRowStatus,
} from "@/lib/agents/agentRowModel";
import { currentLang, t } from "@/lib/i18n";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<AgentRowStatus, () => string> = {
	approval: () => activityLabel("blocked"),
	input: () => activityLabel("input"),
	error: () => activityLabel("error"),
	unexpected_exit: () => t("agents.row.unexpectedExit"),
	sign_in_exit: () => t("agents.row.signInExit"),
	result: () => t("agents.row.result"),
};

function agentRowStatusLabel(status: AgentRowStatus): string {
	return STATUS_LABEL[status]();
}

/** When an agent continues by itself after its usage limit resets, in the
 * words every list of agents uses. */
export function agentContinuesText(atMs: number, nowMs?: number): string {
	return t("agents.row.continuesAt", {
		time: continuationTimeLabel(atMs, currentLang(), nowMs),
	});
}

/** Program text never reads as Dure's: it is always attributed. A prompt is
 * labelled as what was asked, so it never reads as the agent's own words. */
function activityText(activity: AgentRowActivity): string {
	switch (activity.kind) {
		case "approval":
			return activity.summary
				? t("agents.row.approvalWithSummary", {
						tool: activity.toolName,
						summary: activity.summary,
					})
				: t("agents.row.approval", { tool: activity.toolName });
		case "program":
			return activity.app
				? t("agents.row.programMessageFromApp", {
						app: activity.app,
						message: activity.message,
					})
				: t("agents.row.programMessageFromProgram", { message: activity.message });
		case "asked":
			return t("agents.row.asked", { prompt: activity.text });
	}
}

/** What an agent manages, in one line: the same words on its row and on its
 * team line. */
export function agentRowManagedText(managed: AgentRowManagedSummary): string {
	return [
		t("agents.row.manages", { n: managed.count }),
		managed.needsPerson > 0
			? t("agents.row.managedNeedYou", { n: managed.needsPerson })
			: undefined,
		managed.working > 0
			? t("agents.row.managedWorking", { n: managed.working })
			: undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

export type AgentRowVariant = "list" | "card" | "line";

/** One agent, the same way in every list. `list` is a row in a menu or side
 * list, `card` stands in for a pane too small for its terminal, and `line`
 * is a single line inside another agent's conversation. Selecting is the
 * caller's: the row itself mounts nothing and acknowledges nothing. */
export function AgentRow({
	row,
	variant = "list",
	onSelect,
}: {
	row: AgentRowModel;
	variant?: AgentRowVariant;
	onSelect?: (agentId: string) => void;
}) {
	const now = useNowTick();
	const meta = [
		// Why the row is listed. A card stands in for a whole pane, so without
		// a reason it still says what its dot shows, in words.
		row.status
			? agentRowStatusLabel(row.status)
			: row.continuesAtMs !== undefined
				? agentContinuesText(row.continuesAtMs, now)
				: variant === "card" && row.dot.state
					? activityLabel(row.dot.state)
					: undefined,
		row.sinceMs === undefined ? undefined : formatRelativeAge(row.sinceMs, now),
		...row.context,
	]
		.filter(Boolean)
		.join(" · ");
	const path = row.path?.join(" › ");
	const managed = row.managed ? agentRowManagedText(row.managed) : undefined;
	const activity = row.activity ? activityText(row.activity) : undefined;
	const select = onSelect ? () => onSelect(row.agentId) : undefined;
	const dot = <ActivityDot activity={row.dot.state} unread={row.dot.unread} />;

	if (variant === "line") {
		const trailing = [meta, managed].filter(Boolean).join(" · ");
		return (
			<button
				type="button"
				data-slot="agent-row"
				data-variant="line"
				className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-meta leading-4 outline-none hover:bg-glass-tint-hover focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
				onClick={select}
			>
				{dot}
				{path && (
					<span className="min-w-0 shrink truncate text-muted-foreground">
						{path} ›
					</span>
				)}
				<span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
				{trailing && (
					<span className="min-w-0 shrink truncate text-muted-foreground">
						{trailing}
					</span>
				)}
			</button>
		);
	}

	const card = variant === "card";
	return (
		<button
			type="button"
			data-slot="agent-row"
			data-variant={variant}
			className={cn(
				"flex w-full min-w-0 items-start gap-2 text-left outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring",
				card
					? "rounded-lg bg-glass-tint p-3 inset-ring-1 inset-ring-glass-hairline hover:bg-glass-tint-hover"
					: "rounded-md px-2 py-1.5 hover:bg-glass-tint-hover",
			)}
			onClick={select}
		>
			<span className="flex h-4 shrink-0 items-center">{dot}</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				{path && (
					<span className="truncate text-meta leading-4 text-muted-foreground">
						{path}
					</span>
				)}
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-foreground",
							card ? "text-sm leading-5" : "text-xs leading-4",
						)}
					>
						{row.title}
					</span>
					<AgentDiffBadge agentId={row.agentId} />
				</span>
				{meta && (
					<span className="truncate text-meta leading-4 text-muted-foreground">
						{meta}
					</span>
				)}
				{managed && (
					<span className="truncate text-meta leading-4 text-muted-foreground">
						{managed}
					</span>
				)}
				{activity && (
					<span
						className={cn(
							"text-meta leading-4 [overflow-wrap:anywhere] text-muted-foreground",
							card ? "line-clamp-3" : "line-clamp-2",
						)}
					>
						{activity}
					</span>
				)}
			</span>
		</button>
	);
}

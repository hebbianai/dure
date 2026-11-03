import { useEffect, useState } from "react";
import { ChatDisclosure } from "@/components/agents/chat/ChatDisclosure";
import {
	backgroundWorkHiddenCount,
	backgroundWorkRows,
	backgroundWorkSummary,
} from "@/lib/agents/chat/backgroundWork";
import { t } from "@/lib/i18n";
import {
	type BackgroundWorkList,
	readAgentBackgroundWork,
} from "@/lib/ipc/conversations";

/** How often the line re-reads while the agent works. Background work moves
 * without turns, so the transcript's refresh cursor cannot drive it. */
export const BACKGROUND_WORK_REFRESH_MS = 5_000;

/** The agent's running subagents, workflows, shells and monitors, collapsed
 * to one line above the composer. The desktop decides what runs from the
 * provider's records behind the Host's facts; this only renders it, and
 * reads nothing while the Host reports the agent idle. */
export function NativeAgentBackgroundWork({
	workspaceId,
	sessionId,
	active,
	now = Date.now,
}: {
	workspaceId: string;
	sessionId: string;
	/** The Host reports the agent working (a turn or background work). */
	active: boolean;
	now?: () => number;
}) {
	const [list, setList] = useState<BackgroundWorkList | null>(null);

	useEffect(() => {
		if (!active) {
			setList(null);
			return;
		}
		let cancelled = false;
		const read = () => {
			readAgentBackgroundWork(workspaceId, sessionId).then(
				(next) => {
					if (!cancelled) setList(next);
				},
				() => {
					if (!cancelled) setList(null);
				},
			);
		};
		read();
		const timer = setInterval(read, BACKGROUND_WORK_REFRESH_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [active, workspaceId, sessionId]);

	const summary = active && list ? backgroundWorkSummary(list) : null;
	if (!list || !summary) return null;
	const hidden = backgroundWorkHiddenCount(list);
	return (
		<section
			aria-label={t("agents.backgroundWork.label")}
			className="shrink-0 border-t border-glass-hairline px-3 py-1.5 text-xs text-muted-foreground"
		>
			<ChatDisclosure disclosureKey={`background-work:${sessionId}`}>
				{(expanded) => (
					<>
						<summary
							className="flex cursor-pointer list-none items-center gap-2 select-none"
							title={t(
								expanded
									? "agents.backgroundWork.collapse"
									: "agents.backgroundWork.expand",
							)}
						>
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-full bg-emerald-500"
							/>
							<span>{summary}</span>
							<span aria-hidden className="ml-auto">
								{expanded ? "▾" : "▴"}
							</span>
						</summary>
						{expanded ? (
							<ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
								{backgroundWorkRows(list, now()).map((row) => (
									<li
										key={`${row.kind}:${row.id}`}
										className="grid grid-cols-[minmax(0,1fr)_4.5rem_2.5rem_3.5rem_3.5rem] items-center gap-2"
									>
										<span className="truncate text-foreground">
											{row.label}
										</span>
										<span className="h-1 overflow-hidden rounded-full bg-muted">
											{row.progress === null ? null : (
												<span
													className="block h-full bg-primary"
													style={{
														width: `${Math.round(row.progress * 100)}%`,
													}}
												/>
											)}
										</span>
										<span className="text-right">{row.steps}</span>
										<span className="text-right">{row.elapsed}</span>
										<span className="text-right">{row.tokens}</span>
									</li>
								))}
								{hidden > 0 ? (
									<li>{t("agents.backgroundWork.more", { n: hidden })}</li>
								) : null}
							</ul>
						) : null}
					</>
				)}
			</ChatDisclosure>
		</section>
	);
}

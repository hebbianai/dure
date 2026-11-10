import { useEffect, useState } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import {
	BACKGROUND_WORK_REFRESH_MS,
	backgroundWorkHiddenCount,
	backgroundWorkRows,
	backgroundWorkSummary,
} from "@/lib/agents/chat/backgroundWork";
import { t } from "@/lib/i18n";
import {
	type BackgroundWorkList,
	readAgentBackgroundWork,
} from "@/lib/ipc/conversations";

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
		setList(null);
		if (!active) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = () => {
			readAgentBackgroundWork(workspaceId, sessionId)
				.then(
					(next) => {
						if (!cancelled) setList(next);
					},
					() => {
						if (!cancelled) setList(null);
					},
				)
				.finally(() => {
					if (!cancelled) timer = setTimeout(read, BACKGROUND_WORK_REFRESH_MS);
				});
		};
		read();
		return () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [active, workspaceId, sessionId]);

	const summary = active && list ? backgroundWorkSummary(list) : null;
	if (!list || !summary) return null;
	const hidden = backgroundWorkHiddenCount(list);
	return (
		<section
			aria-label={t("agents.backgroundWork.label")}
			className="shrink-0 border-t border-glass-hairline px-3 py-1.5 text-muted-foreground"
		>
			<Disclosure
				label={
					<span className="inline-flex items-center gap-2 font-normal text-muted-foreground">
						<span
							aria-hidden
							className="size-1.5 shrink-0 rounded-full bg-status-run"
						/>
						{summary}
					</span>
				}
				bodyClassName="max-h-48 overflow-y-auto"
			>
				<ul className="space-y-0.5 font-mono text-[11px]">
					{backgroundWorkRows(list, now()).map((row) => (
						<li
							key={`${row.kind}:${row.id}`}
							className="grid grid-cols-[minmax(0,1fr)_4.5rem_2.5rem_3.5rem_3.5rem] items-center gap-2"
						>
							<span className="truncate text-foreground">{row.label}</span>
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
			</Disclosure>
		</section>
	);
}

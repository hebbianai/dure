import { useSyncExternalStore } from "react";
import { FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { restoreAllManagedAgents } from "@/lib/sessions/managed/managedRestoreAll";
import {
	dismissRestoreAll,
	getRestoreAllState,
	type RestoreAllAgentEntry,
	type RestoreAllSkipReason,
	type RestoreAllState,
	subscribeRestoreAll,
} from "@/lib/sessions/managed/managedRestoreAllOffer";

/** Rows listed before the rest are summarized as a count. */
const LISTED_ROWS = 4;

export function useRestoreAllState(): RestoreAllState {
	return useSyncExternalStore(subscribeRestoreAll, getRestoreAllState);
}

function reasonText(reason: RestoreAllSkipReason | "failed"): string {
	switch (reason) {
		case "runtime_generation_changed":
			return t("agents.restoreAll.reason.sessionReplaced");
		case "transition_in_progress":
			return t("agents.restoreAll.reason.accountSwitch");
		case "no_conversation_id":
			return t("agents.restoreAll.reason.noConversation");
		case "provider_without_exact_resume":
			return t("agents.restoreAll.reason.noExactResume");
		case "pane_missing":
			return t("agents.restoreAll.reason.notOpen");
		case "pane_ambiguous":
			return t("agents.restoreAll.reason.openTwice");
		case "worktree_missing":
			return t("agents.restoreAll.reason.worktreeMissing", {
				action: t("terminal.recovery.recreateWorktree"),
			});
		case "state_changed":
			return t("agents.restoreAll.reason.changed");
		case "failed":
			return t("agents.restoreAll.reason.failed");
	}
}

function AgentRows({
	rows,
}: {
	rows: readonly (RestoreAllAgentEntry & {
		reason: RestoreAllSkipReason | "failed";
	})[];
}) {
	if (rows.length === 0) return null;
	const listed = rows.slice(0, LISTED_ROWS);
	return (
		<ul className="mt-3 space-y-1.5 text-xs">
			{listed.map((row) => (
				<li key={row.identity}>
					<span className="font-medium text-foreground">{row.name}</span>
					<span className="text-muted-foreground">
						{" — "}
						{reasonText(row.reason)}
					</span>
				</li>
			))}
			{rows.length > listed.length ? (
				<li className="text-muted-foreground">
					{t("agents.restoreAll.more", {
						count: rows.length - listed.length,
					})}
				</li>
			) : null}
		</ul>
	);
}

function notRestoredText(count: number): string {
	if (count === 0) return t("agents.restoreAll.allRestored");
	return count === 1
		? t("agents.restoreAll.notRestoredOne")
		: t("agents.restoreAll.notRestoredMany", { count });
}

function reportTitle(state: Extract<RestoreAllState, { phase: "report" }>) {
	if (state.unavailable) return t("agents.restoreAll.unavailableTitle");
	if (state.restored.length === 0) return t("agents.restoreAll.noneRestored");
	const count = state.restored.length;
	return count === 1
		? t("agents.restoreAll.restoredOne")
		: t("agents.restoreAll.restoredMany", { count });
}

/** One action for every agent whose Host ended while its Space was not on
 * screen (#419). Visible panes restore on their own; this card restores the
 * rest after one click and lists any agent it can't, with the reason. Shown
 * in the main window's notice corner; `hidden` keeps it out of the way of a
 * modal or a notice that outranks it (Toaster decides). */
export function RestoreAllAgentsNotice({
	hidden = false,
}: {
	hidden?: boolean;
}) {
	const state = useRestoreAllState();
	if (hidden || state.phase === "idle") return null;
	return (
		<div className="fixed right-5 bottom-5 z-[100] w-[min(24rem,calc(100vw-2.5rem))]">
			<section
				aria-labelledby="restore-all-agents-title"
				className={`pointer-events-auto p-4 text-foreground ${FLOATING_CARD}`}
			>
				{state.phase === "offer" ? (
					<>
						<h2
							id="restore-all-agents-title"
							className="text-base font-semibold"
						>
							{state.restorable.length === 1
								? t("agents.restoreAll.offerTitleOne")
								: t("agents.restoreAll.offerTitleMany", {
										count: state.restorable.length,
									})}
						</h2>
						<p className="mt-3 text-sm text-muted-foreground">
							{t("agents.restoreAll.offerBody")}
						</p>
						{state.skipped.length > 0 ? (
							<p className="mt-3 text-xs font-medium text-muted-foreground">
								{t("agents.restoreAll.notRestorable")}
							</p>
						) : null}
						<AgentRows rows={state.skipped} />
						<div className="mt-4 flex flex-wrap items-center gap-2">
							<Button
								type="button"
								size="sm"
								onClick={() => void restoreAllManagedAgents()}
							>
								{t("agents.restoreAll.restore")}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={dismissRestoreAll}
							>
								{t("agents.restoreAll.notNow")}
							</Button>
						</div>
					</>
				) : state.phase === "restoring" ? (
					<>
						<h2
							id="restore-all-agents-title"
							className="text-base font-semibold"
						>
							{t("agents.restoreAll.restoringTitle")}
						</h2>
						<p
							role="status"
							aria-live="polite"
							className="mt-3 text-sm text-muted-foreground"
						>
							{state.total > 0
								? t("agents.restoreAll.progress", {
										done: state.done,
										total: state.total,
									})
								: t("agents.restoreAll.checking")}
						</p>
					</>
				) : (
					<>
						<h2
							id="restore-all-agents-title"
							className="text-base font-semibold"
						>
							{reportTitle(state)}
						</h2>
						<p
							role="status"
							aria-live="polite"
							className="mt-3 text-sm text-muted-foreground"
						>
							{state.unavailable
								? t("agents.restoreAll.unavailableBody")
								: notRestoredText(state.failed.length + state.skipped.length)}
						</p>
						<AgentRows
							rows={[
								...state.failed.map((entry) => ({
									...entry,
									reason: "failed" as const,
								})),
								...state.skipped,
							]}
						/>
						<div className="mt-4 flex flex-wrap items-center gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={dismissRestoreAll}
							>
								{t("common.close")}
							</Button>
						</div>
					</>
				)}
			</section>
		</div>
	);
}

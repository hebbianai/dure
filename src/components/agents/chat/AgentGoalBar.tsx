import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentGoalUpdateV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";

export function AgentGoalBar({
	session,
	disabled = false,
}: {
	session: AgentChatSessionView;
	disabled?: boolean;
}) {
	const pro = useInterfaceMode() === "pro";
	const [draft, setDraft] = useState<AgentGoalUpdateV1>();
	const goal = session.page?.goal;
	const busy =
		disabled ||
		session.savingGoal ||
		session.reconnecting ||
		session.phase !== "ready";
	const revision = goal?.revision ?? 0;
	const changed = draft !== undefined && draft.expectedRevision !== revision;
	if (!pro && !goal) return null;
	async function save(update: AgentGoalUpdateV1) {
		if (await session.putGoal(update)) setDraft(undefined);
	}
	return (
		<section
			aria-label={t("agents.goal.label")}
			className="shrink-0 border-t border-glass-hairline px-3 py-2 text-xs"
		>
			<div className="flex items-center gap-2">
				{goal ? (
					<>
						<span className="shrink-0 text-muted-foreground">
							{t(`agents.goal.status.${goal.status}`)}
						</span>
						<p className="min-w-0 flex-1 truncate" title={goal.objective}>
							{goal.objective}
						</p>
						{pro && !draft && (
							<Button
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									setDraft({
										objective: goal.objective,
										status: goal.status,
										expectedRevision: revision,
									})
								}
							>
								{t("agents.goal.edit")}
							</Button>
						)}
						{(pro || goal.status === "active") && (
							<Button
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									void session.putGoal({
										objective: goal.objective,
										status: goal.status === "active" ? "paused" : "active",
										expectedRevision: revision,
									})
								}
							>
								{t(
									goal.status === "active"
										? "agents.goal.pause"
										: "agents.goal.resume",
								)}
							</Button>
						)}
					</>
				) : (
					!draft && (
						<Button
							size="xs"
							variant="ghost"
							disabled={busy}
							onClick={() =>
								setDraft({
									objective: "",
									status: "active",
									expectedRevision: 0,
								})
							}
						>
							{t("agents.goal.set")}
						</Button>
					)
				)}
			</div>
			{goal?.detail && (
				<p className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
					{goal.detail}
				</p>
			)}
			{pro && draft && (
				<form
					className="mt-2 space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void save({
							...draft,
							expectedRevision: changed ? revision : draft.expectedRevision,
						});
					}}
				>
					<Textarea
						aria-label={t("agents.goal.objective")}
						placeholder={t("agents.goal.hint")}
						value={draft.objective}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, objective: event.target.value })
						}
					/>
					{changed && (
						<p role="status" className="whitespace-pre-wrap break-words">
							{t("agents.goal.changed")} {goal?.objective}
						</p>
					)}
					<div className="flex gap-2">
						<Button size="xs" type="submit" disabled={busy}>
							{t(changed ? "agents.goal.applyChanges" : "agents.goal.save")}
						</Button>
						<Button
							size="xs"
							variant="ghost"
							type="button"
							disabled={session.savingGoal}
							onClick={() => setDraft(undefined)}
						>
							{t("common.cancel")}
						</Button>
					</div>
				</form>
			)}
			{session.goalError && (
				<p
					role="alert"
					className="mt-2 whitespace-pre-wrap break-words text-destructive"
				>
					{session.goalError}
				</p>
			)}
		</section>
	);
}

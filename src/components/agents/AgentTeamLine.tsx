import { useMemo, useState } from "react";
import { AgentRow, agentRowManagedText } from "@/components/agents/AgentRow";
import {
	useAgentManagedSummary,
	useAgentRelations,
} from "@/components/agents/useAgentRelations";
import {
	type AgentRowPlacement,
	useAgentRowFacts,
} from "@/components/agents/useAgentRowFacts";
import {
	useAgentRevealSpaceNames,
	useNextUp,
} from "@/components/agents/useNextUp";
import { Disclosure } from "@/components/ui/disclosure";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import {
	type NextUpEntry,
	nextUpEntries,
	nextUpRowPlacement,
} from "@/lib/agents/nextUp";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import { agentTeamMembers } from "@/lib/agents/relations/agentTeam";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isMainWindow } from "@/lib/workspace/window/windows";

/** What an agent manages, folded to one line in its conversation. Unfolded,
 * it lists the agents it manages directly, each with what they manage in
 * turn, then anyone further down a person is needed for, with the path from
 * here. Everything comes from the shared relation build, the needs-person
 * map and Next up's order; the line reads nothing and runs no timer of its
 * own. Like Next up it belongs to the main window, which observes attention
 * and has the Spaces a row leads to. */
export function AgentTeamLine({ agentId }: { agentId: string }) {
	return isMainWindow() ? <MainWindowTeamLine agentId={agentId} /> : null;
}

function MainWindowTeamLine({ agentId }: { agentId: string }) {
	const managed = useAgentManagedSummary(agentId);
	// The fold is this view's own; nothing is persisted or acknowledged.
	const [open, setOpen] = useState(false);
	if (!managed) return null;
	return (
		<section
			aria-label={t("agents.team.label")}
			data-slot="agent-team-line"
			className="shrink-0 border-t border-glass-hairline px-3 py-1.5 text-muted-foreground"
		>
			<Disclosure
				onToggle={(event) => setOpen(event.currentTarget.open)}
				label={
					<span className="inline-flex items-center gap-2 font-normal text-muted-foreground">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								managed.needsPerson > 0
									? "bg-status-blocked"
									: managed.working > 0
										? "bg-status-warn"
										: "bg-muted-foreground/60",
							)}
						/>
						{agentRowManagedText(managed)}
					</span>
				}
				bodyClassName="max-h-48 overflow-y-auto"
			>
				{open && <AgentTeamRows agentId={agentId} />}
			</Disclosure>
		</section>
	);
}

/** Mounted only while unfolded, so a folded line subscribes to no row. */
function AgentTeamRows({ agentId }: { agentId: string }) {
	const relations = useAgentRelations();
	const nextUp = useNextUp();
	const members = useMemo(
		() =>
			agentTeamMembers(
				relations,
				agentId,
				nextUp.needsYou.map((entry) => entry.agentId),
			),
		[relations, agentId, nextUp],
	);
	const listed = useMemo(
		() => new Map(nextUpEntries(nextUp).map((entry) => [entry.agentId, entry])),
		[nextUp],
	);
	const displayStates = useAgentAttention((state) => state.displayStates);
	const spaceNames = useAgentRevealSpaceNames(members);
	return (
		<ul className="flex flex-col">
			{members.map((memberId) => (
				<AgentTeamRow
					key={memberId}
					agentId={memberId}
					placement={teamRowPlacement(
						listed.get(memberId),
						displayStates[memberId],
						spaceNames.get(memberId),
						agentId,
					)}
				/>
			))}
		</ul>
	);
}

/** A member's place on the line: why Next up lists it, if it does, and
 * otherwise only its state, with its path from the agent the line is on. */
function teamRowPlacement(
	entry: NextUpEntry | undefined,
	state: AgentRowPlacement["state"],
	spaceName: string | undefined,
	below: string,
): AgentRowPlacement {
	return {
		...(entry ? nextUpRowPlacement(entry) : state ? { state } : {}),
		...(spaceName ? { spaceName } : {}),
		below,
	};
}

function AgentTeamRow({
	agentId,
	placement,
}: {
	agentId: string;
	placement: AgentRowPlacement;
}) {
	const facts = useAgentRowFacts(agentId, placement);
	if (!facts) return null;
	return (
		<li>
			<AgentRow
				row={agentRowModel(facts)}
				variant="line"
				onSelect={revealAgent}
			/>
		</li>
	);
}

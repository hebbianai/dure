import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
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
import { FoldLine } from "@/components/ui/fold-line";
import { StatusDot } from "@/components/ui/status-dot";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	type AgentRowManagedUrgency,
	agentRowManagedUrgency,
	agentRowModel,
} from "@/lib/agents/agentRowModel";
import {
	type NextUpEntry,
	nextUpEntries,
	nextUpRowPlacement,
} from "@/lib/agents/nextUp";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import { agentTeamMembers } from "@/lib/agents/relations/agentTeam";
import { t } from "@/lib/i18n";
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
	// The fold is this view's own; nothing is persisted or acknowledged.
	const [open, setOpen] = useState(false);
	return (
		<AgentManagedFold
			agentId={agentId}
			slot="agent-team-line"
			open={open}
			onOpenChange={setOpen}
			bodyClassName="max-h-48 overflow-y-auto"
		>
			<AgentTeamRows agentId={agentId} />
		</AgentManagedFold>
	);
}

/** The dot beside a team's summary, by its most urgent member. A quiet team
 * is softer than a muted dot elsewhere: nothing below needs anything. */
const MANAGED_DOT: Record<
	AgentRowManagedUrgency,
	Pick<ComponentProps<typeof StatusDot>, "tone" | "className">
> = {
	needs_person: { tone: "blocked" },
	working: { tone: "warn" },
	quiet: { tone: "muted", className: "bg-muted-foreground/60" },
};

/** What an agent manages, folded to one line under a hairline: a dot for the
 * most urgent of them and the words every row uses for it. Unfolded, it holds
 * the caller's rows, mounted only while open so a folded line subscribes to
 * no row. Whether it is open is the caller's. Absent when it manages none. */
export function AgentManagedFold({
	agentId,
	slot,
	open,
	onOpenChange,
	bodyClassName,
	children,
}: {
	agentId: string;
	/** The `data-slot` that tells the surfaces holding the fold apart. */
	slot: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Caps the unfolded rows, which scroll under the line. */
	bodyClassName: string;
	children: ReactNode;
}) {
	const managed = useAgentManagedSummary(agentId);
	if (!managed) return null;
	return (
		<FoldLine
			aria-label={t("agents.team.label")}
			data-slot={slot}
			dot={<StatusDot {...MANAGED_DOT[agentRowManagedUrgency(managed)]} />}
			summary={agentRowManagedText(managed)}
			open={open}
			onOpenChange={onOpenChange}
			bodyClassName={bodyClassName}
		>
			{open && children}
		</FoldLine>
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

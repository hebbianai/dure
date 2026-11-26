import { useId } from "react";
import { useAgentRelations } from "@/components/agents/useAgentRelations";
import { useAgentRevealSpaceNames } from "@/components/agents/useNextUp";
import { WorkAgentRow } from "@/components/work/WorkList";
import { t } from "@/lib/i18n";

/** The agents this one manages directly, in start order, each with what it
 * manages in turn. Selecting one drills into it, the same way at every
 * depth. Absent when it manages none. */
export function WorkManagedList({
	agentId,
	dayStart,
	selected,
	onSelect,
}: {
	agentId: string;
	/** Start of the local day: the Work view's result window. */
	dayStart: number;
	selected: string | null;
	onSelect: (agentId: string) => void;
}) {
	const headingId = useId();
	const relations = useAgentRelations();
	// The relation build keeps each list, so it is stable while the forest is.
	const managed = relations.managedBy(agentId);
	const spaceNames = useAgentRevealSpaceNames(managed, "pane");
	if (managed.length === 0) return null;
	return (
		<section
			aria-labelledby={headingId}
			data-slot="work-managed"
			className="max-h-[35%] shrink-0 overflow-y-auto border-t border-glass-hairline px-1.5 py-1"
		>
			<h3
				id={headingId}
				className="flex h-6 items-center px-2 text-meta font-medium text-muted-foreground"
			>
				{t("agents.team.label")}
			</h3>
			<ul>
				{managed.map((childId) => (
					<li key={childId}>
						<WorkAgentRow
							agentId={childId}
							under={agentId}
							spaceName={spaceNames.get(childId)}
							dayStart={dayStart}
							selected={selected === childId}
							onSelect={onSelect}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

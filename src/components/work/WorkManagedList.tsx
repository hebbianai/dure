import { AgentManagedFold } from "@/components/agents/AgentManagedFold";
import { useAgentRelations } from "@/components/agents/useAgentRelations";
import { useAgentRevealSpaceNames } from "@/components/agents/useNextUp";
import { WorkAgentRow } from "@/components/work/WorkList";
import { useWorkViewStore } from "@/lib/work/workViewStore";

/** The rows' cap: a third of the agent detail (its size container), less
 * the fold line above them and the Conversation label below, two pane lines
 * of 31px and the 4px gap before the rows, so all three stay within that
 * third at any window size. The rows hang their own 8px inset into the
 * gutter, so each row's dot stands on the labels' edge. */
const MANAGED_ROWS = "-ml-2 max-h-[calc(35cqh_-_4.125rem)]";

/** The agents this one manages directly, in start order, each with what it
 * manages in turn, under the fold line that sums up its whole team. Selecting
 * one drills into it, the same way at every depth. The fold is one setting
 * for every column, and unfolded the rows scroll within a third of the
 * detail so the conversation below stays in view. Absent when it manages
 * none. */
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
	const open = useWorkViewStore((state) => state.managedOpen);
	const setOpen = useWorkViewStore((state) => state.setManagedOpen);
	return (
		<AgentManagedFold
			agentId={agentId}
			slot="work-managed"
			open={open}
			onOpenChange={setOpen}
			rowsClassName={MANAGED_ROWS}
		>
			<WorkManagedRows
				agentId={agentId}
				dayStart={dayStart}
				selected={selected}
				onSelect={onSelect}
			/>
		</AgentManagedFold>
	);
}

/** Mounted only while unfolded, so a folded list subscribes to no row. */
function WorkManagedRows({
	agentId,
	dayStart,
	selected,
	onSelect,
}: {
	agentId: string;
	dayStart: number;
	selected: string | null;
	onSelect: (agentId: string) => void;
}) {
	const relations = useAgentRelations();
	// The relation build keeps each list, so it is stable while the forest is.
	const managed = relations.managedBy(agentId);
	const spaceNames = useAgentRevealSpaceNames(managed, "pane");
	return (
		<ul>
			{managed.map((childId) => (
				<li key={childId}>
					<WorkAgentRow
						agentId={childId}
						under={agentId}
						spaceName={spaceNames.get(childId)}
						dayStart={dayStart}
						variant="compact"
						selected={selected === childId}
						onSelect={onSelect}
					/>
				</li>
			))}
		</ul>
	);
}

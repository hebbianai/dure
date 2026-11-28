import type { ComponentProps, ReactNode } from "react";
import { agentRowManagedText } from "@/components/agents/AgentRow";
import { useAgentManagedSummary } from "@/components/agents/useAgentRelations";
import { FoldLine } from "@/components/ui/pane-line";
import { StatusDot } from "@/components/ui/status-dot";
import {
	type AgentRowManagedUrgency,
	agentRowManagedUrgency,
} from "@/lib/agents/agentRowModel";
import { t } from "@/lib/i18n";

/** The dot before a team's summary, by its most urgent member. A quiet team
 * has none: the words already say what it manages. */
const MANAGED_DOT: Record<
	AgentRowManagedUrgency,
	Pick<ComponentProps<typeof StatusDot>, "tone"> | null
> = {
	needs_person: { tone: "blocked" },
	working: { tone: "warn" },
	quiet: null,
};

/** What an agent manages, folded to one line under a hairline: the words
 * every row uses for it, after a dot when someone below needs a person or is
 * working. Unfolded, it holds the caller's rows, mounted only while open so a
 * folded line subscribes to no row. Whether it is open is the caller's.
 * Absent when it manages none. */
export function AgentManagedFold({
	agentId,
	slot,
	open,
	onOpenChange,
	rowsClassName,
	children,
}: {
	agentId: string;
	/** The `data-slot` that tells the surfaces holding the fold apart. */
	slot: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Merged over the fold's own cap on its rows. */
	rowsClassName?: string;
	children: ReactNode;
}) {
	const managed = useAgentManagedSummary(agentId);
	if (!managed) return null;
	const dot = MANAGED_DOT[agentRowManagedUrgency(managed)];
	return (
		<FoldLine
			aria-label={t("agents.team.label")}
			data-slot={slot}
			dot={dot && <StatusDot {...dot} />}
			summary={agentRowManagedText(managed)}
			open={open}
			onOpenChange={onOpenChange}
			rowsClassName={rowsClassName}
		>
			{open && children}
		</FoldLine>
	);
}

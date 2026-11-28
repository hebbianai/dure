import { useMemo } from "react";
import { useAgentRelations } from "@/components/agents/useAgentRelations";
import { useAgentRowTitles } from "@/components/agents/useAgentRowFacts";
import type { AgentRelationSource } from "@/lib/agents/relations/agentRelations";
import { t } from "@/lib/i18n";

const CRUMB_CLASS =
	"min-w-0 truncate rounded-sm text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring";

/** The agents above this one, outermost first, as the relation owner chains
 * them — the outermost may be the plain shell its Run was started in. Each
 * crumb selects its row. A top-level agent has no breadcrumb. */
export function WorkBreadcrumb({
	agentId,
	onSelect,
}: {
	agentId: string;
	onSelect: (agentId: string) => void;
}) {
	const relations = useAgentRelations();
	const chain = useMemo(() => relations.chain(agentId), [relations, agentId]);
	const titles = useAgentRowTitles(chain);
	if (chain.length === 0) return null;
	return (
		<nav aria-label={t("work.detail.managers")} className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1 text-meta leading-4">
				{chain.map((managerId, index) => (
					<li key={managerId} className="flex min-w-0 items-center gap-1">
						{index > 0 && (
							<span aria-hidden className="text-muted-foreground">
								›
							</span>
						)}
						<button
							type="button"
							className={CRUMB_CLASS}
							onClick={() => onSelect(managerId)}
						>
							{titles[index] ?? managerId}
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}

const SOURCE_KEY: Record<AgentRelationSource, string> = {
	run_parent_agent: "work.detail.relationSource.runParentAgent",
	run_parent_session: "work.detail.relationSource.runParentSession",
	run_parent_recorded: "work.detail.relationSource.runParentRecorded",
	run_parent_shell: "work.detail.relationSource.runParentShell",
	computer_reported: "work.detail.relationSource.computerReported",
};

/** Every other agent a fact says manages this one, beside the display
 * manager the breadcrumb follows, with where the fact comes from. That
 * includes a fact set aside to break a cycle. Each one selects its agent. */
export function WorkAlsoManagedBy({
	agentId,
	onSelect,
}: {
	agentId: string;
	onSelect: (agentId: string) => void;
}) {
	const relations = useAgentRelations();
	const others = useMemo(() => {
		const display = relations.managerOf(agentId);
		return relations
			.managersOf(agentId)
			.filter((edge) => edge.manager !== display);
	}, [relations, agentId]);
	const managerIds = useMemo(
		() => others.map((edge) => edge.manager),
		[others],
	);
	const titles = useAgentRowTitles(managerIds);
	if (others.length === 0) return null;
	return (
		<p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta leading-4 text-muted-foreground">
			<span>{t("work.detail.alsoManagedBy")}</span>
			{others.map((edge, index) => (
				<span key={edge.manager} className="inline-flex min-w-0 items-center gap-1">
					<button
						type="button"
						className={CRUMB_CLASS}
						onClick={() => onSelect(edge.manager)}
					>
						{titles[index] ?? edge.manager}
					</button>
					<span>({t(SOURCE_KEY[edge.source])})</span>
				</span>
			))}
		</p>
	);
}

import { useEffect, useMemo, useRef } from "react";
import { useLocalDayTick } from "@/components/spaces/useNowTick";
import { WorkDetailColumn, WorkDetailEmpty } from "@/components/work/WorkDetail";
import { WorkList } from "@/components/work/WorkList";
import { WindowContentPainted } from "@/components/workspace/WindowContentPainted";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { workDetailColumns } from "@/lib/work/workViewState";
import { useWorkViewStore } from "@/lib/work/workViewStore";

/** The Work view in the main area, in front of the Spaces deck (which stays
 * mounted behind it). With the sidebar collapsed it carries the Work list
 * itself. Beside it stand the detail columns: the pinned agents in the
 * person's order, then the selection. */
export function WorkMain() {
	const sidebarOpen = useWindowSidebarStore((state) => state.open);
	return (
		<div
			data-slot="work-main"
			className="pane-card-surface absolute inset-0 flex overflow-hidden rounded-[var(--glass-radius-pane)] bg-glass-pane"
		>
			{!sidebarOpen && (
				<WorkList className="w-72 shrink-0 border-r border-glass-hairline pt-1" />
			)}
			<WorkDetail />
			{/* While Work is in front, it is what this window exists to show. */}
			<WindowContentPainted />
		</div>
	);
}

function WorkDetail() {
	const selected = useWorkViewStore((state) => state.selected);
	const pinned = useWorkViewStore((state) => state.pinned);
	const columns = useMemo(
		() => workDetailColumns({ selected, pinned }),
		[selected, pinned],
	);
	const dayStart = useLocalDayTick();
	const scroller = useRef<HTMLDivElement>(null);
	// A selected agent that already has a column is brought into view there.
	useEffect(() => {
		if (selected === null) return;
		scroller.current
			?.querySelector<HTMLElement>(`[data-work-column="${CSS.escape(selected)}"]`)
			?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [selected]);
	return (
		<section
			data-slot="work-detail"
			aria-label={t("work.detail.label")}
			className="flex min-w-0 flex-1"
		>
			{columns.length === 0 ? (
				<WorkDetailEmpty />
			) : (
				<div ref={scroller} className="flex min-w-0 flex-1 overflow-x-auto">
					{columns.map((column) => (
						<WorkDetailColumn
							key={column.key}
							column={column}
							alone={columns.length === 1}
							dayStart={dayStart}
						/>
					))}
				</div>
			)}
		</section>
	);
}

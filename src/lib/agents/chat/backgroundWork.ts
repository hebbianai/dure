import { t } from "@/lib/i18n";
import type {
	BackgroundWorkKind,
	BackgroundWorkList,
} from "@/lib/ipc/conversations";

export interface BackgroundWorkRow {
	id: string;
	kind: BackgroundWorkKind;
	label: string;
	/** 0..1 when the provider recorded steps; no bar otherwise. */
	progress: number | null;
	steps: string | null;
	elapsed: string;
	tokens: string | null;
}

const KIND_COPY: Record<BackgroundWorkKind, string> = {
	subagent: "agents.backgroundWork.kind.subagent",
	workflow: "agents.backgroundWork.kind.workflow",
	shell: "agents.backgroundWork.kind.shell",
	monitor: "agents.backgroundWork.kind.monitor",
};

/** The collapsed line, or null when nothing runs and the line is hidden.
 * Subagents and workflows count as "running", as the terminal shows them;
 * shells and monitors follow with their own counts. */
export function backgroundWorkSummary(list: BackgroundWorkList): string | null {
	const { subagents, workflows, shells, monitors } = list.counts;
	const parts: string[] = [];
	if (subagents + workflows > 0) {
		parts.push(
			t("agents.backgroundWork.running", { n: subagents + workflows }),
		);
	}
	if (shells > 0) {
		parts.push(
			shells === 1
				? t("agents.backgroundWork.shells.one")
				: t("agents.backgroundWork.shells.other", { n: shells }),
		);
	}
	if (monitors > 0) {
		parts.push(
			monitors === 1
				? t("agents.backgroundWork.monitors.one")
				: t("agents.backgroundWork.monitors.other", { n: monitors }),
		);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function backgroundWorkRows(
	list: BackgroundWorkList,
	nowMs: number,
): BackgroundWorkRow[] {
	return list.items.map((item) => {
		const steps = item.steps && item.steps.total > 0 ? item.steps : null;
		return {
			id: item.id,
			kind: item.kind,
			label: item.label || t(KIND_COPY[item.kind]),
			progress: steps ? Math.min(1, steps.done / steps.total) : null,
			steps: steps ? `${steps.done}/${steps.total}` : null,
			elapsed: formatElapsed(nowMs - item.startedUnixMs),
			tokens: item.tokens == null ? null : formatTokens(item.tokens),
		};
	});
}

/** Items a truncated list counted but did not carry. */
export function backgroundWorkHiddenCount(list: BackgroundWorkList): number {
	const { subagents, workflows, shells, monitors } = list.counts;
	return Math.max(
		0,
		subagents + workflows + shells + monitors - list.items.length,
	);
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

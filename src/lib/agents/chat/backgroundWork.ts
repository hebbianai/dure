import type { ProviderConversationSubagent } from "@/lib/agents/providerConversationDiscovery";
import { t } from "@/lib/i18n";
import type {
	BackgroundWorkKind,
	BackgroundWorkList,
} from "@/lib/ipc/conversations";
import type { AgentRuntimeBindingV1 } from "@/types";

/** How long a view of the background work waits after one read before the
 * next, while something runs. Background work moves without turns, so the
 * transcript's refresh cursor cannot drive it; reads are incremental on the
 * desktop, and one at a time, so a slow read never piles up behind the next. */
export const BACKGROUND_WORK_REFRESH_MS = 10_000;

/** The session the desktop reads an agent's background work for. */
export interface BackgroundWorkSession {
	workspaceId: string;
	sessionId: string;
}

/** The agent's own local managed session, or null: the desktop reads
 * background work only for those, behind their Host's facts. */
export function backgroundWorkSession(
	binding: AgentRuntimeBindingV1 | undefined,
): BackgroundWorkSession | null {
	return binding?.runtime === "hmux_managed_v1" && binding.source === "local"
		? { workspaceId: binding.workspaceId, sessionId: binding.sessionId }
		: null;
}

/** Subagent rows as the chat line sees them. A row runs exactly when the
 * line's list names it: by its agent id, or by the call that started it
 * while the turn still waits on it. The rows' own records never say
 * "running", so a row the list leaves out keeps what its records say: done,
 * failed, or unknown. Without a list (no session, or the read failed) the
 * rows are the records. */
export function subagentsAsBackgroundWork(
	subagents: readonly ProviderConversationSubagent[],
	list: BackgroundWorkList | null,
): ProviderConversationSubagent[] {
	const running = new Set(
		list?.items
			.filter((item) => item.kind === "subagent")
			.map((item) => item.id) ?? [],
	);
	return subagents.map((subagent) => {
		const agentId = subagent.id.replace(/^agent-/, "");
		const named =
			running.has(agentId) ||
			running.has(subagent.id) ||
			(subagent.toolUseId !== undefined && running.has(subagent.toolUseId));
		return named ? { ...subagent, status: "running" } : subagent;
	});
}

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

import { t } from "./i18n";

/**
 * The computer's answer to `AgentBackgroundWorkV1`: the agent's running
 * subagents, workflows, shells and monitors, decided on the computer from the
 * provider's records behind the Host's facts. The phone only renders it.
 */
export interface BackgroundWorkItem {
  id: string;
  /** `subagent`, `workflow`, `shell`, `monitor`, or a kind a newer computer sends. */
  kind: string;
  /** The model-written description; never a command. */
  label?: string;
  started_unix_ms: number;
  steps?: { done: number; total: number };
  tokens?: number;
}

export interface BackgroundWorkAnswer {
  hub_conversation_version: number;
  outcome: "listed" | "refused";
  items?: BackgroundWorkItem[];
  counts?: {
    subagents: number;
    workflows: number;
    shells: number;
    monitors: number;
  };
  truncated?: boolean;
  code?: string;
  detail?: string;
}

export interface BackgroundWorkRow {
  id: string;
  kind: string;
  label: string;
  /** 0..1 when the provider recorded steps; no bar otherwise. */
  progress: number | null;
  steps: string | null;
  elapsed: string;
  tokens: string | null;
}

const KIND_COPY: Record<string, string> = {
  subagent: "chat.backgroundWork.kind.subagent",
  workflow: "chat.backgroundWork.kind.workflow",
  shell: "chat.backgroundWork.kind.shell",
  monitor: "chat.backgroundWork.kind.monitor",
};

function counts(answer: BackgroundWorkAnswer) {
  const zero = { subagents: 0, workflows: 0, shells: 0, monitors: 0 };
  return answer.outcome === "listed" ? { ...zero, ...answer.counts } : zero;
}

/** The collapsed line, or null when nothing runs and the line is hidden. */
export function backgroundWorkSummary(
  answer: BackgroundWorkAnswer,
): string | null {
  const { subagents, workflows, shells, monitors } = counts(answer);
  const parts: string[] = [];
  if (subagents + workflows > 0) {
    parts.push(t("chat.backgroundWork.running", { n: subagents + workflows }));
  }
  if (shells > 0) {
    parts.push(
      shells === 1
        ? t("chat.backgroundWork.shells.one")
        : t("chat.backgroundWork.shells.other", { n: shells }),
    );
  }
  if (monitors > 0) {
    parts.push(
      monitors === 1
        ? t("chat.backgroundWork.monitors.one")
        : t("chat.backgroundWork.monitors.other", { n: monitors }),
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function backgroundWorkRows(
  answer: BackgroundWorkAnswer,
  nowMs: number,
): BackgroundWorkRow[] {
  if (answer.outcome !== "listed") return [];
  return (answer.items ?? []).map((item) => {
    const steps = item.steps && item.steps.total > 0 ? item.steps : null;
    return {
      id: item.id,
      kind: item.kind,
      label:
        item.label ||
        t(KIND_COPY[item.kind] ?? "chat.backgroundWork.kind.other"),
      progress: steps ? Math.min(1, steps.done / steps.total) : null,
      steps: steps ? `${steps.done}/${steps.total}` : null,
      elapsed: formatElapsed(nowMs - item.started_unix_ms),
      tokens: item.tokens == null ? null : formatTokens(item.tokens),
    };
  });
}

/** Items a truncated list counted but did not carry. */
export function backgroundWorkHiddenCount(
  answer: BackgroundWorkAnswer,
): number {
  const { subagents, workflows, shells, monitors } = counts(answer);
  return Math.max(
    0,
    subagents + workflows + shells + monitors - (answer.items?.length ?? 0),
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
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

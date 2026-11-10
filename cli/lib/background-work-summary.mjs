/** The background work a busy refusal names: what the backend read from the
 * provider's own records for a session the Host reports busy. It is advisory;
 * the refusal itself rests on the Host's fact. Labels are model-written
 * descriptions, never commands, so they are bounded and stripped of control
 * characters here at the boundary. A malformed summary is dropped whole. */
export const MAX_BACKGROUND_WORK_ITEMS = 16;
const MAX_LABEL_LENGTH = 120;
const ID = /^[\w.:+-]{1,128}$/;
const KINDS = ["subagent", "workflow", "shell", "monitor"];
const COUNTS = { subagent: "subagents", workflow: "workflows", shell: "shells", monitor: "monitors" };

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function label(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!clean) return null;
  const chars = [...clean];
  return chars.length > MAX_LABEL_LENGTH ? `${chars.slice(0, MAX_LABEL_LENGTH - 1).join("")}…` : clean;
}

export function normalizeBackgroundWork(value) {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.counts)) return undefined;
  const counts = {};
  for (const key of Object.values(COUNTS)) {
    if (!count(value.counts[key])) return undefined;
    counts[key] = value.counts[key];
  }
  const items = [];
  for (const item of value.items.slice(0, MAX_BACKGROUND_WORK_ITEMS)) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id) ||
        !KINDS.includes(item.kind) || !count(item.startedUnixMs)) return undefined;
    items.push({ id: item.id, kind: item.kind, label: label(item.label), startedUnixMs: item.startedUnixMs });
  }
  if (items.length === 0) return undefined;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { items, counts, truncated: total > items.length };
}

/** Text lines for a normalized summary. */
export function formatBackgroundWork(work) {
  const total = Object.values(work.counts).reduce((sum, value) => sum + value, 0);
  const kinds = KINDS.flatMap((kind) => {
    const value = work.counts[COUNTS[kind]];
    return value ? [`${value} ${value === 1 ? kind : COUNTS[kind]}`] : [];
  });
  return [
    `Still running in the session${kinds.length ? ` (${kinds.join(", ")})` : ""}:`,
    ...work.items.map((item) => `  ${item.kind} ${item.id}${item.label ? `: ${item.label}` : ""}`),
    ...(total > work.items.length ? [`  …and ${total - work.items.length} more`] : []),
  ];
}

// The list behind `dure tui`: pure state, key handling and rendering. The
// terminal loop that drives it lives in session-tui.mjs.

const NEEDS_INPUT_ATTENTION = new Set(["input_required", "approval_required"]);
const HEADER_LINES = 2;
const FOOTER_LINES = 2;
const COLUMN_GAP = "  ";
const SELECTION_MARKER = "> ";
const STATE_WIDTH = "needs input".length;
const MIN_AGENT_WIDTH = 12;
const QUERY_UNAVAILABLE = "dure_session_query_unavailable";
// The narrowest terminals give these up from the end of the list first. The
// backend is kept longest: the same Session ID can run on two backends.
const OPTIONAL_COLUMNS = Object.freeze([
  { key: "backend", label: "BACKEND", width: 12 },
  { key: "project", label: "PROJECT", width: 18 },
  { key: "account", label: "ACCOUNT", width: 14 },
  { key: "provider", label: "PROVIDER", width: 8 },
]);
// Left to right after the agent.
const COLUMN_ORDER = Object.freeze(["backend", "provider", "account", "project"]);
const HELP_LINE =
  "\u2191\u2193 select \u00b7 Enter attach \u00b7 r refresh \u00b7 q quit \u00b7 Ctrl-\\ then d returns here";

const PLAIN_KEYS = new Map([
  ["\r", "enter"],
  ["\n", "enter"],
  ["\x03", "quit"],
  ["q", "quit"],
  ["r", "refresh"],
  ["j", "down"],
  ["k", "up"],
  ["g", "home"],
  ["G", "end"],
]);
const CURSOR_KEYS = new Map([
  ["A", "up"],
  ["B", "down"],
  ["H", "home"],
  ["F", "end"],
]);
const TILDE_KEYS = new Map([
  ["1", "home"],
  ["7", "home"],
  ["4", "end"],
  ["8", "end"],
  ["5", "pageUp"],
  ["6", "pageDown"],
]);
const ESCAPE_SEQUENCE = /^\x1b(?:\[([0-?]*)[ -/]*([@-~])|O([@-~]))/;
const INCOMPLETE_ESCAPE = /^\x1b(?:$|\[[0-?]*[ -/]*$|O$)/;

const WIDE_GRAPHEME =
  /\p{Emoji_Presentation}|[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const NON_PRINTING = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Names and error details can come from a remote backend, so nothing reaches
// the terminal without losing its control and bidirectional-override characters.
function terminalText(value) {
  return String(value ?? "").replace(NON_PRINTING, "");
}

function graphemeWidth(grapheme) {
  return WIDE_GRAPHEME.test(grapheme) ? 2 : 1;
}

/** Clip or pad to exactly `width` terminal cells. */
export function fitCells(value, width) {
  if (width <= 0) return "";
  const parts = Array.from(graphemes.segment(terminalText(value)), (part) => part.segment);
  const total = parts.reduce((sum, part) => sum + graphemeWidth(part), 0);
  if (total <= width) return parts.join("") + " ".repeat(width - total);
  let clipped = "";
  let used = 0;
  for (const part of parts) {
    const next = used + graphemeWidth(part);
    if (next > width - 1) break;
    clipped += part;
    used = next;
  }
  return `${clipped}\u2026${" ".repeat(width - used - 1)}`;
}

// State comes only from Host observations. A Host that cannot be reached says
// nothing about its processes, so it reads unknown rather than exited.
function agentState(session) {
  if (session.liveness.state === "exited") return "exited";
  if (session.liveness.state !== "alive") return "unknown";
  const runtime = session.runtime?.agentRuntimeState;
  if (!runtime) return "unknown";
  if (runtime.lifecycle === "exited") return "exited";
  if (NEEDS_INPUT_ATTENTION.has(runtime.attention)) return "needs input";
  if (runtime.attention === "error") return "error";
  return runtime.activity === "working" ? "working" : "idle";
}

function directoryName(path) {
  return typeof path === "string"
    ? path.split(/[\\/]+/).filter(Boolean).at(-1) ?? null
    : null;
}

function accountLabel(reference) {
  if (!reference) return "unknown";
  return reference === "provider_default" ? "default" : reference;
}

/** `profileBackends` names the backends this listing read through a backend
 * profile. A row from any other backend, or from a single-backend listing,
 * attaches the way the listing was read. */
export function agentRow(session, profileBackends = new Set()) {
  const { agents, state } = session.clientProjection;
  const current = state === "current" ? agents[0] : undefined;
  const backend = session.backendProfileId ?? null;
  return {
    key: [backend ?? "", session.workspaceId, session.sessionId].join("\u0000"),
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    backend,
    backendProfileId: profileBackends.has(backend) ? backend : null,
    state: agentState(session),
    agent:
      agents
        .map((agent) => agent.displayName ?? agent.name ?? agent.id)
        .filter(Boolean)
        .join(", ") || session.sessionId,
    provider: session.provider.id,
    account: accountLabel(current?.accountReference),
    project: current?.project ?? directoryName(session.cwd) ?? "-",
    attachable: session.liveness.state !== "exited",
  };
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Independent of state: a row must not move under the cursor when its agent
// starts or stops working.
function compareRows(left, right) {
  return (
    compareText(left.project, right.project) ||
    compareText(left.agent, right.agent) ||
    compareText(left.key, right.key)
  );
}

function clampIndex(index, rows) {
  return Math.max(0, Math.min(index, rows.length - 1));
}

export function initialTuiState({ allBackends = false } = {}) {
  return {
    allBackends,
    loaded: false,
    message: null,
    omitted: false,
    refreshError: null,
    rows: [],
    selected: 0,
    unavailableBackends: [],
  };
}

export function applySessionReport(state, report) {
  if (report.kind !== "dure.sessions.list") {
    return {
      ...state,
      loaded: true,
      refreshError: report.error?.code ?? QUERY_UNAVAILABLE,
    };
  }
  // Only a listing across backends has entries; each answered or failed alone.
  const backends = report.backends ?? [];
  const profileBackends = new Set(
    backends
      .filter((backend) => backend.source?.kind === "backend_profile")
      .map((backend) => backend.backendProfileId),
  );
  const selectedKey = state.rows[state.selected]?.key;
  const rows = report.sessions
    .map((session) => agentRow(session, profileBackends))
    .sort(compareRows);
  const kept = rows.findIndex((row) => row.key === selectedKey);
  return {
    ...state,
    loaded: true,
    omitted: report.truncation.items === true,
    refreshError: null,
    rows,
    selected: kept >= 0 ? kept : clampIndex(state.selected, rows),
    unavailableBackends: backends
      .filter((backend) => backend.status === "error")
      .map((backend) => ({
        id: backend.backendProfileId,
        code: backend.error?.code ?? QUERY_UNAVAILABLE,
      })),
  };
}

/** Decodes terminal input into key names, holding an escape sequence split
 * across reads. A bare Escape has no action, so it needs no timeout. */
export function createTuiKeyDecoder() {
  let pending = "";
  return (chunk) => {
    let input = pending + chunk.toString();
    pending = "";
    const keys = [];
    while (input.length > 0) {
      if (input[0] !== "\x1b") {
        const [character] = input;
        input = input.slice(character.length);
        if (PLAIN_KEYS.has(character)) keys.push(PLAIN_KEYS.get(character));
        continue;
      }
      const sequence = ESCAPE_SEQUENCE.exec(input);
      if (sequence) {
        const key = sequence[3]
          ? CURSOR_KEYS.get(sequence[3])
          : csiKey(sequence[1], sequence[2]);
        if (key) keys.push(key);
        input = input.slice(sequence[0].length);
      } else if (INCOMPLETE_ESCAPE.test(input)) {
        pending = input;
        break;
      } else {
        input = input.slice(1);
      }
    }
    return keys;
  };
}

function csiKey(parameters, final) {
  const [code, modifiers] = parameters.split(";");
  if (final === "~") return TILDE_KEYS.get(code);
  if (final !== "u") return CURSOR_KEYS.get(final);
  // An attached program can leave its enhanced keyboard mode switched on.
  if (code === "13") return "enter";
  return code === "99" && modifiers?.startsWith("5") ? "quit" : undefined;
}

export function listHeight(terminalRows) {
  return Math.max(1, terminalRows - HEADER_LINES - FOOTER_LINES);
}

export function applyTuiKey(state, key, pageSize) {
  const select = (index) => ({
    state: { ...state, message: null, selected: clampIndex(index, state.rows) },
  });
  switch (key) {
    case "up":
      return select(state.selected - 1);
    case "down":
      return select(state.selected + 1);
    case "pageUp":
      return select(state.selected - pageSize);
    case "pageDown":
      return select(state.selected + pageSize);
    case "home":
      return select(0);
    case "end":
      return select(state.rows.length - 1);
    case "refresh":
      return { state: { ...state, message: null }, effect: { kind: "refresh" } };
    case "quit":
      return { state, effect: { kind: "quit" } };
    case "enter": {
      const row = state.rows[state.selected];
      if (!row) return { state };
      if (!row.attachable) {
        return {
          state: { ...state, message: `${row.agent} has exited, so there is nothing to attach to.` },
        };
      }
      return { state: { ...state, message: null }, effect: { kind: "attach", row } };
    }
    default:
      return { state };
  }
}

function visibleColumns(columns, allBackends) {
  const fixed = SELECTION_MARKER.length + STATE_WIDTH + COLUMN_GAP.length + MIN_AGENT_WIDTH;
  let available = columns - fixed;
  const shown = new Map();
  for (const column of OPTIONAL_COLUMNS) {
    if (column.key === "backend" && !allBackends) continue;
    const cost = column.width + COLUMN_GAP.length;
    if (available < cost) break;
    available -= cost;
    shown.set(column.key, column);
  }
  return {
    agentWidth: MIN_AGENT_WIDTH + Math.max(0, available),
    optional: COLUMN_ORDER.filter((key) => shown.has(key)).map((key) => shown.get(key)),
  };
}

function rowText(marker, cells, layout, columns) {
  const text = [
    `${marker}${fitCells(cells.state, STATE_WIDTH)}`,
    fitCells(cells.agent, layout.agentWidth),
    ...layout.optional.map((column) => fitCells(cells[column.key], column.width)),
  ].join(COLUMN_GAP);
  return fitCells(text, columns);
}

function summary(rows) {
  const waiting = rows.filter((row) => row.state === "needs input").length;
  const agents = `${rows.length} ${rows.length === 1 ? "agent" : "agents"}`;
  return waiting > 0 ? `${agents} \u00b7 ${waiting} needs input` : agents;
}

// A backend that did not answer may still run agents, so an empty list only
// means "none" when every backend answered.
function emptyListText(state) {
  if (!state.loaded) return "Loading agents\u2026";
  if (state.refreshError || state.unavailableBackends.length > 0) return "";
  return state.allBackends ? "No agents on any backend." : "No agents on this backend.";
}

function unavailableText(backends) {
  if (backends.length === 0) return "";
  if (backends.length === 1) {
    return `Backend ${backends[0].id} unavailable (${backends[0].code}).`;
  }
  return `Backends unavailable: ${backends.map(({ id, code }) => `${id} (${code})`).join(", ")}.`;
}

function statusText(state) {
  if (state.message) return state.message;
  if (state.refreshError) {
    return state.rows.length > 0
      ? `Could not refresh (${state.refreshError}). Showing the last list.`
      : `Could not read agents (${state.refreshError}). Press r to retry.`;
  }
  const omitted = state.omitted
    ? `Showing ${state.rows.length} agents. More exist but are not listed.`
    : "";
  return [unavailableText(state.unavailableBackends), omitted].filter(Boolean).join(" ");
}

/** One string per terminal row, each exactly `columns` cells wide. */
export function renderTuiFrame(state, { columns, rows }) {
  const height = listHeight(rows);
  const layout = visibleColumns(columns, state.allBackends);
  // The selection stays visible, including after a refresh shortens the list.
  const offset = Math.max(0, state.selected - height + 1);
  const headings = { state: "STATE", agent: "AGENT" };
  for (const column of layout.optional) headings[column.key] = column.label;
  const body = state.rows.slice(offset, offset + height).map((row, index) => {
    const selected = offset + index === state.selected;
    const text = rowText(selected ? SELECTION_MARKER : "  ", row, layout, columns);
    return selected ? `\x1b[7m${text}\x1b[0m` : text;
  });
  if (state.rows.length === 0) body.push(fitCells(`  ${emptyListText(state)}`, columns));
  while (body.length < height) body.push(fitCells("", columns));
  const right = state.loaded ? summary(state.rows) : "";
  const title = "Dure agents";
  const titleGap = Math.max(1, columns - title.length - right.length);
  const frame = [
    fitCells(`${title}${" ".repeat(titleGap)}${right}`, columns),
    rowText("  ", headings, layout, columns),
    ...body,
    fitCells(statusText(state), columns),
    fitCells(HELP_LINE, columns),
  ];
  return frame.slice(0, Math.max(1, rows));
}

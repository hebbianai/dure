import { spawn } from "node:child_process";
import { attachManagedSession, formatSessionAttachError } from "./session-attach.mjs";
import { collectFilteredSessionQuery } from "./session-query.mjs";
import { collectAllBackendsSessionQuery } from "./session-query-all-backends.mjs";
import {
  applySessionReport,
  applyTuiKey,
  createTuiKeyDecoder,
  initialTuiState,
  listHeight,
  renderTuiFrame,
} from "./session-tui-model.mjs";

export const TUI_HELP = `Usage: dure tui [--backend ID | --all-backends]

See every managed agent across Spaces and attach to one from a terminal. It does
not need the app. The list shows each agent's state, account and project, and
refreshes by itself.

  Up/Down, j/k           Select an agent
  PageUp/PageDown, g/G   Move by a page, or to the first or last agent
  Enter                  Attach to the selected agent
  r                      Refresh now
  q                      Quit

While attached, press Ctrl-\\ then d to detach and return to the list. Detaching
leaves the agent running.

Account and project come from this machine's app. Without it, the account reads
unknown and the project is the name of the agent's working folder.

  --backend ID     Select the backend (otherwise DURE_BACKEND_PROFILE or default).
  --all-backends   List the agents on every configured backend profile in one
                   list with a BACKEND column. Enter attaches through the agent's
                   own backend. A backend that cannot be reached is named below
                   the list and does not hide the others. Not with --backend.
  --help, -h       Print this help without contacting a backend.
`;

const REFRESH_INTERVAL_MS = 3_000;
const MAX_ATTACH_DIAGNOSTIC_CHARACTERS = 4 * 1024;
const HMUX_ERROR_PREFIX = "hmux: error: ";
const QUERY_UNAVAILABLE = "dure_session_query_unavailable";

const ENTER_LIST_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[2J";
const LEAVE_LIST_SCREEN = "\x1b[?25h\x1b[?1049l";
// A detached program is still running, so whatever input modes it set are still
// on. The list reads plain keys and owns a plain screen.
const CLEAR_ATTACHED_MODES =
  "\x1b[?2026l\x1b[0m\x1b[r\x1b[?6l\x1b[?7h\x1b[?1l\x1b>" +
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
  "\x1b[?1004l\x1b[?2004l\x1b[<u";

export class SessionTuiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SessionTuiError";
  }
}

export function formatSessionTuiError(error) {
  return `${error?.code ?? "dure_tui_failed"}: ${error?.message ?? String(error)}`;
}

const isManaged = (session) => session.runtime.sessionClass === "managed";

/** The census behind the list: managed sessions, the only ones `dure attach`
 * can open. Across backends it is the `dure ls --all-backends` listing. */
export function collectManagedAgents({
  allBackends = false,
  backend,
  execute,
  hmuxCommand,
  loadCatalog,
  loadRegistry,
  requestBackend,
  resolveBackend,
}) {
  const collectManaged = (query) => collectFilteredSessionQuery(query, isManaged);
  return () => {
    const query = { backend, execute, hmuxCommand, registry: loadRegistry(), requestBackend };
    return allBackends
      ? collectAllBackendsSessionQuery({ query, collect: collectManaged, loadCatalog, resolveBackend })
      : collectManaged(query);
  };
}

/** Resolves each backend profile once while the list is open, as a list on one
 * backend does at startup, instead of on every refresh. A failure is not kept,
 * so the next refresh tries again. */
export function rememberBackendContexts(resolve) {
  const contexts = new Map();
  const forget = (id) => contexts.delete(id);
  return (id) => {
    if (!contexts.has(id)) {
      const pending = Promise.resolve()
        .then(() => resolve(id))
        .then(
          (context) => {
            if (!context || context.error) forget(id);
            return context;
          },
          (error) => {
            forget(id);
            throw error;
          },
        );
      contexts.set(id, pending);
    }
    return contexts.get(id);
  };
}

function attachFailureMessage(error, diagnostic) {
  const hmuxError = diagnostic
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(HMUX_ERROR_PREFIX, "");
  return `Attach failed: ${hmuxError || formatSessionAttachError(error)}`;
}

/** Resolves to null after a detach or agent exit, or to the reason it failed.
 * A row read through a backend profile attaches through that profile; any
 * other row attaches the way the list was read. */
export function attachAgentRow({ backend, execute, hmuxCommand, resolveBackend, spawnProcess = spawn }) {
  return async (row, onChild) => {
    let diagnostic = "";
    try {
      await attachManagedSession({
        backend: row.backendProfileId ? await resolveBackend(row.backendProfileId) : backend,
        execute,
        hmuxCommand,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        spawnProcess: (command, args) => {
          // Repainting the list erases the screen, so an attach error has to
          // be caught here to still be readable afterwards.
          const child = spawnProcess(command, args, { stdio: ["inherit", "inherit", "pipe"] });
          onChild(child);
          child.stderr?.on("data", (chunk) => {
            if (diagnostic.length < MAX_ATTACH_DIAGNOSTIC_CHARACTERS) diagnostic += chunk;
          });
          return child;
        },
      });
      return null;
    } catch (error) {
      return attachFailureMessage(error, diagnostic);
    }
  };
}

function writeOutput(output, text) {
  return new Promise((resolve) => {
    output.write(text, resolve);
  });
}

export async function runSessionTui({
  allBackends = false,
  attach,
  collect,
  input = process.stdin,
  output = process.stdout,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
  signals = process,
}) {
  if (!input.isTTY || !output.isTTY) {
    throw new SessionTuiError(
      "dure_tui_terminal_required",
      "dure tui needs an interactive terminal; use dure ls to list agents from a script",
    );
  }
  let state = initialTuiState({ allBackends });
  let attached = false;
  let onListScreen = false;
  let stopped = false;
  let refreshing = false;
  let refreshTimer;
  let attachedChild = null;
  let lastFrame = null;
  let finish;
  let fail;
  const finished = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const decode = createTuiKeyDecoder();

  const viewport = () => ({ columns: output.columns || 80, rows: output.rows || 24 });

  const paint = () => {
    if (attached || stopped) return;
    const frame = renderTuiFrame(state, viewport())
      .map((line, row) => `\x1b[${row + 1};1H\x1b[2K${line}`)
      .join("");
    if (frame === lastFrame) return;
    lastFrame = frame;
    output.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  };

  const refresh = async () => {
    if (refreshing || stopped) return;
    clearTimeout(refreshTimer);
    refreshing = true;
    let report;
    try {
      report = await collect();
    } catch (error) {
      report = { kind: "dure.sessions.error", error: { code: error?.code ?? QUERY_UNAVAILABLE } };
    }
    refreshing = false;
    // While attached the terminal belongs to the agent; returning refreshes.
    if (attached || stopped) return;
    state = applySessionReport(state, report);
    paint();
    refreshTimer = setTimeout(() => refresh().catch(fail), refreshIntervalMs);
  };

  const stop = () => {
    stopped = true;
    finish();
  };

  const attachRow = async (row) => {
    attached = true;
    clearTimeout(refreshTimer);
    // Node must stop reading and hand back a cooked terminal, or it would
    // steal keystrokes from the attached client.
    input.off("data", onData);
    input.setRawMode(false);
    input.pause();
    await writeOutput(output, LEAVE_LIST_SCREEN);
    onListScreen = false;
    const message = await attach(row, (child) => {
      attachedChild = child;
    });
    attachedChild = null;
    if (stopped) {
      finish();
      return;
    }
    await writeOutput(output, `${CLEAR_ATTACHED_MODES}${ENTER_LIST_SCREEN}`);
    onListScreen = true;
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    attached = false;
    lastFrame = null;
    state = { ...state, message };
    paint();
    await refresh();
  };

  function onData(chunk) {
    try {
      for (const key of decode(chunk)) {
        const result = applyTuiKey(state, key, listHeight(viewport().rows));
        state = result.state;
        if (result.effect?.kind === "quit") {
          stop();
          return;
        }
        if (result.effect?.kind === "attach") {
          // Anything typed after Enter was meant for the list, not the agent.
          attachRow(result.effect.row).catch(fail);
          return;
        }
        if (result.effect?.kind === "refresh") refresh().catch(fail);
      }
      paint();
    } catch (error) {
      fail(error);
    }
  }

  const onResize = () => {
    if (attached || stopped) return;
    lastFrame = null;
    output.write("\x1b[2J");
    paint();
  };

  // A terminal in raw mode sends Ctrl-C as a key, so SIGINT here is external.
  // While attached it can only be the brief hand-over to the client.
  const onInterrupt = () => {
    if (!attached) stop();
  };
  const onTermination = (signal) => {
    if (!attached) {
      stop();
      return;
    }
    stopped = true;
    attachedChild?.kill(signal);
  };

  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTermination);
  signals.on("SIGHUP", onTermination);
  output.on("resize", onResize);
  try {
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    await writeOutput(output, ENTER_LIST_SCREEN);
    onListScreen = true;
    paint();
    refresh().catch(fail);
    await finished;
  } finally {
    stopped = true;
    clearTimeout(refreshTimer);
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTermination);
    signals.off("SIGHUP", onTermination);
    output.off("resize", onResize);
    input.off("data", onData);
    if (onListScreen) await writeOutput(output, LEAVE_LIST_SCREEN);
    input.setRawMode(false);
    input.pause();
  }
}

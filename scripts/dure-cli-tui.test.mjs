import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { collectFilteredSessionQuery } from "../cli/lib/session-query.mjs";
import {
  applySessionReport,
  applyTuiKey,
  createTuiKeyDecoder,
  fitCells,
  initialTuiState,
  renderTuiFrame,
} from "../cli/lib/session-tui-model.mjs";
import {
  attachAgentRow,
  collectManagedAgents,
  rememberBackendContexts,
  runSessionTui,
  TUI_HELP,
} from "../cli/lib/session-tui.mjs";
import { LocalBackendError } from "../cli/lib/local-backend.mjs";
import { sshBackendProfile } from "./lib/dure-cli-ssh-fixture.mjs";
import { hmuxSession } from "./lib/dure-session-test-fixture.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const ENTER_LIST = "\x1b[?1049h";
const LEAVE_LIST = "\x1b[?1049l";

function runtimeState(overrides = {}) {
  return { lifecycle: "running", activity: "waiting", attention: "none", ...overrides };
}

function agentSession(index, overrides = {}) {
  return {
    sessionId: `session-${index}`,
    workspaceId: `workspace-${index}`,
    provider: { id: "codex" },
    cwd: `/srv/project-${index}`,
    liveness: { state: "alive", health: "healthy", exactGeneration: true },
    runtime: { sessionClass: "managed", agentRuntimeState: runtimeState() },
    clientProjection: { state: "absent", agents: [] },
    ...overrides,
  };
}

function currentAgent(agent) {
  return { clientProjection: { state: "current", agents: [agent] } };
}

function listReport(sessions, overrides = {}) {
  return {
    kind: "dure.sessions.list",
    sessions,
    truncation: { items: false, omittedCount: 0 },
    ...overrides,
  };
}

function stateWith(sessions, overrides = {}) {
  return { ...applySessionReport(initialTuiState(), listReport(sessions)), ...overrides };
}

function plainFrame(state, viewport = { columns: 100, rows: 12 }) {
  return renderTuiFrame(state, viewport).map(stripVTControlCharacters);
}

function rowLine(state, agent, viewport) {
  return plainFrame(state, viewport).find((line) => line.includes(agent));
}

describe("dure tui list rendering", () => {
  it.each([
    ["working", { runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ activity: "working" }) } }],
    ["needs input", { runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ attention: "input_required" }) } }],
    ["needs input", { runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ attention: "approval_required" }) } }],
    ["idle", {}],
    ["error", { runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ attention: "error" }) } }],
    ["exited", { liveness: { state: "exited", health: "exited", exactGeneration: true } }],
  ])("shows %s from the Host's observation", (label, overrides) => {
    const line = rowLine(stateWith([agentSession(1, overrides)]), "session-1");
    expect(line.startsWith(`> ${label}`)).toBe(true);
  });

  it("reads an unreachable Host as unknown instead of exited", () => {
    const line = rowLine(
      stateWith([
        agentSession(1, {
          liveness: { state: "unknown", health: "stale_transport", exactGeneration: false },
          runtime: { sessionClass: "managed", agentRuntimeState: null },
        }),
      ]),
      "session-1",
    );
    expect(line).toContain("unknown");
    expect(line).not.toContain("exited");
  });

  it("shows the app's account and project when it holds the agent's current binding", () => {
    const line = rowLine(
      stateWith([
        agentSession(1, currentAgent({
          displayName: "Lead", name: "lead", accountReference: "work", project: "dure",
        })),
      ]),
      "Lead",
    );
    expect(line).toContain("work");
    expect(line).toContain("dure");
  });

  it("names the provider default account the way dure run selects it", () => {
    const line = rowLine(
      stateWith([agentSession(1, currentAgent({ name: "lead", accountReference: "provider_default" }))]),
      "lead",
    );
    expect(line).toContain("default");
    expect(line).not.toContain("provider_default");
  });

  it("falls back honestly without an app: unknown account, working folder as project", () => {
    const line = rowLine(stateWith([agentSession(1)]), "session-1");
    expect(line).toContain("unknown");
    expect(line).toContain("project-1");
  });

  it("does not present a stale binding's account as current", () => {
    const line = rowLine(
      stateWith([
        agentSession(1, {
          clientProjection: {
            state: "stale",
            agents: [{ name: "old", accountReference: "work", project: "old-project" }],
          },
        }),
      ]),
      "old",
    );
    expect(line).not.toContain("work");
    expect(line).not.toContain("old-project");
    expect(line).toContain("project-1");
  });

  it.each([
    [100, 12],
    [80, 24],
    [50, 10],
    [24, 6],
  ])("fills exactly %i by %i cells", (columns, rows) => {
    const frame = plainFrame(
      stateWith([
        agentSession(1, currentAgent({ name: "\ud55c\uae00\uc5d0\uc774\uc804\ud2b8\uc774\ub984\uc774\uc544\uc8fc\uae34\uacbd\uc6b0", accountReference: "work", project: "dure" })),
        agentSession(2),
      ]),
      { columns, rows },
    );
    expect(frame).toHaveLength(rows);
    for (const line of frame) expect(displayWidth(line)).toBe(columns);
  });

  it("gives up the provider first, then account, as the terminal narrows", () => {
    const headings = (columns) =>
      plainFrame(stateWith([agentSession(1)]), { columns, rows: 12 })[1];
    expect(headings(100)).toContain("PROVIDER");
    expect(headings(100)).toContain("ACCOUNT");
    expect(headings(100)).toContain("PROJECT");
    expect(headings(70)).not.toContain("PROVIDER");
    expect(headings(70)).toContain("ACCOUNT");
    expect(headings(55)).not.toContain("ACCOUNT");
    expect(headings(55)).toContain("PROJECT");
  });

  it("removes terminal control characters from names supplied by a backend", () => {
    const frame = renderTuiFrame(
      stateWith([
        agentSession(1, currentAgent({
          name: "evil\x1b]0;owned\x07\u202ename",
          accountReference: "a\x1b[2Jb",
          project: "p\x07q",
        })),
      ]),
      { columns: 100, rows: 12 },
    ).join("\n");
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("\u202e");
    expect(frame).not.toContain("\x1b]");
    expect(frame).not.toContain("\x1b[2J");
  });

  it("marks only the selected row, in reverse video", () => {
    const frame = renderTuiFrame(
      stateWith([agentSession(1), agentSession(2)]),
      { columns: 100, rows: 12 },
    );
    const selected = frame.filter((line) => line.includes("\x1b[7m"));
    expect(selected).toHaveLength(1);
    expect(stripVTControlCharacters(selected[0])).toContain("session-1");
  });

  it("keeps the selection visible in a list longer than the terminal", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => agentSession(index + 10));
    const state = stateWith(sessions, { selected: 25 });
    const frame = plainFrame(state, { columns: 100, rows: 10 });
    expect(frame.some((line) => line.startsWith(">") && line.includes("session-35"))).toBe(true);
    expect(frame).toHaveLength(10);
  });

  it("counts agents and those waiting on a person", () => {
    const state = stateWith([
      agentSession(1, { runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ attention: "input_required" }) } }),
      agentSession(2),
    ]);
    expect(plainFrame(state)[0]).toContain("2 agents \u00b7 1 needs input");
  });

  it("explains loading and empty lists", () => {
    expect(plainFrame(initialTuiState()).join("\n")).toContain("Loading agents");
    expect(plainFrame(stateWith([])).join("\n")).toContain("No agents on this backend.");
  });

  it("keeps the last rows and says so when a refresh fails", () => {
    const state = applySessionReport(stateWith([agentSession(1)]), {
      kind: "dure.sessions.error",
      error: { code: "dure_session_query_timeout" },
    });
    const text = plainFrame(state).join("\n");
    expect(text).toContain("session-1");
    expect(text).toContain("Could not refresh (dure_session_query_timeout)");
  });

  it("offers a retry when the first read fails", () => {
    const state = applySessionReport(initialTuiState(), {
      kind: "dure.sessions.error",
      error: { code: "dure_session_query_timeout" },
    });
    expect(plainFrame(state).join("\n")).toContain("Press r to retry");
  });

  it("says when the census did not fit", () => {
    const state = applySessionReport(
      initialTuiState(),
      listReport([agentSession(1)], { truncation: { items: true, omittedCount: 4 } }),
    );
    expect(plainFrame(state).join("\n")).toContain("More exist but are not listed");
  });

  it("orders rows independently of state, so they do not move under the cursor", () => {
    const order = (first) =>
      stateWith([
        agentSession(1, first),
        agentSession(2),
      ]).rows.map((row) => row.sessionId);
    expect(order({})).toEqual(order({
      runtime: { sessionClass: "managed", agentRuntimeState: runtimeState({ activity: "working" }) },
    }));
  });

  it("follows the selected agent when a refresh reorders the list", () => {
    const before = stateWith([agentSession(2), agentSession(3)], { selected: 1 });
    expect(before.rows[before.selected].sessionId).toBe("session-3");
    const after = applySessionReport(before, listReport([agentSession(1), agentSession(2), agentSession(3)]));
    expect(after.rows[after.selected].sessionId).toBe("session-3");
  });

  it("clamps the selection when the selected agent leaves the census", () => {
    const before = stateWith([agentSession(1), agentSession(2)], { selected: 1 });
    const after = applySessionReport(before, listReport([agentSession(1)]));
    expect(after.selected).toBe(0);
  });
});

/** A listing across backends, shaped like `dure ls --all-backends --json`. */
function allBackendsReport(entries) {
  return listReport(
    entries.flatMap(({ id, sessions = [] }) =>
      sessions.map((session) => ({ backendProfileId: id, ...session })),
    ),
    {
      backends: entries.map(({ id, error, local }) =>
        error
          ? { backendProfileId: id, status: "error", error: { code: error } }
          : {
              backendProfileId: id,
              status: "ok",
              source: local ? { kind: "local_hmux" } : { kind: "backend_profile", profileId: id },
            },
      ),
    },
  );
}

function allBackendsState(entries) {
  return applySessionReport(initialTuiState({ allBackends: true }), allBackendsReport(entries));
}

describe("dure tui --all-backends list", () => {
  it("shows where each agent runs in a BACKEND column", () => {
    const state = allBackendsState([
      { id: "remote-build", sessions: [agentSession(1)] },
      { id: "laptop", sessions: [agentSession(2)] },
    ]);
    expect(plainFrame(state)[1]).toContain("BACKEND");
    expect(rowLine(state, "session-1")).toContain("remote-build");
    expect(rowLine(state, "session-2")).toContain("laptop");
  });

  it("shows the BACKEND heading before the first answer", () => {
    expect(plainFrame(initialTuiState({ allBackends: true }))[1]).toContain("BACKEND");
  });

  it("leaves the BACKEND column out on one backend", () => {
    expect(plainFrame(stateWith([agentSession(1)]))[1]).not.toContain("BACKEND");
  });

  it("keeps the same Session ID on two backends as two rows, each attaching through its own backend", () => {
    const state = allBackendsState([
      { id: "remote-a", sessions: [agentSession(1)] },
      { id: "remote-b", sessions: [agentSession(1)] },
    ]);
    expect(state.rows.map((row) => [row.backend, row.sessionId])).toEqual([
      ["remote-a", "session-1"],
      ["remote-b", "session-1"],
    ]);
    const second = applyTuiKey(state, "down", 5).state;
    expect(applyTuiKey(second, "enter", 5).effect.row).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      backendProfileId: "remote-b",
    });
  });

  it("follows the selected agent's backend across a refresh", () => {
    const entries = [
      { id: "remote-a", sessions: [agentSession(1)] },
      { id: "remote-b", sessions: [agentSession(1)] },
    ];
    const before = { ...allBackendsState(entries), selected: 1 };
    const after = applySessionReport(before, allBackendsReport([
      { id: "remote-0", sessions: [agentSession(1)] },
      ...entries,
    ]));
    expect(after.rows[after.selected].backend).toBe("remote-b");
  });

  it("attaches through this machine's Hmux when no backend catalog exists", () => {
    const state = allBackendsState([{ id: "local", local: true, sessions: [agentSession(1)] }]);
    expect(rowLine(state, "session-1")).toContain("local");
    expect(applyTuiKey(state, "enter", 5).effect.row).toMatchObject({
      backend: "local",
      backendProfileId: null,
    });
  });

  it("names an unavailable backend and keeps the agents of the others", () => {
    const text = plainFrame(allBackendsState([
      { id: "remote-build", sessions: [agentSession(1)] },
      { id: "remote-down", error: "backend_transport_ssh_failed" },
    ])).join("\n");
    expect(text).toContain("session-1");
    expect(text).toContain("Backend remote-down unavailable (backend_transport_ssh_failed).");
  });

  it("names every unavailable backend", () => {
    const text = plainFrame(allBackendsState([
      { id: "remote-a", error: "backend_transport_ssh_failed" },
      { id: "remote-b", error: "local_backend_unavailable" },
    ]), { columns: 120, rows: 12 }).join("\n");
    expect(text).toContain(
      "Backends unavailable: remote-a (backend_transport_ssh_failed), remote-b (local_backend_unavailable).",
    );
  });

  it("does not claim there are no agents while a backend is unavailable", () => {
    const text = plainFrame(allBackendsState([
      { id: "remote-build" },
      { id: "remote-down", error: "backend_transport_ssh_failed" },
    ])).join("\n");
    expect(text).not.toContain("No agents");
    expect(text).toContain("remote-down unavailable");
  });

  it("says there are no agents only when every backend answered", () => {
    const text = plainFrame(allBackendsState([{ id: "remote-a" }, { id: "remote-b" }])).join("\n");
    expect(text).toContain("No agents on any backend.");
  });

  it("drops a backend's failure once it answers again", () => {
    const failed = allBackendsState([
      { id: "remote-build", sessions: [agentSession(1)] },
      { id: "remote-down", error: "backend_transport_ssh_failed" },
    ]);
    const recovered = applySessionReport(failed, allBackendsReport([
      { id: "remote-build", sessions: [agentSession(1)] },
      { id: "remote-down", sessions: [agentSession(2)] },
    ]));
    const text = plainFrame(recovered).join("\n");
    expect(text).not.toContain("unavailable");
    expect(text).toContain("session-2");
  });

  it("gives up the backend column last as the terminal narrows", () => {
    const headings = (columns) =>
      plainFrame(allBackendsState([{ id: "remote-build", sessions: [agentSession(1)] }]), {
        columns,
        rows: 12,
      })[1];
    expect(headings(110)).toMatch(/AGENT\s+BACKEND\s+PROVIDER\s+ACCOUNT\s+PROJECT/);
    expect(headings(60)).toContain("BACKEND");
    expect(headings(60)).not.toContain("PROJECT");
    expect(headings(42)).toContain("BACKEND");
    expect(headings(40)).not.toContain("BACKEND");
  });

  it.each([
    [110, 12],
    [80, 24],
    [42, 8],
  ])("fills exactly %i by %i cells", (columns, rows) => {
    const frame = plainFrame(
      allBackendsState([
        { id: "a-very-long-backend-profile-name", sessions: [agentSession(1)] },
        { id: "remote-down", error: "backend_transport_ssh_failed" },
      ]),
      { columns, rows },
    );
    expect(frame).toHaveLength(rows);
    for (const line of frame) expect(displayWidth(line)).toBe(columns);
  });
});

describe("dure tui key handling", () => {
  it.each([
    ["\x1b[A", ["up"]],
    ["\x1b[B", ["down"]],
    ["\x1bOA", ["up"]],
    ["\x1bOB", ["down"]],
    ["\x1b[1;2B", ["down"]],
    ["\x1b[H", ["home"]],
    ["\x1b[F", ["end"]],
    ["\x1b[1~", ["home"]],
    ["\x1b[4~", ["end"]],
    ["\x1b[5~", ["pageUp"]],
    ["\x1b[6~", ["pageDown"]],
    ["\r", ["enter"]],
    ["\n", ["enter"]],
    ["\x1b[13u", ["enter"]],
    ["\x1b[99;5u", ["quit"]],
    ["\x03", ["quit"]],
    ["q", ["quit"]],
    ["r", ["refresh"]],
    ["jk", ["down", "up"]],
    ["gG", ["home", "end"]],
    ["x", []],
    ["\x1b", []],
    ["\ud55c", []],
  ])("decodes %j", (chunk, keys) => {
    expect(createTuiKeyDecoder()(chunk)).toEqual(keys);
  });

  it("reassembles an escape sequence split across reads", () => {
    const decode = createTuiKeyDecoder();
    expect(decode("\x1b")).toEqual([]);
    expect(decode("[")).toEqual([]);
    expect(decode("5")).toEqual([]);
    expect(decode("~j")).toEqual(["pageUp", "down"]);
  });

  it("treats a bare Escape followed by a key as that key", () => {
    const decode = createTuiKeyDecoder();
    expect(decode("\x1b")).toEqual([]);
    expect(decode("q")).toEqual(["quit"]);
  });

  it("accepts a Buffer from the terminal", () => {
    expect(createTuiKeyDecoder()(Buffer.from("\x1b[B"))).toEqual(["down"]);
  });

  it("stops selection at both ends of the list", () => {
    const state = stateWith([agentSession(1), agentSession(2)]);
    expect(applyTuiKey(state, "up", 5).state.selected).toBe(0);
    const last = applyTuiKey(state, "end", 5).state;
    expect(last.selected).toBe(1);
    expect(applyTuiKey(last, "down", 5).state.selected).toBe(1);
  });

  it("moves a page at a time", () => {
    const state = stateWith(Array.from({ length: 20 }, (_, index) => agentSession(index + 10)));
    const paged = applyTuiKey(state, "pageDown", 8).state;
    expect(paged.selected).toBe(8);
    expect(applyTuiKey(paged, "pageUp", 8).state.selected).toBe(0);
  });

  it("attaches to exactly the selected row", () => {
    const state = stateWith([agentSession(1), agentSession(2)], { selected: 1 });
    const { effect } = applyTuiKey(state, "enter", 5);
    expect(effect.kind).toBe("attach");
    expect(effect.row).toMatchObject({ sessionId: "session-2", workspaceId: "workspace-2" });
  });

  it("explains why an exited agent cannot be attached", () => {
    const state = stateWith([
      agentSession(1, { liveness: { state: "exited", health: "exited", exactGeneration: true } }),
    ]);
    const result = applyTuiKey(state, "enter", 5);
    expect(result.effect).toBeUndefined();
    expect(result.state.message).toContain("has exited");
  });

  it("lets the authoritative attach decide for an unknown agent", () => {
    const state = stateWith([
      agentSession(1, {
        liveness: { state: "unknown", health: "stale_transport", exactGeneration: false },
        runtime: { sessionClass: "managed", agentRuntimeState: null },
      }),
    ]);
    expect(applyTuiKey(state, "enter", 5).effect?.kind).toBe("attach");
  });

  it("does nothing on Enter in an empty list", () => {
    expect(applyTuiKey(stateWith([]), "enter", 5).effect).toBeUndefined();
  });

  it("clears a message on the next key", () => {
    const state = stateWith([agentSession(1), agentSession(2)], { message: "old" });
    expect(applyTuiKey(state, "down", 5).state.message).toBeNull();
  });
});

function displayWidth(text) {
  return [...new Intl.Segmenter().segment(text)].reduce(
    (sum, { segment }) => sum + (fitCells(segment, 2) === segment ? 2 : 1),
    0,
  );
}

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  flowing = false;
  setRawMode(value) {
    this.isRaw = value;
  }
  pause() {
    this.flowing = false;
  }
  resume() {
    this.flowing = true;
  }
  press(chunk) {
    this.emit("data", Buffer.from(chunk));
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 12;
  text = "";
  write(value, done) {
    this.text += value;
    done?.();
    return true;
  }
  lastScreen() {
    return stripVTControlCharacters(this.text.slice(this.text.lastIndexOf(ENTER_LIST)));
  }
}

async function settled(condition) {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 5_000, interval: 2 });
}

function startTui({ allBackends, attach = async () => null, collect, signals = new EventEmitter() } = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const census = collect ?? vi.fn(async () => listReport([agentSession(1), agentSession(2)]));
  const running = runSessionTui({
    allBackends,
    attach,
    collect: census,
    input,
    output,
    refreshIntervalMs: 60_000,
    signals,
  });
  return { census, input, output, running, signals };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("dure tui attach loop", () => {
  it("refuses a non-terminal with a typed error that points at dure ls", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    await expect(
      runSessionTui({ attach: vi.fn(), collect: vi.fn(), input, output: new FakeOutput() }),
    ).rejects.toMatchObject({
      code: "dure_tui_terminal_required",
      message: expect.stringContaining("dure ls"),
    });
  });

  it("lists, attaches, detaches, returns to the list and quits cleanly", async () => {
    const session = deferred();
    const seen = {};
    const attach = vi.fn(async (row) => {
      seen.row = row;
      seen.terminal = { raw: tui.input.isRaw, flowing: tui.input.flowing, readers: tui.input.listenerCount("data") };
      await session.promise;
      return null;
    });
    const tui = startTui({ attach });
    await settled(() => tui.output.lastScreen().includes("session-2"));
    expect(tui.input.isRaw).toBe(true);

    tui.input.press("j");
    tui.input.press("\r");
    await settled(() => attach.mock.calls.length === 1);

    // The agent owns the terminal for the whole attachment.
    expect(seen.row.sessionId).toBe("session-2");
    expect(seen.terminal).toEqual({ raw: false, flowing: false, readers: 0 });
    expect(tui.output.text.endsWith(LEAVE_LIST)).toBe(true);
    const beforeDetach = tui.output.text.length;
    const censusBeforeDetach = tui.census.mock.calls.length;

    session.resolve();
    await settled(() => tui.census.mock.calls.length > censusBeforeDetach);
    await settled(() => tui.output.lastScreen().includes("session-2"));

    const afterDetach = tui.output.text.slice(beforeDetach);
    expect(afterDetach).toContain(ENTER_LIST);
    expect(afterDetach).toContain("\x1b[?1000l");
    expect(tui.input.isRaw).toBe(true);
    expect(tui.input.flowing).toBe(true);
    expect(tui.input.listenerCount("data")).toBe(1);
    // Selection survives the round trip.
    expect(tui.output.lastScreen()).toContain("> idle");

    tui.input.press("q");
    await tui.running;
    expect(tui.output.text.endsWith(LEAVE_LIST)).toBe(true);
    expect(tui.input.isRaw).toBe(false);
    expect(tui.input.flowing).toBe(false);
    expect(tui.input.listenerCount("data")).toBe(0);
  });

  it("hands the attach the selected row's backend across backends", async () => {
    const attach = vi.fn(async () => null);
    const tui = startTui({
      allBackends: true,
      attach,
      collect: vi.fn(async () => allBackendsReport([
        { id: "remote-a", sessions: [agentSession(1)] },
        { id: "remote-b", sessions: [agentSession(1)] },
      ])),
    });
    await settled(() => tui.output.lastScreen().includes("remote-b"));
    expect(tui.output.lastScreen()).toContain("BACKEND");
    tui.input.press("j\r");
    await settled(() => attach.mock.calls.length === 1);
    expect(attach.mock.calls[0][0]).toMatchObject({ sessionId: "session-1", backendProfileId: "remote-b" });
    await settled(() => tui.input.flowing);
    tui.input.press("q");
    await tui.running;
  });

  it("shows why an attach failed and keeps the list usable", async () => {
    const attach = vi.fn(async () => "Attach failed: the session went away");
    const tui = startTui({ attach });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("\r");
    await settled(() => tui.output.lastScreen().includes("Attach failed: the session went away"));
    expect(tui.input.flowing).toBe(true);
    tui.input.press("q");
    await tui.running;
  });

  it("does not paint over the agent when a census lands during the attachment", async () => {
    const session = deferred();
    const census = deferred();
    let calls = 0;
    const collect = vi.fn(async () => {
      calls += 1;
      if (calls === 2) return census.promise;
      return listReport([agentSession(1)]);
    });
    const attach = vi.fn(async () => {
      await session.promise;
      return null;
    });
    const tui = startTui({ attach, collect });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("r");
    await settled(() => calls === 2);
    tui.input.press("\r");
    await settled(() => attach.mock.calls.length === 1);
    const written = tui.output.text.length;

    census.resolve(listReport([agentSession(1), agentSession(9)]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tui.output.text.length).toBe(written);

    session.resolve();
    await settled(() => calls === 3);
    tui.input.press("q");
    await tui.running;
  });

  it("does not attach twice or quit from keys sent with the same Enter", async () => {
    const session = deferred();
    const attach = vi.fn(async () => {
      await session.promise;
      return null;
    });
    const tui = startTui({ attach });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("\rq\r");
    await settled(() => attach.mock.calls.length === 1);
    expect(attach).toHaveBeenCalledTimes(1);
    session.resolve();
    await settled(() => tui.input.flowing);
    tui.input.press("q");
    await tui.running;
  });

  it("stays on the list when an exited agent is chosen", async () => {
    const attach = vi.fn();
    const tui = startTui({
      attach,
      collect: vi.fn(async () => listReport([
        agentSession(1, { liveness: { state: "exited", health: "exited", exactGeneration: true } }),
      ])),
    });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("\r");
    await settled(() => tui.output.lastScreen().includes("has exited"));
    expect(attach).not.toHaveBeenCalled();
    tui.input.press("q");
    await tui.running;
  });

  it("survives a census that throws and retries on r", async () => {
    let calls = 0;
    const collect = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("boom"), { code: "dure_test_failure" });
      return listReport([agentSession(1)]);
    });
    const tui = startTui({ collect });
    await settled(() => tui.output.lastScreen().includes("dure_test_failure"));
    tui.input.press("r");
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("q");
    await tui.running;
  });

  it("repaints the whole screen after a resize", async () => {
    const tui = startTui();
    await settled(() => tui.output.lastScreen().includes("session-1"));
    const written = tui.output.text.length;
    tui.output.columns = 60;
    tui.output.emit("resize");
    expect(tui.output.text.slice(written)).toContain("\x1b[2J");
    tui.input.press("q");
    await tui.running;
  });

  it("restores the terminal on SIGTERM", async () => {
    const tui = startTui();
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.signals.emit("SIGTERM", "SIGTERM");
    await tui.running;
    expect(tui.output.text.endsWith(LEAVE_LIST)).toBe(true);
    expect(tui.input.isRaw).toBe(false);
  });

  it("ends the attached client on SIGTERM instead of leaving it behind", async () => {
    const session = deferred();
    const child = { kill: vi.fn(() => session.resolve()) };
    const attach = vi.fn(async (_row, onChild) => {
      onChild(child);
      await session.promise;
      return null;
    });
    const tui = startTui({ attach });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("\r");
    await settled(() => attach.mock.calls.length === 1);
    tui.signals.emit("SIGTERM", "SIGTERM");
    await tui.running;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tui.input.isRaw).toBe(false);
  });

  it("ignores SIGINT during the hand-over to the attached client", async () => {
    const session = deferred();
    const attach = vi.fn(async () => {
      await session.promise;
      return null;
    });
    const tui = startTui({ attach });
    await settled(() => tui.output.lastScreen().includes("session-1"));
    tui.input.press("\r");
    await settled(() => attach.mock.calls.length === 1);
    tui.signals.emit("SIGINT", "SIGINT");
    session.resolve();
    await settled(() => tui.input.flowing);
    tui.input.press("q");
    await tui.running;
  });
});

describe("dure tui attach path", () => {
  const row = { sessionId: "session-1", workspaceId: "workspace-1" };

  function hmuxExecute(payload = hmuxSession()) {
    return vi.fn(async (argv) => ({
      kind: "success",
      stdout: argv.includes("capabilities")
        ? JSON.stringify({ schemaVersion: 2, capabilities: ["managed_interactive_attach_v1"] })
        : JSON.stringify(payload),
    }));
  }

  function fakeChild() {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }

  it("runs the same managed attach as dure attach, keeping stderr for the list", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.emit("close", 0, null));
      return child;
    });
    const onChild = vi.fn();
    const attach = attachAgentRow({ execute: hmuxExecute(), hmuxCommand: "hmux", spawnProcess });

    await expect(attach(row, onChild)).resolves.toBeNull();

    expect(spawnProcess).toHaveBeenCalledWith(
      "hmux",
      ["managed-attach", "session-1", "--workspace", "workspace-1"],
      { stdio: ["inherit", "inherit", "pipe"] },
    );
    expect(onChild).toHaveBeenCalledWith(child);
  });

  it("reports the attach client's own error line", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => {
        child.stderr.emit("data", "hmux: error: cannot attach from inside an Hmux session\n");
        child.emit("close", 1, null);
      });
      return child;
    });
    const attach = attachAgentRow({ execute: hmuxExecute(), hmuxCommand: "hmux", spawnProcess });

    await expect(attach(row, vi.fn())).resolves.toBe(
      "Attach failed: cannot attach from inside an Hmux session",
    );
  });

  it("reports the typed reason when no client ran", async () => {
    const payload = hmuxSession();
    payload.effectiveLifecycle = "stale";
    payload.health = "stale_transport";
    payload.recoverability = "restore";
    const spawnProcess = vi.fn();
    const attach = attachAgentRow({ execute: hmuxExecute(payload), hmuxCommand: "hmux", spawnProcess });

    await expect(attach(row, vi.fn())).resolves.toContain("dure_attach_session_not_live");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("attaches a row read through a backend profile through that profile", async () => {
    const resolveBackend = vi.fn(async () => ({
      error: new LocalBackendError("local_backend_unavailable"),
    }));
    const spawnProcess = vi.fn();
    const attach = attachAgentRow({
      backend: null,
      execute: hmuxExecute(),
      hmuxCommand: "hmux",
      resolveBackend,
      spawnProcess,
    });

    const message = await attach({ ...row, backendProfileId: "remote-build" }, vi.fn());

    expect(resolveBackend).toHaveBeenCalledWith("remote-build");
    expect(message).toContain("dure_attach_session_unavailable");
    expect(message).toContain("local_backend_unavailable");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("attaches a row on this machine through local Hmux without resolving a backend", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.emit("close", 0, null));
      return child;
    });
    const resolveBackend = vi.fn();
    const attach = attachAgentRow({
      backend: null,
      execute: hmuxExecute(),
      hmuxCommand: "hmux",
      resolveBackend,
      spawnProcess,
    });

    await expect(attach({ ...row, backend: "local", backendProfileId: null }, vi.fn())).resolves.toBeNull();

    expect(resolveBackend).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      "hmux",
      ["managed-attach", "session-1", "--workspace", "workspace-1"],
      { stdio: ["inherit", "inherit", "pipe"] },
    );
  });

  it("lists the managed agents on every backend and keeps a failed backend beside them", async () => {
    const requestBackend = vi.fn(async () => ({
      backend: { id: "remote-backend" },
      result: {
        schemaVersion: 1,
        complete: true,
        sessions: [hmuxSession(1), hmuxSession(2, { session_class: "standalone" })],
      },
    }));
    const resolveBackend = vi.fn(async (id) =>
      id === "remote-down"
        ? { error: new LocalBackendError("local_backend_unavailable") }
        : { profile: sshBackendProfile({ id }), transportOptions: {} },
    );
    const execute = vi.fn();
    const collect = collectManagedAgents({
      allBackends: true,
      backend: null,
      execute,
      hmuxCommand: "hmux",
      loadCatalog: () => ({ profiles: [{ id: "remote-build" }, { id: "remote-down" }] }),
      loadRegistry: () => ({ state: "absent", clientId: null, updatedAtMs: null, agents: [] }),
      requestBackend,
      resolveBackend,
    });

    const state = applySessionReport(initialTuiState({ allBackends: true }), await collect());

    expect(state.rows).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        backend: "remote-build",
        backendProfileId: "remote-build",
      }),
    ]);
    expect(state.unavailableBackends).toEqual([{ id: "remote-down", code: "local_backend_unavailable" }]);
    expect(requestBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "remote-build" }),
      expect.objectContaining({ operation: "sessions.list" }),
      expect.anything(),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a filter across every census page", async () => {
    const page = (ids, nextCursor) => listReport(
      ids.map((id) => agentSession(id, id % 2 ? {} : { runtime: { sessionClass: "standalone", agentRuntimeState: null } })),
      {
        inventoryComplete: nextCursor === null,
        observationComplete: true,
        truncation: { items: nextCursor !== null, omittedCount: 0 },
        pagination: { nextCursor, consistency: "live" },
        durationMs: 1,
      },
    );
    const collect = vi.fn(async ({ cursor }) =>
      cursor === undefined ? page([1, 2], "start") : cursor === "start" ? page([1, 2], "next") : page([3, 4], null),
    );

    const report = await collectFilteredSessionQuery(
      {},
      (session) => session.runtime.sessionClass === "managed",
      collect,
    );

    expect(report.sessions.map((session) => session.sessionId)).toEqual(["session-1", "session-3"]);
    expect(report.inventoryComplete).toBe(true);
    expect(report.truncation.items).toBe(false);
  });
});

describe("dure tui backend resolution", () => {
  it("resolves each backend once while the list is open", async () => {
    const resolve = vi.fn(async (id) => ({ profile: { id }, transportOptions: {} }));
    const remembered = rememberBackendContexts(resolve);

    const [first, second] = await Promise.all([remembered("remote-a"), remembered("remote-a")]);
    const third = await remembered("remote-a");
    await remembered("remote-b");

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(resolve.mock.calls).toEqual([["remote-a"], ["remote-b"]]);
  });

  it("tries a backend that failed again on the next refresh", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ error: new LocalBackendError("local_backend_unavailable") })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ profile: { id: "remote-a" }, transportOptions: {} });
    const remembered = rememberBackendContexts(resolve);

    expect((await remembered("remote-a")).error).toBeDefined();
    await expect(remembered("remote-a")).rejects.toThrow("boom");
    expect((await remembered("remote-a")).profile.id).toBe("remote-a");
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});

describe("dure tui command", () => {
  function runCli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: "/nonexistent/hmux" },
    });
  }

  it("prints help without contacting a backend", () => {
    const result = runCli(["tui", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(TUI_HELP);
    expect(TUI_HELP).toContain("Ctrl-\\ then d");
    expect(TUI_HELP).toContain("--all-backends");
  });

  it("appears in the command list", () => {
    expect(runCli(["help"]).stdout).toContain("dure tui [--backend ID | --all-backends]");
  });

  it("refuses --all-backends with --backend before contacting a backend", () => {
    const result = runCli(["tui", "--all-backends", "--backend", "remote-build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_tui_argument_invalid");
    expect(result.stderr).toContain("--all-backends");
  });

  it("refuses to run across backends without a terminal", () => {
    const result = runCli(["tui", "--all-backends"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_tui_terminal_required");
  });

  it("refuses to run without a terminal", () => {
    const result = runCli(["tui"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_tui_terminal_required");
  });

  it("rejects stray arguments", () => {
    const result = runCli(["tui", "extra"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_tui_argument_invalid");
  });
});

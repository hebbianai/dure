import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { SILENT_CLOSES_BEFORE_UPDATE } from "./chat";
import { loadChatEntry, queueKey } from "./chatQueue";
import { type ChatController, type ChatViewOptions, createChatView } from "./chatView";
import { t } from "./i18n";
import type { AgentPromptAnswer, ConversationTranscriptAnswer } from "./ipc";

/**
 * A session per test: deliveries in flight are held per session for as long
 * as the module lives, so a held one must not reach the next test.
 */
let key = "";
let sessions = 0;

function runtime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    lifecycle: "running",
    activity: "waiting",
    attention: "none",
    revision: "1",
    turnCompletedCount: "1",
    ...overrides,
  };
}

const CURSOR = {
  terminal_epoch: "terminal-2",
  conversation_id: "conversation-1",
  turn_completed_count: 1,
  turn_open: false,
  runtime_revision: 1,
};

const TRANSCRIPT: ConversationTranscriptAnswer = {
  outcome: "transcript",
  provider: "claude",
  conversation_id: "conversation-1",
  entries: [
    { role: "user", text: "Run the tests" },
    { role: "agent", text: "Done:\n\n```\nok 12\n```" },
  ],
  history_complete: true,
  cursor: CURSOR,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A send whose answer the test gives when it chooses. */
function heldSend() {
  const answers: ((answer: AgentPromptAnswer) => void)[] = [];
  const send = vi.fn<ChatViewOptions["send"]>(
    () =>
      new Promise<AgentPromptAnswer>((resolve) => {
        answers.push(resolve);
      }),
  );
  return { send, answer: (value: AgentPromptAnswer) => answers.shift()?.(value) };
}

let controller: ChatController | undefined;

function open(overrides: Partial<ChatViewOptions> = {}) {
  const options = {
    queueKey: key,
    terminalEpoch: "terminal-1",
    fetch: vi.fn(async () => TRANSCRIPT),
    send: vi.fn(
      async (): Promise<AgentPromptAnswer> => ({ state: "written_to_pty", record_id: "r-1" }),
    ),
    openTerminal: vi.fn(),
    fallBack: vi.fn(),
    storage: localStorage,
    pollIntervalMs: 60_000,
    ...overrides,
  };
  controller = createChatView(options);
  const container = document.createElement("div");
  document.body.append(container);
  controller.mount(container);
  return { options, controller, container };
}

/** Leave the session: the screen goes, and its controller with it. */
function leave(opened: { container: HTMLElement }): void {
  controller?.dispose();
  controller = undefined;
  opened.container.remove();
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector<HTMLTextAreaElement>(".chat__input");
  if (!input) throw new Error("no composer");
  return input;
}

function type(container: HTMLElement, text: string): void {
  const input = composer(container);
  input.value = text;
  input.dispatchEvent(new Event("input"));
  container.querySelector<HTMLButtonElement>(".chat__send")?.click();
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  sessions += 1;
  key = queueKey("hub-1", "box-1", "workspace-1", `session-${sessions}`);
});

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

describe("the chat view", () => {
  it("shows the conversation as messages once visible, agent text as markdown", async () => {
    const { options, container } = open();
    controller?.setVisible(true);
    await flush();
    expect(options.fetch).toHaveBeenCalledWith(undefined);
    const rows = container.querySelectorAll(".chat__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains("chat__row--user")).toBe(true);
    expect(rows[1].querySelector("pre.chat__code")?.textContent).toBe("ok 12");
  });

  it("asks again with the cursor when a turn completes, not on progress", async () => {
    const { options } = open();
    controller?.observe(runtime());
    controller?.setVisible(true);
    await flush();
    controller?.observe(runtime({ revision: "2" }));
    await flush();
    expect(options.fetch).toHaveBeenCalledTimes(1);
    controller?.observe(runtime({ revision: "3", turnCompletedCount: "2" }));
    await flush();
    expect(options.fetch).toHaveBeenCalledTimes(2);
    expect(options.fetch).toHaveBeenLastCalledWith(TRANSCRIPT.cursor);
  });

  it("keeps the composer enabled while the agent works and queues the prompt", async () => {
    const { options, container } = open();
    controller?.observe(runtime({ activity: "working" }));
    controller?.setVisible(true);
    await flush();
    expect(composer(container).disabled).toBe(false);

    type(container, "Now lint");
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain("Now lint");
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain(
      t("chat.queue.queued"),
    );
    // Persisted for the session, so it outlives the app.
    expect(loadChatEntry(localStorage, key)).toMatchObject({
      kind: "queued",
      prompt: { text: "Now lint" },
    });

    // Idle with no attention: delivered, fenced on what the person was reading.
    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(options.send).toHaveBeenCalledWith("Now lint", {
      terminalEpoch: "terminal-2",
      conversationId: "conversation-1",
    });
    expect(loadChatEntry(localStorage, key)).toBeUndefined();
    expect(container.querySelector(".chat__row--sent")?.textContent).toContain("Now lint");
  });

  it("keeps the sent bubble until a read shows the prompt's own turn", async () => {
    const fetch = vi.fn<ChatViewOptions["fetch"]>(async () => TRANSCRIPT);
    const { container } = open({ fetch });
    controller?.setVisible(true);
    await flush();
    // The last read saw one turn; the session has since completed three.
    controller?.observe(runtime({ activity: "working", turnCompletedCount: "3" }));
    type(container, "Deploy");
    fetch.mockResolvedValueOnce({ ...TRANSCRIPT, cursor: { ...CURSOR, turn_completed_count: 3 } });
    controller?.observe(runtime({ turnCompletedCount: "3" }));
    await flush();
    // Delivered, and the read that followed only caught up with the turns before it.
    expect(container.querySelector(".chat__row--sent")).not.toBeNull();
    fetch.mockResolvedValueOnce({
      ...TRANSCRIPT,
      entries: [...TRANSCRIPT.entries, { role: "user", text: "Deploy" }],
      cursor: { ...CURSOR, turn_completed_count: 4 },
    });
    controller?.observe(runtime({ turnCompletedCount: "4" }));
    await flush();
    expect(container.querySelector(".chat__row--sent")).toBeNull();
  });

  it("does not deliver while attention is pending, and offers the terminal", async () => {
    const { options, container } = open();
    controller?.observe(runtime({ attention: "approval_required" }));
    type(container, "continue");
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    const attention = container.querySelector<HTMLElement>(".chat__attention");
    expect(attention?.hidden).toBe(false);
    container.querySelector<HTMLButtonElement>(".chat__attention-action")?.click();
    expect(options.openTerminal).toHaveBeenCalled();
  });

  it("keeps the queued prompt's buttons in place while progress arrives", async () => {
    const { container } = open();
    controller?.observe(runtime({ activity: "working" }));
    type(container, "next");
    const edit = container.querySelector(".chat__row--queued .chat__meta-action");
    controller?.observe(runtime({ activity: "working", revision: "2" }));
    controller?.observe(runtime({ activity: "working", revision: "3" }));
    expect(container.querySelector(".chat__row--queued .chat__meta-action")).toBe(edit);
  });

  it("edits and cancels a queued prompt", async () => {
    const { container } = open();
    controller?.observe(runtime({ activity: "working" }));
    type(container, "first");
    const input = composer(container);
    input.value = "draft";
    const [edit, cancel] = container.querySelectorAll<HTMLButtonElement>(
      ".chat__row--queued .chat__meta-action",
    );
    expect(cancel).toBeDefined();
    edit.click();
    expect(input.value).toBe("first\n\ndraft");
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(loadChatEntry(localStorage, key)).toBeUndefined();

    type(container, "again");
    container
      .querySelectorAll<HTMLButtonElement>(".chat__row--queued .chat__meta-action")[1]
      ?.click();
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(loadChatEntry(localStorage, key)).toBeUndefined();
  });

  it("keeps a not-now refusal queued and stops on a changed conversation", async () => {
    const send = vi
      .fn<ChatViewOptions["send"]>()
      .mockResolvedValueOnce({ state: "refused", code: "not_idle" })
      .mockResolvedValueOnce({ state: "refused", code: "identity_changed" });
    const { container } = open({ send });
    controller?.observe(runtime());
    type(container, "deploy");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat__row--queued")).not.toBeNull();

    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(composer(container).value).toBe("deploy");
    expect(container.querySelector(".chat__note")?.textContent).toBe(
      t("chat.returned.identityChanged"),
    );
  });

  it("never sends again by itself after an error that may hide a written prompt", async () => {
    const send = vi.fn<ChatViewOptions["send"]>(async () => {
      throw { code: "hub_join", message: "the task panicked" };
    });
    const { container } = open({ send });
    controller?.observe(runtime());
    type(container, "migrate");
    await flush();
    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(composer(container).value).toBe("migrate");
    expect(container.querySelector(".chat__note")?.textContent).toBe(t("chat.returned.uncertain"));
  });

  it("keeps text given back to the composer across closes until it is sent or cleared", async () => {
    const send = vi.fn<ChatViewOptions["send"]>(async () => ({
      state: "refused" as const,
      code: "identity_changed" as const,
    }));
    const first = open({ send });
    controller?.observe(runtime());
    type(first.container, "deploy");
    await flush();
    leave(first);

    const second = open();
    expect(composer(second.container).value).toBe("deploy");
    expect(second.container.querySelector(".chat__note")?.textContent).toBe(
      t("chat.returned.identityChanged"),
    );
    // Edited, it stays given back.
    const input = composer(second.container);
    input.value = "deploy to staging";
    input.dispatchEvent(new Event("input"));
    leave(second);

    const third = open();
    expect(composer(third.container).value).toBe("deploy to staging");
    // Cleared, it is discarded.
    const cleared = composer(third.container);
    cleared.value = "";
    cleared.dispatchEvent(new Event("input"));
    expect(loadChatEntry(localStorage, key)).toBeUndefined();
  });

  it("delivers a prompt queued in an earlier run when the agent is idle", async () => {
    const earlier = open();
    controller?.observe(runtime({ activity: "working" }));
    type(earlier.container, "left over");
    leave(earlier);

    const { options, container } = open();
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain("left over");
    controller?.observe(runtime());
    await flush();
    expect(options.send).toHaveBeenCalledWith("left over", { terminalEpoch: "terminal-1" });
  });

  it("hands a delivery in flight to the session's next controller, which settles it once", async () => {
    const held = heldSend();
    const first = open({ send: held.send });
    controller?.observe(runtime());
    type(first.container, "ship it");
    await flush();
    expect(held.send).toHaveBeenCalledTimes(1);
    leave(first);

    const second = open();
    expect(second.container.querySelector(".chat__row--queued")?.textContent).toContain(
      t("chat.queue.sending"),
    );
    controller?.observe(runtime());
    await flush();
    // Not taken for a closed app's leftover, and not sent again.
    expect(second.options.send).not.toHaveBeenCalled();
    expect(composer(second.container).value).toBe("");

    held.answer({ state: "written_to_pty", record_id: "r-1" });
    await flush();
    expect(second.container.querySelector(".chat__row--queued")).toBeNull();
    expect(second.container.querySelector(".chat__row--sent")?.textContent).toContain("ship it");
    expect(loadChatEntry(localStorage, key)).toBeUndefined();
    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(second.options.send).not.toHaveBeenCalled();
  });

  it("settles a delivery its controller left, when nobody came back for it", async () => {
    const held = heldSend();
    const first = open({ send: held.send });
    controller?.observe(runtime());
    type(first.container, "ship it");
    await flush();
    leave(first);
    held.answer({ state: "written_to_pty", record_id: "r-1" });
    await flush();
    expect(loadChatEntry(localStorage, key)).toBeUndefined();

    const second = open();
    controller?.observe(runtime());
    await flush();
    expect(second.options.send).not.toHaveBeenCalled();
    expect(second.container.querySelector(".chat__row--queued")).toBeNull();
  });

  it("keeps a prompt added while another is being delivered", async () => {
    const held = heldSend();
    const { container } = open({ send: held.send });
    controller?.observe(runtime());
    type(container, "first");
    await flush();
    expect(held.send).toHaveBeenCalledTimes(1);
    type(container, "second");
    held.answer({ state: "written_to_pty", record_id: "r-1" });
    await flush();
    // The first went; the second goes next while the agent is still idle.
    expect(held.send).toHaveBeenCalledTimes(2);
    expect(held.send.mock.calls[1][0]).toBe("second");
  });

  it("gives a prompt a closed app left mid-delivery back to the composer, and keeps it there", async () => {
    // What a closed app leaves: the prompt, marked as on its way, and no flight.
    localStorage.setItem(
      "dure.chat.queue.v1",
      JSON.stringify({
        version: 1,
        prompts: {
          [key]: {
            kind: "queued",
            text: "maybe written",
            target: { terminalEpoch: "terminal-1" },
            queuedAtMs: 1,
            sending: true,
          },
        },
      }),
    );
    const reopened = open();
    controller?.observe(runtime());
    await flush();
    expect(reopened.options.send).not.toHaveBeenCalled();
    expect(composer(reopened.container).value).toBe("maybe written");
    expect(reopened.container.querySelector(".chat__note")?.textContent).toBe(
      t("chat.returned.uncertain"),
    );
    // Closed again before anyone acted on it: still there, still said so.
    leave(reopened);
    const again = open();
    controller?.observe(runtime());
    await flush();
    expect(again.options.send).not.toHaveBeenCalled();
    expect(composer(again.container).value).toBe("maybe written");
    expect(again.container.querySelector(".chat__note")?.textContent).toBe(
      t("chat.returned.uncertain"),
    );
  });

  it("keeps the field focused, with its selection, when a render moves it", async () => {
    const { container } = open();
    const input = composer(container);
    input.value = "half a wor";
    input.focus();
    input.setSelectionRange(5, 5);
    // The app replaces its tree on every render and mounts the chat again.
    container.remove();
    const next = document.createElement("div");
    document.body.append(next);
    controller?.mount(next);
    await flush();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    expect(input.value).toBe("half a wor");
  });

  it("does not take focus back after the person switched to the terminal", async () => {
    const { container } = open();
    controller?.setVisible(true);
    const input = composer(container);
    input.focus();
    controller?.setVisible(false);
    container.remove();
    const next = document.createElement("div");
    document.body.append(next);
    controller?.mount(next);
    await flush();
    expect(document.activeElement).not.toBe(input);
  });

  it("treats a silent close as a failed ask, and suggests updating only after several", async () => {
    const { options, container } = open({
      fetch: vi.fn(async () => {
        throw { code: "conversation_no_answer", message: "closed" };
      }),
    });
    controller?.observe(runtime());
    controller?.setVisible(true);
    await flush();
    expect(container.querySelector(".chat__status")?.textContent).toBe(t("chat.wait.unreachable"));
    for (let ask = 1; ask < SILENT_CLOSES_BEFORE_UPDATE; ask += 1) {
      controller?.observe(runtime({ turnCompletedCount: String(ask + 1) }));
      await flush();
    }
    expect(container.querySelector(".chat__status")?.textContent).toBe(t("chat.wait.noAnswer"));
    // The chat stays: no forced switch to the terminal.
    expect(options.fallBack).not.toHaveBeenCalled();
  });

  it("refuses a prompt over the limit inline and keeps the text", async () => {
    const { options, container } = open();
    controller?.observe(runtime());
    type(container, "x".repeat(4_000));
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    expect(composer(container).value).toHaveLength(4_000);
    expect(container.querySelector<HTMLElement>(".chat__note")?.hidden).toBe(false);
  });
});

describe("background work line", () => {
  const working = () => runtime({ activity: "working" });
  const answer = () => ({
    hub_conversation_version: 1,
    outcome: "listed" as const,
    items: [{ id: "b1", kind: "shell", label: "Watch CI", started_unix_ms: Date.now() - 5_000 }],
    counts: { subagents: 0, workflows: 0, shells: 1, monitors: 0 },
  });

  beforeEach(() => {
    sessions += 1;
    key = queueKey("hub-1", "box-1", "workspace-1", `bg-session-${sessions}`);
  });
  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    document.body.replaceChildren();
  });

  it("shows the count collapsed, above the composer, while the agent works", async () => {
    const backgroundWork = vi.fn(async () => answer());
    const { container } = open({ backgroundWork });
    controller?.observe(working());
    controller?.setVisible(true);
    await flush();
    await flush();
    const line = container.querySelector<HTMLDetailsElement>(".chat__background");
    expect(backgroundWork).toHaveBeenCalled();
    expect(line?.hidden).toBe(false);
    expect(line?.open).toBe(false);
    expect(line?.querySelector("summary")?.textContent).toContain(
      t("chat.backgroundWork.shells.one"),
    );
    const composer = container.querySelector(".chat__composer");
    expect(
      line && composer && line.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Expanded, the rows sit inside the disclosure.
    expect(line?.querySelector(".chat__background-rows")?.textContent).toContain("Watch CI");
  });

  it("asks nothing and shows nothing while the agent waits", async () => {
    const backgroundWork = vi.fn(async () => answer());
    const { container } = open({ backgroundWork });
    controller?.observe(runtime({ activity: "waiting" }));
    controller?.setVisible(true);
    await flush();
    expect(backgroundWork).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>(".chat__background")?.hidden ?? true).toBe(true);
  });

  it("shows no line for a computer that does not list background work", async () => {
    const { container } = open();
    controller?.observe(working());
    controller?.setVisible(true);
    await flush();
    expect(container.querySelector<HTMLElement>(".chat__background")?.hidden ?? true).toBe(true);
  });

  it("hides the line again when the ask fails", async () => {
    const backgroundWork = vi
      .fn<() => Promise<ReturnType<typeof answer>>>()
      .mockResolvedValueOnce(answer())
      .mockRejectedValueOnce(new Error("conversation_no_answer"));
    const { container } = open({ backgroundWork });
    controller?.observe(working());
    controller?.setVisible(true);
    await flush();
    await flush();
    expect(container.querySelector<HTMLElement>(".chat__background")?.hidden).toBe(false);
    controller?.setVisible(false);
    controller?.setVisible(true);
    await flush();
    await flush();
    expect(container.querySelector<HTMLElement>(".chat__background")?.hidden).toBe(true);
  });
});

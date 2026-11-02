import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { loadQueuedPrompt, queueKey } from "./chatQueue";
import { type ChatController, type ChatViewOptions, createChatView } from "./chatView";
import { t } from "./i18n";
import type { AgentPromptAnswer, ConversationTranscriptAnswer } from "./ipc";

const KEY = queueKey("hub-1", "box-1", "workspace-1", "session-1");

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

const TRANSCRIPT: ConversationTranscriptAnswer = {
  outcome: "transcript",
  provider: "claude",
  conversation_id: "conversation-1",
  entries: [
    { role: "user", text: "Run the tests" },
    { role: "agent", text: "Done:\n\n```\nok 12\n```" },
  ],
  history_complete: true,
  cursor: {
    terminal_epoch: "terminal-2",
    conversation_id: "conversation-1",
    turn_completed_count: 1,
    turn_open: false,
    runtime_revision: 1,
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let controller: ChatController | undefined;

function open(overrides: Partial<ChatViewOptions> = {}) {
  const options = {
    queueKey: KEY,
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

function type(container: HTMLElement, text: string): void {
  const input = container.querySelector<HTMLTextAreaElement>(".chat__input");
  if (!input) throw new Error("no composer");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  container.querySelector<HTMLButtonElement>(".chat__send")?.click();
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
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
    const input = container.querySelector<HTMLTextAreaElement>(".chat__input");
    expect(input?.disabled).toBe(false);

    type(container, "Now lint");
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain("Now lint");
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain(
      t("chat.queue.queued"),
    );
    // Persisted for the session, so it outlives the app.
    expect(loadQueuedPrompt(localStorage, KEY)?.text).toBe("Now lint");

    // Idle with no attention: delivered, fenced on what the person was reading.
    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(options.send).toHaveBeenCalledWith("Now lint", {
      terminalEpoch: "terminal-2",
      conversationId: "conversation-1",
    });
    expect(loadQueuedPrompt(localStorage, KEY)).toBeUndefined();
    expect(container.querySelector(".chat__row--sent")?.textContent).toContain("Now lint");
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
    const input = container.querySelector<HTMLTextAreaElement>(".chat__input");
    if (!input) throw new Error("no composer");
    input.value = "draft";
    const [edit, cancel] = container.querySelectorAll<HTMLButtonElement>(
      ".chat__row--queued .chat__meta-action",
    );
    expect(cancel).toBeDefined();
    edit.click();
    expect(input.value).toBe("first\n\ndraft");
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(loadQueuedPrompt(localStorage, KEY)).toBeUndefined();

    type(container, "again");
    container
      .querySelectorAll<HTMLButtonElement>(".chat__row--queued .chat__meta-action")[1]
      ?.click();
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(loadQueuedPrompt(localStorage, KEY)).toBeUndefined();
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
    expect(loadQueuedPrompt(localStorage, KEY)?.text).toBe("deploy");

    controller?.observe(runtime({ turnCompletedCount: "2" }));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat__row--queued")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".chat__input")?.value).toBe("deploy");
    expect(container.querySelector(".chat__note")?.textContent).toBe(
      t("chat.returned.identityChanged"),
    );
    expect(loadQueuedPrompt(localStorage, KEY)).toBeUndefined();
  });

  it("delivers a prompt queued in an earlier run when the agent is idle", async () => {
    const earlier = open();
    controller?.observe(runtime({ activity: "working" }));
    type(earlier.container, "left over");
    controller?.dispose();
    earlier.container.remove();

    const { options, container } = open();
    expect(container.querySelector(".chat__row--queued")?.textContent).toContain("left over");
    controller?.observe(runtime());
    await flush();
    expect(options.send).toHaveBeenCalledWith("left over", { terminalEpoch: "terminal-1" });
  });

  it("keeps a prompt added while another is being delivered", async () => {
    let answer: (value: AgentPromptAnswer) => void = () => {};
    const send = vi.fn<ChatViewOptions["send"]>(
      () => new Promise<AgentPromptAnswer>((resolve) => {
        answer = resolve;
      }),
    );
    const { container } = open({ send });
    controller?.observe(runtime());
    type(container, "first");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    type(container, "second");
    answer({ state: "written_to_pty", record_id: "r-1" });
    await flush();
    // The first went; the second goes next while the agent is still idle.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe("second");
  });

  it("gives a prompt the app left mid-delivery back to the composer, unsent", async () => {
    let answer: (value: AgentPromptAnswer) => void = () => {};
    const earlier = open({
      send: vi.fn(() => new Promise<AgentPromptAnswer>((resolve) => {
        answer = resolve;
      })),
    });
    controller?.observe(runtime());
    type(earlier.container, "maybe written");
    await flush();
    // The app goes away mid-delivery: storage is all the next run has.
    const stored = localStorage.getItem("dure.chat.queue.v1");
    controller?.dispose();
    earlier.container.remove();
    answer({ state: "written_to_pty" });
    if (stored) localStorage.setItem("dure.chat.queue.v1", stored);

    const { options, container } = open();
    controller?.observe(runtime());
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>(".chat__input")?.value).toBe(
      "maybe written",
    );
    expect(container.querySelector(".chat__note")?.textContent).toBe(t("chat.returned.uncertain"));
    expect(loadQueuedPrompt(localStorage, KEY)).toBeUndefined();
  });

  it("falls back to the terminal when the computer predates the chat", async () => {
    const { options, container } = open({
      fetch: vi.fn(async () => {
        throw { code: "conversation_unsupported", message: "old" };
      }),
    });
    controller?.setVisible(true);
    await flush();
    expect(options.fallBack).toHaveBeenCalledWith("update_computer");
    expect(container.querySelector(".chat__status")?.textContent).toContain(
      t("chat.fallback.updateComputer"),
    );
  });

  it("refuses a prompt over the limit inline and keeps the text", async () => {
    const { options, container } = open();
    controller?.observe(runtime());
    type(container, "x".repeat(4_000));
    await flush();
    expect(options.send).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>(".chat__input")?.value).toHaveLength(4_000);
    expect(container.querySelector<HTMLElement>(".chat__note")?.hidden).toBe(false);
  });
});

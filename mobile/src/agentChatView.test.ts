import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentChatController,
  type AgentChatViewOptions,
  createAgentChatView,
  renderAgentChatScreen,
} from "./agentChatView";
import { t } from "./i18n";
import type { AgentChatActionAnswer, AgentChatTimeline, AgentChatTimelineAnswer, AgentChatWatchNotice } from "./ipc";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function timeline(overrides: Partial<AgentChatTimeline> = {}): AgentChatTimeline {
  return {
    provider_id: "claude",
    items: [
      { kind: "message", sequence: 1, role: "user", text: "Fix the build" },
      { kind: "tool", sequence: 2, name: "Bash", state: "completed" },
      { kind: "message", sequence: 3, role: "agent", text: "Fixed." },
    ],
    older: null,
    history_complete: true,
    latest: 3,
    turn: null,
    live_text: null,
    pending: [],
    queued: [],
    ...overrides,
  };
}

const answer = (value: AgentChatTimeline): AgentChatTimelineAnswer => ({ outcome: "timeline", timeline: value });

let controller: AgentChatController | undefined;

function open(overrides: Partial<AgentChatViewOptions> = {}) {
  const options = {
    fetch: vi.fn(async () => answer(timeline())),
    act: vi.fn(async (): Promise<AgentChatActionAnswer> => ({ state: "done", delivery: "started" })),
    activePollMs: 60_000,
    idlePollMs: 60_000,
    actionId: () => "press-1",
    ...overrides,
  };
  controller = createAgentChatView(options);
  const container = document.createElement("div");
  document.body.append(container);
  controller.mount(container);
  controller.setVisible(true);
  return { options, container };
}

function send(container: HTMLElement, text: string): void {
  const input = container.querySelector<HTMLTextAreaElement>(".chat__input");
  if (!input) throw new Error("no composer");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  container.querySelector<HTMLButtonElement>(".chat__send")?.click();
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

describe("the chat of a chat-owned agent", () => {
  it("draws messages and a tool by name and state", async () => {
    const { container } = open();
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Fix the build");
    expect(text).toContain("Fixed.");
    const tool = container.querySelector(".agent-chat__tool");
    expect(tool?.textContent).toBe(`Bash${t("agentChat.tool.completed")}`);
    expect(container.querySelector<HTMLButtonElement>(".agent-chat__stop")?.hidden).toBe(true);
  });

  it("sends a message and reads the timeline again", async () => {
    const { container, options } = open();
    await flush();
    send(container, "Run the tests");
    await flush();
    expect(options.act).toHaveBeenCalledWith({ kind: "send", actionId: "press-1", text: "Run the tests" });
    expect(options.fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>(".chat__input")?.value).toBe("");
  });

  it("gives a refused message back to the composer and says why", async () => {
    const { container } = open({
      act: vi.fn(async (): Promise<AgentChatActionAnswer> => ({ state: "refused", code: "runtime_unavailable" })),
    });
    await flush();
    send(container, "Run the tests");
    await flush();
    expect(container.querySelector<HTMLTextAreaElement>(".chat__input")?.value).toBe("Run the tests");
    expect(container.querySelector(".chat__note")?.textContent).toBe(t("agentChat.refused.runtimeUnavailable"));
  });

  it("interrupts the running turn it shows", async () => {
    const { container, options } = open({
      fetch: vi.fn(async () => answer(timeline({ turn: { turn_id: "turn-7" }, live_text: "Looking" }))),
    });
    await flush();
    const stop = container.querySelector<HTMLButtonElement>(".agent-chat__stop");
    expect(stop?.hidden).toBe(false);
    expect(container.querySelector(".agent-chat__live")?.textContent).toContain("Looking");
    stop?.click();
    await flush();
    expect(options.act).toHaveBeenCalledWith({ kind: "interrupt", actionId: "press-1", turnId: "turn-7" });
  });

  it("approves or denies a permission request by the tool's name only", async () => {
    const { container, options } = open({
      fetch: vi.fn(async () =>
        answer(timeline({ pending: [{ request_id: "request-1", kind: "permission", tool_name: "Bash", display_name: null }] })),
      ),
      act: vi.fn(async (): Promise<AgentChatActionAnswer> => ({ state: "done" })),
    });
    await flush();
    const card = container.querySelector(".agent-chat__card");
    expect(card?.textContent).toContain(t("agentChat.permission.named", { tool: "Bash" }));
    const allow = [...(card?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === t("agentChat.permission.allow"),
    );
    allow?.click();
    await flush();
    expect(options.act).toHaveBeenCalledWith({
      kind: "answer",
      actionId: "press-1",
      requestId: "request-1",
      answer: { kind: "permission", allow: true },
    });
  });

  it("answers a question once every question has an answer", async () => {
    const { container, options } = open({
      fetch: vi.fn(async () =>
        answer(
          timeline({
            pending: [
              {
                request_id: "request-2",
                kind: "question",
                questions: [
                  {
                    id: "db",
                    question: "Which database?",
                    options: [{ label: "SQLite" }, { label: "Postgres" }],
                    multi_select: false,
                    allow_other: false,
                    is_secret: false,
                  },
                ],
              },
            ],
          }),
        ),
      ),
      act: vi.fn(async (): Promise<AgentChatActionAnswer> => ({ state: "done" })),
    });
    await flush();
    const submit = [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__card button")].find(
      (button) => button.textContent === t("agentChat.question.submit"),
    );
    expect(submit?.disabled).toBe(true);
    const option = [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__option")].find(
      (button) => button.textContent === "Postgres",
    );
    option?.click();
    expect(option?.getAttribute("aria-pressed")).toBe("true");
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await flush();
    expect(options.act).toHaveBeenCalledWith({
      kind: "answer",
      actionId: "press-1",
      requestId: "request-2",
      answer: { kind: "question", answers: { db: "Postgres" } },
    });
  });

  /** Acceptance: an older computer reads as a clear "update the desktop" state. */
  it("says to update the computer when it does not speak this chat", async () => {
    const { container } = open({
      fetch: vi.fn(async () => {
        throw { code: "agent_chat_desktop_outdated", message: "old" };
      }),
    });
    await flush();
    expect(container.querySelector(".chat__status")?.textContent).toContain(t("agentChat.fallback.updateDesktop"));
    expect(container.querySelector<HTMLButtonElement>(".chat__send")?.disabled).toBe(true);
  });

  it("pages back to older messages and keeps them across a refresh", async () => {
    const fetch = vi.fn(async (before?: number) =>
      before === undefined
        ? answer(timeline({ items: [{ kind: "message", sequence: 5, role: "agent", text: "Newest" }], older: 5, history_complete: false }))
        : answer(timeline({ items: [{ kind: "message", sequence: 2, role: "user", text: "Oldest" }], older: null })),
    );
    const { container } = open({ fetch });
    await flush();
    const older = container.querySelector<HTMLButtonElement>(".agent-chat__older");
    expect(older?.hidden).toBe(false);
    older?.click();
    await flush();
    expect(fetch).toHaveBeenLastCalledWith(5);
    const text = container.textContent ?? "";
    expect(text.indexOf("Oldest")).toBeGreaterThan(-1);
    expect(text.indexOf("Oldest")).toBeLessThan(text.indexOf("Newest"));
    expect(older?.hidden).toBe(true);
  });
});

/** A computer that tells the chat of changes: the test plays its notices. */
function watchable() {
  const notify: ((notice: AgentChatWatchNotice) => void)[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const watch = vi.fn(async (onNotice: (notice: AgentChatWatchNotice) => void) => {
    notify.push(onNotice);
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  return { watch, notify, stops };
}

describe("a chat the computer tells of changes", () => {
  it("reads the page again on each change, folding a burst into one more read", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<AgentChatTimelineAnswer>((resolve) => {
          release = () => resolve(answer(timeline()));
        }),
    );
    const { watch, notify } = watchable();
    open({ fetch, watch });
    await flush();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    release?.();
    await flush();

    notify[0]?.("changed");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let delta = 0; delta < 20; delta += 1) notify[0]?.("changed");
    release?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    release?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shows the answer as it is written", async () => {
    let text = "Looking";
    const fetch = vi.fn(async () =>
      answer(timeline({ turn: { turn_id: "turn-1" }, live_text: text })),
    );
    const { watch, notify } = watchable();
    const { container } = open({ fetch, watch });
    await flush();
    expect(container.querySelector(".agent-chat__live")?.textContent).toContain("Looking");
    text = "Looking at the failing test";
    notify[0]?.("changed");
    await flush();
    expect(container.querySelector(".agent-chat__live")?.textContent).toContain("Looking at the failing test");
  });

  it("stops watching when the chat is hidden or closed, and ignores what an old watch says", async () => {
    const fetch = vi.fn(async () => answer(timeline()));
    const { watch, notify, stops } = watchable();
    open({ fetch, watch });
    await flush();
    controller?.setVisible(false);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    const reads = fetch.mock.calls.length;
    notify[0]?.("changed");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(reads);

    controller?.setVisible(true);
    await flush();
    expect(watch).toHaveBeenCalledTimes(2);
    controller?.dispose();
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  it("stops a watch the computer took after the chat was hidden", async () => {
    let take: ((stop: () => void) => void) | undefined;
    const watch = vi.fn(() => new Promise<() => void>((resolve) => (take = resolve)));
    open({ watch });
    controller?.setVisible(false);
    const stop = vi.fn();
    take?.(stop);
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  describe("when a watch ends", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps asking on its interval and watches again later", async () => {
      const fetch = vi.fn(async () => answer(timeline()));
      const { watch, notify } = watchable();
      open({ fetch, watch, activePollMs: 4_000, idlePollMs: 12_000, rewatchMs: 2_000 });
      await vi.advanceTimersByTimeAsync(0);
      notify[0]?.("changed");
      await vi.advanceTimersByTimeAsync(0);
      notify[0]?.("ended");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(watch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(watch).toHaveBeenCalledTimes(2);
      const reads = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(12_000);
      expect(fetch.mock.calls.length).toBeGreaterThan(reads);
    });

    it("waits longer after each watch the computer would not take", async () => {
      const watch = vi.fn(async () => {
        throw { code: "hub_unreachable", message: "gone" };
      });
      open({ watch, rewatchMs: 2_000 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(watch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(watch).toHaveBeenCalledTimes(3);
    });

    it("asks at the active pace only while no watch is taken", async () => {
      const fetch = vi.fn(async () => answer(timeline({ turn: { turn_id: "turn-1" } })));
      const { watch, notify } = watchable();
      open({ fetch, watch, activePollMs: 4_000, idlePollMs: 12_000 });
      await vi.advanceTimersByTimeAsync(0);
      notify[0]?.("changed");
      await vi.advanceTimersByTimeAsync(0);
      const watchedReads = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetch).toHaveBeenCalledTimes(watchedReads);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fetch).toHaveBeenCalledTimes(watchedReads + 1);
    });
  });

  it("only asks on its interval where the computer cannot tell", async () => {
    const { options } = open();
    await flush();
    expect(options.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the chat-owned agent screen", () => {
  it("has a back button and the chat, and no terminal", () => {
    const back = vi.fn();
    const screen = renderAgentChatScreen(
      { title: "Fix the build", machine: "Laptop" },
      { back, chat: (container) => container.append(document.createElement("section")) },
    );
    expect(screen.querySelector(".session__title")?.textContent).toBe("Fix the build");
    expect(screen.querySelector(".session__chat section")).not.toBeNull();
    expect(screen.querySelector(".session__views")).toBeNull();
    screen.querySelector<HTMLButtonElement>(".icon-tap")?.click();
    expect(back).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentChatController,
  type AgentChatViewOptions,
  createAgentChatView,
  renderAgentChatScreen,
} from "./agentChatView";
import { t } from "./i18n";
import type { AgentChatActionAnswer, AgentChatTimeline, AgentChatTimelineAnswer } from "./ipc";

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
    actionId: (kind: string) => `${kind}-1`,
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
    expect(options.act).toHaveBeenCalledWith({ kind: "send", actionId: "send-1", text: "Run the tests" });
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
    expect(options.act).toHaveBeenCalledWith({ kind: "interrupt", actionId: "stop-1", turnId: "turn-7" });
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
      actionId: "answer-1",
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
      actionId: "answer-1",
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

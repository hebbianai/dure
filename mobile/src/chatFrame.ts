/**
 * The surface a chat is drawn on: the scrolling message log, its status line
 * and the composer, with the behaviour both chats need from it.
 *
 * The session's Chat tab (`chatView.ts`) and a chat-owned agent's chat
 * (`agentChatView.ts`) read different conversations and act differently, but
 * they stand on the same frame. Its rules live here once:
 *
 * - **The log follows the end** while the person is at the end, and stays
 *   where they scrolled to otherwise.
 * - **The composer keeps its focus and selection** across the app's redraws.
 *   The app replaces its whole tree on every render; one frame lives as long
 *   as its chat and is mounted into each new tree.
 * - **The field grows with its text** up to the stylesheet's cap, and the
 *   send button never takes the keyboard down.
 * - **Pulling the log down asks again.**
 */

import "./chatView.css";
import iconArrowRight from "./assets/icon-arrow-right.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import { attachPullToRefresh } from "./pullToRefresh";

/** Close enough to the end that new messages should keep it in view. */
const BOTTOM_SLACK_PX = 32;

export interface ChatFrameOptions {
  /** Extra classes on the frame. */
  readonly className?: string;
  /** What sits above the messages, under the pull mark (the "older" line). */
  readonly top: HTMLElement;
  /** What sits between the log and the composer, in order. */
  readonly aboveComposer?: readonly HTMLElement[];
  /** Controls in the composer before the send button. */
  readonly composerControls?: readonly HTMLElement[];
  /** Pull-to-refresh asks this. */
  readonly refresh: () => void;
}

export interface ChatFrame {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  /** The messages the conversation holds. */
  readonly list: HTMLElement;
  /** What is on its way or not yet a message, under the list. */
  readonly outgoing: HTMLElement;
  readonly status: HTMLElement;
  /** The composer's one line of feedback. */
  readonly note: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  /** Keep the newest message in view from now on. */
  pin(): void;
  /** Scroll to the end if the log follows it. */
  followEnd(): void;
  /** Grow the field with its text. */
  fitInput(): void;
  /** Put the frame into `container`, keeping its place, focus and selection. */
  mount(container: HTMLElement): void;
  /** The chat was hidden: the person left the field. */
  release(): void;
}

export function createChatFrame(options: ChatFrameOptions): ChatFrame {
  let pinned = true;
  let savedScrollTop = 0;
  /** The person was typing here; a re-render moving the field must not end that. */
  let wantsFocus = false;

  const root = element("section", options.className ? `chat ${options.className}` : "chat");
  const scroll = element("div", "chat__scroll");
  const pull = element("div", "home__pull chat__pull");
  pull.append(element("span", "home__pull-mark"));
  const list = element("div", "chat__messages");
  list.setAttribute("role", "log");
  list.setAttribute("aria-label", t("chat.messages"));
  const outgoing = element("div", "chat__outgoing");
  const status = element("p", "chat__status");
  scroll.append(pull, options.top, list, outgoing, status);

  const note = element("p", "chat__note");
  note.setAttribute("role", "status");
  const composer = element("div", "chat__composer");
  const input = element("textarea", "chat__input");
  input.rows = 1;
  input.setAttribute("aria-label", t("chat.composer.label"));
  const send = element("button", "chat__send");
  send.type = "button";
  send.append(glyph(iconArrowRight, 18));
  composer.append(input, ...(options.composerControls ?? []), send);
  root.append(scroll, ...(options.aboveComposer ?? []), note, composer);

  scroll.addEventListener("scroll", () => {
    if (!scroll.isConnected) return;
    savedScrollTop = scroll.scrollTop;
    pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < BOTTOM_SLACK_PX;
  });
  input.addEventListener("focus", () => {
    wantsFocus = true;
  });
  input.addEventListener("blur", () => {
    // Moving the field into the next render's tree can blur it; the restore in
    // `mount` runs before this looks. A field still in the tree and still not
    // focused is one the person left.
    setTimeout(() => {
      if (input.isConnected && document.activeElement !== input) wantsFocus = false;
    }, 0);
  });
  // The send circle must not take the keyboard down with the field's focus.
  send.addEventListener("pointerdown", (event) => event.preventDefault());
  attachPullToRefresh(scroll, pull, options.refresh, () => scroll.scrollTop);

  return {
    root,
    scroll,
    list,
    outgoing,
    status,
    note,
    input,
    send,
    pin() {
      pinned = true;
    },
    followEnd() {
      if (pinned && scroll.isConnected) scroll.scrollTop = scroll.scrollHeight;
    },
    fitInput() {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    },
    mount(container) {
      if (root.parentElement === container) return;
      // Read before the move: the app replaced the old tree already, and the
      // field may have lost focus with it, but its selection is still its own.
      const restore = wantsFocus;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const direction = input.selectionDirection;
      container.append(root);
      // After the caller's tree is in the document: a detached node has no
      // scroll position to restore and cannot take focus.
      queueMicrotask(() => {
        if (!scroll.isConnected) return;
        scroll.scrollTop = pinned ? scroll.scrollHeight : savedScrollTop;
        // Same task as the render that moved it, so the OS keyboard stays up.
        if (restore && document.activeElement !== input) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(start, end, direction ?? undefined);
        }
      });
    },
    release() {
      wantsFocus = false;
    },
  };
}

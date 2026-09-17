/**
 * One session, with the tray that lets a phone drive a terminal.
 * Figma `dure-UI` 2829:75893 (command history open) and 2863:75522 (the other
 * sessions open).
 *
 * # Why there is an input box at all
 *
 * A touch keyboard has no Ctrl, no Esc, no arrows, and no way to hold one key
 * while pressing another. The tray provides those semantic keys, and the box
 * beside it sends a complete line — which also makes a phone usable one-handed
 * on a train.
 *
 * The terminal is still the transcript, and it is still where output appears.
 *
 * # What the header does not claim
 *
 * The mockup's subtitle reads "terminals 2개 · claude 활성". This phone attaches
 * to one session and the hub catalog carries no terminal count, so the line
 * says what is actually known: the run state, the provider, and the machine.
 * A count nobody sent would be the screen measuring something it never asked.
 */

import type { AttachedSession } from "./ipc";
import type { SentCommand } from "./commandHistory";
import type { UnifiedRow } from "./allSessions";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconGitBranch from "./assets/icon-git-branch.svg";
import iconArrowLeftRight from "./assets/icon-arrow-left-right.svg";
import iconArrowRight from "./assets/icon-arrow-right.svg";
import iconChevronsLeft from "./assets/icon-chevrons-left.svg";
import iconCommand from "./assets/icon-command.svg";
import iconHistory from "./assets/icon-history.svg";
import iconKeyboard from "./assets/icon-keyboard.svg";
import { element, fadeWhileScrollable, glyph, loader, statusDot } from "./dom";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { keyTapFeedback } from "./haptics";
import { t } from "./i18n";
import { KEY_CATEGORIES, TERMINAL_KEYS, type TerminalKey } from "./terminalKeys";
import { lifecycleState, runState } from "./sessionRows";
import { attachDoubleTap } from "./doubleTap";
import { attachHoldDrag } from "./holdDrag";
import type { TrackpadDirection } from "./spaceTrackpad";
import { attachTerminalKeyboard } from "./terminalKeyboard";
import type { TerminalKeyEvent } from "@/lib/terminal/state/terminalInputIntent";
import type { RemoteSession } from "./sessions";
import { sessionTitle } from "./sessions";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { loadHomeViewOptions } from "./homeViewPreferences";
import { renderSessionSwitcher, type SessionSibling } from "./sessionSwitcher";
import type { TerminalPasteContent } from "./terminalPaste";
import { showTerminalPasteMenu } from "./terminalPasteMenu";
import { hasTerminalTextSelection } from "./terminalTextSelection";

/** Which drawer is open under the input, if any. */
export type SessionPanel = "none" | "history" | "sessions" | "keys";

export interface SessionModel {
  readonly machineLabel: string;
  /**
   * Where this session sits in the laptop's sidebar — desktop, then project.
   *
   * The header's second line in 3017:81400 and its five siblings: a trail with
   * chevrons between the segments, not a list of facts joined by dots. Empty
   * when the laptop has not placed this session, and then the line falls back
   * to what the phone does know. An empty trail is never drawn as one segment
   * of nothing.
   */
  readonly trail?: readonly string[];
  /**
   * The branch this session is sitting on, when the laptop said so.
   *
   * Absent is a real answer — not every session is a repository, and the laptop
   * may not have read its status yet. Nothing is drawn then; a dash would make
   * "we do not know" look like "there is none".
   */
  readonly branch?: string;
  /**
   * 왜 보기만 되는지, 사람이 읽는 말로. 모르면 없다 — 그때는 역할만 말한다.
   *
   * 위쪽 빨간 배너가 아니라 이 줄에 있는 이유: 세션은 **열렸다**. 열리지 않은
   * 것처럼 읽히는 자리에 두면, 잘 열린 화면 위에 실패가 얹힌다.
   */
  readonly watchReason?: string;
  /** This attachment is unavailable; the session's role and runtime facts remain unchanged. */
  readonly unavailable?: string;
  /** Latest Host observation for this attachment; lifecycle alone does not imply work. */
  readonly runtime?: AgentRuntimeState;
  readonly session: RemoteSession;
  readonly attached: AttachedSession;
  readonly panel: SessionPanel;
  /**
   * The keys in the tray, as this phone has them saved.
   *
   * Passed in rather than read here so the view stays a function of its input,
   * and so the editor and the tray can never disagree about what is in it.
   */
  readonly tray: readonly TerminalKey[];
  /** The modifier waiting for the next press, by id. */
  readonly armed?: string;
  readonly history: readonly SentCommand[];
  /** Every other session this phone can open right now. */
  readonly siblings: readonly SessionSibling[];
  readonly viewOptions?: SpacesViewOptions;
  readonly nowMs: number;
  /** The session being attached to right now, if any. */
  readonly opening?: string;
  /** A tick under the finger on every tray key, arrow and cap. */
  readonly haptics: boolean;
}

export interface SessionActions {
  readonly back: () => void;
  /**
   * The transcript node, owned by the caller.
   *
   * Not "mount into this node I made": the surface inside it has to survive
   * a re-render, and this screen re-renders whenever Ctrl is armed or a drawer
   * opens. The caller keeps the node for as long as the attach lives.
   */
  readonly transcript: (stage: HTMLElement) => HTMLElement;
  readonly enableInput: () => void;
  readonly press: (keyId: string) => void;
  /** Characters from the OS keyboard, straight through to the session. */
  readonly type: (text: string) => void;
  readonly paste: (content?: TerminalPasteContent) => void | Promise<void>;
  readonly nativeKey: (event: TerminalKeyEvent) => void;
  /** Input-history projection owned by the attachment, not this render. */
  readonly draft: () => string;
  /** Enter. Characters have already reached the session. */
  readonly submit: () => void;
  readonly togglePanel: (panel: Exclude<SessionPanel, "none">) => void;
  readonly runCommand: (text: string) => void;
  readonly openSession: (row: UnifiedRow) => void;
  /** The git button. Figma 3042:80841 — Source control. */
  readonly openSourceControl: () => void;
}

/**
 * The glass header: back, what this session is, and how it is doing.
 */
function header(model: SessionModel, actions: SessionActions): HTMLElement {
  const bar = element("header", "session__header");
  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back);

  const text = element("div", "session__heading");
  text.append(element("h1", "session__title", sessionTitle(model.session)));
  const details = element("div", "session__details");
  details.append(sessionStateMark(model));
  const trail = (model.trail ?? []).filter((segment) => segment.trim() !== "");
  if (trail.length > 0) {
    // Where this session lives. The frames drew a chevron trail, but nothing
    // else in the app or the desktop reads as a breadcrumb; the rows join
    // their clauses with a middle dot, and so does this line (2026-09-15 승연).
    details.append(element("span", "session__detail", trail.join(" · ")));
  } else {
    // No placement reached this phone. Rather than draw an empty trail, say
    // what is known: which agent, which machine, and — when the laptop said so
    // — the branch. A session that is not a repository has one fewer clause.
    const facts = [
      model.session.launch_program ?? model.session.provider_id,
      model.machineLabel,
      ...(model.branch ? [model.branch] : []),
    ];
    details.append(element("span", "session__detail", facts.join(" · ")));
  }
  text.append(details);
  bar.append(text);

  // Two icons, as 3017:81400 draws them: the connection's own terms, and the
  // way to another session. The switcher lived in the tray until this design
  // gave the tray's three slots to History, Command and Keyboard — so it comes
  // up here, into the slot the older mockup left undecided.
  const icons = element("div", "session__icons");
  const branch = element("button", "icon-tap session__icon--connection");
  branch.type = "button";
  branch.setAttribute("aria-label", t("소스 컨트롤"));
  branch.append(glyph(iconGitBranch, 20));
  branch.addEventListener("click", actions.openSourceControl);
  const switcher = element("button", "icon-tap session__icon--sessions");
  switcher.type = "button";
  switcher.setAttribute("aria-label", t("다른 세션"));
  switcher.setAttribute("aria-pressed", String(model.panel === "sessions"));
  switcher.append(glyph(iconArrowLeftRight, 20));
  // Which way this press goes is decided where the panel lives, not from the
  // model this render closed over: the drawer can be closed out from under it
  // when the keyboard takes its space, and a stale copy would then read the
  // press as "close" and light nothing.
  switcher.addEventListener("click", () => actions.togglePanel("sessions"));
  icons.append(branch, switcher);
  bar.append(icons);
  return bar;
}

type SessionStateModel = Pick<SessionModel, "session" | "runtime" | "unavailable">;

function sessionStateMark(model: SessionStateModel): HTMLElement {
  const { runtime, unavailable } = model;
  const state = unavailable !== undefined ? "unknown"
    : runtime ? lifecycleState(runtime.lifecycle) : runState(model.session);
  const working = unavailable === undefined && runtime?.lifecycle === "running" &&
    runtime.activity === "working" && runtime.attention === "none";
  const mark = working ? loader(12) : statusDot(state);
  if (working) mark.setAttribute("aria-label", t("common.working"));
  mark.classList.add("session__state");
  return mark;
}

/** Runtime observations repaint only the mark, preserving the native keyboard and selection. */
export function paintSessionState(scope: ParentNode, model: SessionStateModel): void {
  scope.querySelector(".session__state")?.replaceWith(sessionStateMark(model));
}

/** One chip in the tray. */
function trayChip(key: TerminalKey, model: SessionModel, actions: SessionActions): HTMLElement {
  const chip = element("button", "tray__key", key.label);
  chip.type = "button";
  chip.dataset.key = key.id;
  if (key.modifier) chip.dataset.modifier = "";
  // Only the armed one lights: with two modifiers a shared flag would light
  // both and the chip would claim something no press can produce.
  const armed = key.modifier && model.armed === key.id;
  if (armed) chip.classList.add("tray__key--armed");
  if (key.modifier) chip.setAttribute("aria-pressed", String(armed));
  tapKeyControl(chip, model, actions, key.id);
  return chip;
}

/**
 * A finger on a key: the keyboard stays up, the phone ticks, the key goes out.
 *
 * Only the three places a finger lands on a drawn key — the strip's chips, the
 * arrow pill and the key drawer's caps. Not the double-tap Tab, the hold-drag,
 * the space-bar trackpad (up to forty presses per move) or the OS keyboard's
 * own Backspace: those are gestures, and a tick per press would be a buzz.
 */
function tapKeyControl(
  control: HTMLButtonElement,
  model: SessionModel,
  actions: SessionActions,
  keyId: string,
): void {
  control.disabled = model.attached.role !== "controller" || model.unavailable !== undefined;
  keepKeyboard(control);
  control.addEventListener("click", () => {
    if (control.disabled) return;
    keyTapFeedback(model.haptics);
    actions.press(keyId);
  });
}

/**
 * Lets a control be pressed without the OS keyboard going down.
 *
 * The keyboard is up because a field holds focus, and pressing a button takes
 * that focus by default — which is the keyboard's cue to leave. These controls
 * do not want focus at all: they send a key, and the field goes on being the
 * thing you are typing into. Refusing the default press leaves it there, and
 * the click still arrives (2026-09-04 user report).
 */
function keepKeyboard(control: HTMLElement): void {
  const hold = (event: Event) => event.preventDefault();
  // Both, because they are not the same event on every engine: WebKit moves
  // focus on the `mousedown` it synthesises after `pointerdown`.
  control.addEventListener("pointerdown", hold);
  control.addEventListener("mousedown", hold);
}

/**
 * Repaints which modifier is armed, in place.
 *
 * Arming is the one press that changes what the tray *says*, and saying it
 * through a render would replace the whole tree — taking the focused field,
 * and the keyboard with it. So it is painted the way an open drawer is closed
 * and a trackpad drag is lit: on the nodes already standing.
 */
export function paintArmedKey(scope: ParentNode, armed: string | undefined): void {
  // The strip's chips and the drawer's caps both carry a modifier; each lights
  // in its own dress. No hint under the grid: the lit cap is the hint
  // (3211:82211 draws the grid alone).
  for (const chip of scope.querySelectorAll<HTMLElement>("[data-modifier]")) {
    const lit = chip.dataset.key === armed;
    const cap = chip.classList.contains("keys-grid__key");
    chip.classList.toggle(cap ? "keys-grid__key--armed" : "tray__key--armed", lit);
    chip.setAttribute("aria-pressed", String(lit));
  }
}

/** A drawer toggle. Pressing the open one closes it. */
function panelButton(
  panel: Exclude<SessionPanel, "none">,
  source: string,
  label: string,
  model: SessionModel,
  actions: SessionActions,
): HTMLElement {
  // The class carries which drawer this is, not the label: labels go through
  // `t()`, so a test that found them by label would break every time somebody
  // fixed a translation.
  const button = element("button", `tray__toggle tray__toggle--${panel}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(model.panel === panel));
  if (model.panel === panel) button.classList.add("tray__toggle--on");
  button.append(glyph(source, 16));
  // See the switcher above: the open/close decision belongs to the panel's
  // owner, because this model can be a render behind.
  button.addEventListener("click", () => actions.togglePanel(panel));
  return button;
}

/** Drops the OS keyboard by releasing whatever focus is holding it up. */
export function lowerKeyboard(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) focused.blur();
}

/**
 * Hands the drawer's space over to a keyboard that is on its way up, and says
 * when the handover is done.
 *
 * `covered` is how much of the screen the keyboard has taken so far. The
 * drawer gives up exactly that much, so the pill stands at max(drawer,
 * keyboard) the whole way and climbs once: the keyboard slides over the
 * drawer instead of the drawer vanishing from under the pill (2026-09-03 user
 * report). Nothing here re-renders — a render would detach the field that
 * raised the keyboard and take the keyboard back down with it.
 */
export function yieldTrayDrawer(scope: ParentNode, covered: number): boolean {
  const panel = scope.querySelector<HTMLElement>(".tray__panel");
  if (!panel) return true;
  if (covered <= 0) {
    // The keyboard gave up on the way, so the drawer takes its space back.
    panel.style.removeProperty("height");
    panel.style.removeProperty("min-height");
    delete panel.dataset.trayHeight;
    return false;
  }
  const natural = Number(panel.dataset.trayHeight) || panel.offsetHeight;
  panel.dataset.trayHeight = String(natural);
  if (covered >= natural) {
    closeTrayDrawer(scope);
    return true;
  }
  // The keyboard's height of room the drawer keeps is exactly what it is
  // handing over, so it cannot go on holding that floor while it does.
  panel.style.minHeight = "0";
  panel.style.height = `${natural - covered}px`;
  return false;
}

/**
 * Closes the open drawer in place, without going through a render.
 *
 * The keyboard can be raised by something that is not the tray — tapping the
 * transcript is the common one — and the drawer holds the space the keyboard
 * takes, so the pill would light two of its three at once. Re-rendering to
 * close it would detach whatever holds focus and take the keyboard straight
 * back down, which is why the tree is corrected here and the model is written
 * beside it. Same reason as `showSend` below.
 */
export function closeTrayDrawer(scope: ParentNode): void {
  scope.querySelector(".tray__panel")?.remove();
  for (const toggle of scope.querySelectorAll(".tray__toggle--on")) {
    toggle.classList.remove("tray__toggle--on");
    toggle.setAttribute("aria-pressed", "false");
  }
  // The session switcher opens into the same tray; it just sits in the header
  // rather than the pill (3017:81400).
  scope.querySelector(".session__icon--sessions")?.setAttribute("aria-pressed", "false");
}

/** The command history drawer. Figma 2829:75893. */
function historyPanel(model: SessionModel, actions: SessionActions): HTMLElement {
  const panel = element("div", "tray__panel");
  panel.append(element("div", "tray__panel-label", t("최근")));
  if (model.history.length === 0) {
    // Nothing has been typed from this phone yet. Saying so beats an empty box
    // that reads as a screen that failed to load.
    panel.append(element("p", "empty__hint", t("이 폰에서 보낸 명령이 아직 없습니다")));
    return panel;
  }
  const scroll = element("div", "tray__panel-scroll");
  for (const entry of model.history) {
    const row = element("button", "history-item");
    row.type = "button";
    row.disabled = model.attached.role !== "controller" || model.unavailable !== undefined;
    row.append(glyph(iconHistory, 16, "history-item__mark"));
    row.append(element("span", "history-item__text", entry.text));
    row.addEventListener("click", () => { if (!row.disabled) actions.runCommand(entry.text); });
    scroll.append(row);
  }
  panel.append(scroll);
  fadeWhileScrollable(scroll, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
  return panel;
}

/**
 * Every key this app can send. Figma 3211:82211.
 *
 * Only the grid: the frame draws eight caps to a row and nothing else, and
 * the owner asked for exactly that (2026-09-04) — the strip's own chips, the
 * arrow pad's switch and the way into the key-strip screen are gone from
 * here. The strip is edited under 설정 → 키 스트립, and the arrows ride the
 * space bar. What the grid holds is the same vocabulary that screen offers,
 * card by card in its order, so the two never disagree about what a key is.
 */
function keysPanel(model: SessionModel, actions: SessionActions): HTMLElement {
  const panel = element("div", "tray__panel");
  const grid = element("div", "keys-grid");
  for (const category of KEY_CATEGORIES) {
    for (const key of TERMINAL_KEYS) {
      if (key.category !== category.id) continue;
      const cap = element("button", "keys-grid__key", key.label);
      cap.type = "button";
      if (key.wide) cap.classList.add("keys-grid__key--wide");
      // A modifier arms rather than sends, and the cap says so while it is
      // armed — the same way the strip's own chip does.
      if (key.modifier) {
        cap.dataset.key = key.id;
        cap.dataset.modifier = "";
        const armed = model.armed === key.id;
        cap.setAttribute("aria-pressed", String(armed));
        if (armed) cap.classList.add("keys-grid__key--armed");
      }
      // Pressing a cap must not take the keyboard down: see `keepKeyboard`.
      tapKeyControl(cap, model, actions, key.id);
      grid.append(cap);
    }
  }
  // Eight rows of caps are taller than a keyboard, so the grid scrolls inside
  // the drawer, and the fade at its foot says there is more until there is not.
  const scroll = element("div", "tray__panel-scroll");
  scroll.append(grid);
  panel.append(scroll);
  fadeWhileScrollable(scroll, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
  return panel;
}

/**
 * The floating arrows over the transcript. Figma 3021:81309, pill 3099:80642.
 *
 * A row, not a cross. The cross took a 60px square out of the transcript's top
 * corner; the frame lays the four out in one pill so it covers a single line of
 * output instead of three, and the order is the one a thumb sweeps — back,
 * up, down, forward.
 *
 * Always in the tree, shown by the stylesheet while a space-bar drag runs —
 * the pill is what says which way the drag is going
 * (`showTrackpadDirection`). The drag's state lives on the tree, not in the
 * model, because a render would replace the field the drag is happening in.
 */
function dpad(model: SessionModel, actions: SessionActions): HTMLElement {
  const pad = element("div", "dpad");
  for (const [id, label] of [
    ["left", "←"],
    ["up", "↑"],
    ["down", "↓"],
    ["right", "→"],
  ] as const) {
    const key = element("button", "dpad__key");
    key.type = "button";
    key.dataset.direction = id;
    key.setAttribute("aria-label", label);
    // One exported arrow, turned: the frame's four are the same Lucide glyph.
    // And its fast face, a double chevron (3319:85086), the same way.
    key.append(glyph(iconArrowRight, 16, `dpad__glyph dpad__glyph--arrow dpad__glyph--${id}`));
    key.append(
      glyph(iconChevronsLeft, 16, `dpad__glyph dpad__glyph--fast dpad__glyph--fast-${id}`),
    );
    tapKeyControl(key, model, actions, id);
    pad.append(key);
  }
  return pad;
}

/**
 * Lights the arrow a space-bar drag is pressing, or none.
 *
 * On the tree rather than through the model: the drag runs while the OS
 * keyboard is up, and a render would replace the field that holds it.
 */
export function showTrackpadDirection(
  scope: ParentNode,
  direction: TrackpadDirection | undefined,
  fast = false,
): void {
  const pad = scope.querySelector<HTMLElement>(".dpad");
  if (!pad) return;
  pad.classList.toggle("dpad--dragging", direction !== undefined);
  pad.classList.toggle("dpad--fast", direction !== undefined && fast);
  for (const key of pad.querySelectorAll<HTMLElement>(".dpad__key")) {
    key.classList.toggle("dpad__key--active", key.dataset.direction === direction);
  }
}

export function renderSessionScreen(
  model: SessionModel,
  originalActions: SessionActions,
): HTMLElement {
  let keyboardInput: ReturnType<typeof attachTerminalKeyboard> | undefined;
  const actions: SessionActions = {
    ...originalActions,
    press: key => {
      if (!TERMINAL_KEYS.find(candidate => candidate.id === key)?.modifier) keyboardInput?.finish();
      originalActions.press(key);
    },
    runCommand: text => { keyboardInput?.finish(); originalActions.runCommand(text); },
    paste: content => {
      keyboardInput?.finish();
      const result = originalActions.paste(content);
      void Promise.resolve(result).then(() => showSend());
      return result;
    },
  };
  const inputEnabled = model.attached.role === "controller" && model.unavailable === undefined;
  const screen = element("section", "session");
  screen.append(header(model, actions));

  // Read-only is said only when it is true. A line that is always on screen is
  // one nobody reads, and this one has to be read before handing the phone over.
  if (!inputEnabled) {
    const readOnly = element("p", "banner banner--warn");
    readOnly.append(
      element(
        "span",
        undefined,
        // 왜 읽기 전용인지는 다음에 할 일을 바꾼다: 남이 잡고 있는 것이면
        // 입력 켜기가 언젠가 되고, 보기 전용으로 짝지어진 것이면 영원히 안 된다.
        model.unavailable ?? model.watchReason ??
          t("읽기 전용({role}) — 입력은 전달되지 않습니다", { role: model.attached.role }),
      ),
    );
    const enable = element("button", "banner__action", t(model.unavailable === undefined ? "입력 켜기" : "지금 재연결"));
    enable.type = "button";
    enable.disabled = model.opening === model.session.session_id;
    enable.addEventListener("click", actions.enableInput);
    readOnly.append(enable);
    screen.append(readOnly);
  }

  const stage = element("div", "session__stage");
  // Handed over rather than built here: the surface inside it outlives any one
  // render, and this screen re-renders on every keypress that arms Ctrl.
  const host = actions.transcript(stage);
  stage.append(host);
  // The arrow pad floats over the transcript rather than sitting in the tray:
  // with the OS keyboard up the tray is pushed to the top of the keyboard, and
  // arrows are what somebody needs while typing — history, menus, completion.
  stage.append(dpad(model, actions));
  // Empty space retains double-tap Tab and held arrows. Rendered text and
  // selection handles belong to WebKit, including while the keyboard is open.
  const onTranscript = (target: EventTarget | null): boolean =>
    model.unavailable === undefined && !hasTerminalTextSelection(host) &&
      !(target instanceof Element && target.closest("button, [data-terminal-run]:not([data-terminal-blank])") !== null);
  attachDoubleTap(stage, { onDouble: () => actions.press("tab"), counts: onTranscript });
  // Hold, then drag: the arrows, without the keyboard (`holdDrag.ts`). The
  // same pill lights the way as for the space-bar drag.
  attachHoldDrag(stage, {
    press: (direction) => actions.press(direction),
    direction: (direction, fast) => showTrackpadDirection(screen, direction, fast),
    counts: onTranscript,
    hold: inputEnabled ? point => showTerminalPasteMenu(screen, point, () => { void actions.paste(); }) : undefined,
  });
  screen.append(stage);

  const tray = element("div", "tray");
  // One row: a floating pill, and a seat beside it that is always there. The
  // frames (3017:81505 nothing to send, 3017:81555 something to send) let the
  // send circle appear beside the pill and take 60px from it, which dropped a
  // chip the moment somebody typed; the seat instead holds the keyboard toggle
  // until there is something to send, and the send circle then, so the pill
  // never changes width (2026-09-15 승연, B안).
  const row = element("div", "tray__row");
  const pill = element("div", "tray__pill");
  const chips = element("div", "tray__keys");
  for (const key of model.tray) chips.append(trayChip(key, model, actions));
  // The fade at the strip's end is a promise of more: only while there is.
  fadeWhileScrollable(chips, "tray__keys--cut");
  pill.append(chips);
  pill.append(element("div", "tray__divider"));
  const toggles = element("div", "tray__toggles");
  // History and Command, in the frames' order; the keyboard toggle the frames
  // put third has moved out to the seat beside the pill. The session switcher
  // that used to lead this row moved up to the header, into the slot
  // 3017:81400 fills; the arrow pad has no seat here at all.
  toggles.append(panelButton("history", iconHistory, t("최근 명령"), model, actions));
  toggles.append(panelButton("keys", iconCommand, t("키"), model, actions));
  const inputRow = element("div", "tray__input");
  // A textarea, not a line: holding space turns the OS keyboard into a
  // trackpad that moves this field's caret, and `spaceTrackpad` reads that
  // caret as arrow keys — which needs rows to move across.
  const box = element("textarea", "tray__box");
  box.autocapitalize = "off";
  box.autocomplete = "off";
  box.setAttribute("autocorrect", "off");
  box.spellcheck = false;
  // Writing is only offered when the attach actually granted it. An input that
  // swallows what you type is worse than no input.
  box.disabled = !inputEnabled;
  keyboardInput = attachTerminalKeyboard(box, {
    text: actions.type,
    key: actions.nativeKey,
    paste: text => { void actions.paste({ kind: "text", text }); },
    pasteImage: image => { void actions.paste({ kind: "image", image }); },
    trackpad: {
      press: direction => actions.press(direction),
      direction: (direction, fast) => showTrackpadDirection(screen, direction, fast),
    },
  });
  const submit = (): void => {
    if (box.disabled) return;
    keyboardInput?.finish();
    actions.submit();
    showSend();
  };
  // # Why a field nobody can see is still in the tree
  //
  // None of 3017:81400 / 81505 / 81555 draws a text field, and none draws the
  // mic — both are gone. But iOS raises no keyboard without a focused input, so
  // one has to exist to hold focus. It is collapsed rather than removed:
  // removing a focused field blurs it, and the keyboard goes down with it.
  inputRow.append(box);
  // Keep the native pad outside the tray's foreground stacking context.
  screen.append(inputRow);

  // The keyboard toggle, in the seat beside the pill. It is lit in exactly one
  // frame — 3017:81400, the keyboard-up one — which makes it the summon and
  // the dismiss. Until now the only way down was the drawer's footer bar, so
  // the keyboard could not be lowered without first opening a drawer.
  const keyboard = element("button", "tray__toggle tray__toggle--keyboard");
  keyboard.type = "button";
  keyboard.setAttribute("aria-label", t("키보드"));
  keyboard.append(glyph(iconKeyboard, 18));
  keyboard.addEventListener("click", () => {
    // Inside the click handler so iOS counts it as the user gesture that is
    // allowed to raise a keyboard.
    if (document.documentElement.getAttribute("data-keyboard") === "on") {
      lowerKeyboard();
      return;
    }
    // An open drawer keeps its space until the keyboard actually takes it.
    // The two stand in the same strip, so closing it here would drop the pill
    // by the drawer's height and then lift it again when the keys arrive — a
    // dip on the way up (2026-09-03 user report). `publishViewport` closes the
    // drawer at the moment the keyboard is up, which is the same moment the
    // pill moves, so the pill makes that trip once.
    if (!box.disabled) box.focus();
  });
  pill.append(toggles);
  row.append(pill);

  // The seat: the keyboard toggle at rest, and the send circle when there is
  // something to send — canvas note 3022:81487: "뭔가 입력되어있거나 보낼게
  // 있으면 send 버튼 등장". Both are 44px circles in the same 44px seat, so
  // the swap moves nothing else; `tray__row--sending` (below) picks which one
  // shows.
  const send = element("button", "tray__send");
  send.type = "button";
  send.disabled = !inputEnabled;
  send.setAttribute("aria-label", t("보내기"));
  send.append(glyph(iconArrowRight, 18));
  send.addEventListener("click", submit);
  const seat = element("div", "tray__seat");
  seat.append(keyboard, send);
  row.append(seat);
  tray.append(row);

  // Shown from here rather than through `setState`: a re-render replaces the
  // whole tree, which would destroy the focused field mid-keystroke and drop
  // the keyboard. Read the attachment's draft; the field only holds its pad.
  const showSend = (): void => {
    row.classList.toggle("tray__row--sending", actions.draft().length > 0 && !box.disabled);
  };
  // Printable chips and Enter/Backspace chips change the same draft as typing.
  screen.addEventListener("click", showSend);
  box.addEventListener("input", showSend);
  box.addEventListener("compositionend", showSend);
  box.addEventListener("keydown", () => queueMicrotask(showSend));
  showSend();

  if (model.panel === "history") tray.append(historyPanel(model, actions));
  if (model.panel === "sessions") tray.append(renderSessionSwitcher(
    model.siblings, model.viewOptions ?? loadHomeViewOptions(),
    model.session.session_id, model.opening, model.nowMs, actions.openSession,
  ));
  if (model.panel === "keys") tray.append(keysPanel(model, actions));

  screen.append(tray);
  return screen;
}

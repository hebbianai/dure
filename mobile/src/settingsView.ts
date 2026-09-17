import packageMetadata from "../package.json";
import iconBell from "./assets/icon-bell.svg";
import iconBook from "./assets/icon-book.svg";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconChevronRight from "./assets/icon-chevron-right.svg";
import iconGlobe from "./assets/icon-globe.svg";
import iconKeyboard from "./assets/icon-keyboard.svg";
import iconMessageSquare from "./assets/icon-message-square.svg";
import iconMonitor from "./assets/icon-monitor.svg";
import iconMouse from "./assets/icon-mouse.svg";
import iconRefresh from "./assets/icon-refresh-cw.svg";
import iconScan from "./assets/icon-scan.svg";
import iconServer from "./assets/icon-server.svg";
import iconTrash from "./assets/icon-trash.svg";
import iconVibrate from "./assets/icon-vibrate.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import type { BiometryKind } from "./biometricLock";
import type { NotificationPermission } from "./notificationPolicy";
import {
  type ResolvedLanguage,
  type SettingsPreferences,
  resolveSettingsLanguage,
} from "./settingsPreferences";

export interface SettingsModel {
  /** Paired computers by title, for the 컴퓨터 row's detail. */
  readonly computers: readonly string[];
  readonly hosts: readonly string[];
  readonly preferences: SettingsPreferences;
  /**
   * How many keys the strip *draws*, for the row's detail.
   *
   * The count of drawn chips, not of saved ids: a saved id this build cannot
   * resolve is dropped by `groupKeys`, and a row reading 9 above a strip
   * showing 7 is the settings screen contradicting the screen it opens.
   */
  readonly keyStripCount: number;
  /** How many commands the 최근 drawer holds, for the 최근 명령 지우기 row's detail. */
  readonly commandCount: number;
  /**
   * Which sensor this phone has, once probed. `unavailable` until then and on
   * the desktop shell, where the row is drawn disabled with a reason.
   */
  readonly biometry: BiometryKind;
  /**
   * What the system has decided about notifications. Anything but granted is
   * said beside the choice, since a choice that cannot fire is the settings
   * screen promising what the phone will not do.
   */
  readonly notificationPermission: NotificationPermission;
}

export interface SettingsActions {
  readonly back: () => void;
  readonly openComputers: () => void;
  readonly openHosts: () => void;
  readonly resetDevice: () => void;
  readonly openLanguage: () => void;
  readonly openNotifications: () => void;
  readonly openFontSize: () => void;
  readonly openScroll: () => void;
  readonly clearCommands: () => void;
  readonly openKeyStrip: () => void;
  readonly openHelp: () => void;
  readonly sendFeedback: () => void;
  readonly toggleHaptics: () => void;
  readonly toggleApprovalBiometric: () => void;
}

interface RowOptions {
  /** Stable `data-row` id — what tests and focus restoration find the row by, never its position. */
  readonly id: string;
  readonly detail?: string;
  readonly destructive?: boolean;
  readonly onOpen?: () => void;
  /** A live switch: the row is the control, and a tap flips it. */
  readonly switch?: { readonly checked: boolean; readonly onToggle: () => void };
  /** A switch this device cannot offer — drawn off and disabled, with `detail` saying why. */
  readonly unavailableSwitch?: boolean;
  readonly trailing?: boolean;
}

function row(title: string, lead: Node, options: RowOptions): HTMLButtonElement {
  const control = element("button", "settings__row");
  control.type = "button";
  control.dataset.row = options.id;
  if (options.destructive) control.classList.add("settings__row--destructive");
  control.append(lead, element("span", "settings__row-title", t(title)));

  if (options.detail) {
    control.append(element("span", "settings__row-detail", options.detail));
  }
  if (options.switch || options.unavailableSwitch) {
    const checked = options.switch?.checked ?? false;
    control.setAttribute("role", "switch");
    control.setAttribute("aria-checked", String(checked));
    const toggle = element("span", "settings__switch");
    if (options.switch) {
      if (checked) toggle.classList.add("settings__switch--on");
    } else {
      toggle.classList.add("settings__switch--unavailable");
    }
    toggle.setAttribute("aria-hidden", "true");
    toggle.append(element("span", "settings__switch-thumb"));
    control.append(toggle);
  } else if (options.trailing !== false) {
    control.append(glyph(iconChevronRight, 16, "settings__chevron"));
  }

  const onPress = options.switch?.onToggle ?? options.onOpen;
  if (onPress) {
    control.addEventListener("click", onPress);
  } else {
    // A switch this device cannot offer: inert, with the detail saying why.
    control.disabled = true;
  }
  return control;
}

function section(label: string, ...rows: readonly Node[]): HTMLElement {
  const section = element("section", "settings__section");
  section.append(element("h2", "settings__label", t(label)));
  const card = element("div", "settings__card");
  card.append(...rows);
  section.append(card);
  return section;
}

/** One name, or the first and a count — the same shape for computers and hosts. */
function connectionSummary(labels: readonly string[]): string {
  const names = labels.map((label) => label.trim()).filter(Boolean);
  if (names.length === 0) return t("연결 없음");
  if (names.length === 1) return names[0] ?? t("연결 없음");
  return t("{host} 외 {count}", {
    host: names[0] ?? "",
    count: names.length - 1,
  });
}

function typeIcon(): HTMLElement {
  const icon = element("span", "settings__type-icon", "T");
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

/** The one name a resolved language is shown under — the row detail and the choice screen agree. */
export function languageName(language: ResolvedLanguage): string {
  return language === "en" ? "English" : t("한국어");
}

function notificationDetail(model: SettingsModel): string {
  const choice = t(
    model.preferences.notifications === "all"
      ? "모두"
      : model.preferences.notifications === "approvals"
        ? "승인만"
        : "끔",
  );
  if (model.preferences.notifications === "off" || model.notificationPermission === "granted") {
    return choice;
  }
  return model.notificationPermission === "denied"
    ? t("{choice} · 권한 없음 — 설정에서 허용", { choice })
    : t("{choice} · 권한 필요", { choice });
}

function currentLanguage(preferences: SettingsPreferences): string {
  return languageName(resolveSettingsLanguage(preferences.language));
}

export function renderSettingsScreen(model: SettingsModel, actions: SettingsActions): HTMLElement {
  const screen = element("section", "pair-screen settings");
  const bar = element("header", "pair-bar settings__bar");
  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back, element("h1", "pair-bar__title", t("설정")));
  screen.append(bar);

  const body = element("div", "settings__body");
  const hosts = row("호스트", glyph(iconServer, 16, "settings__icon"), {
    id: "hosts",
    detail: connectionSummary(model.hosts),
    onOpen: actions.openHosts,
  });
  hosts.classList.add("settings__host");
  body.append(
    section(
      "연결",
      // 컴퓨터가 먼저다 — the home screen orders them the same way.
      row("컴퓨터", glyph(iconMonitor, 16, "settings__icon"), {
        id: "computers",
        detail: connectionSummary(model.computers),
        onOpen: actions.openComputers,
      }),
      hosts,
      row("기기 초기화", glyph(iconRefresh, 16, "settings__icon"), {
        id: "reset",
        destructive: true,
        onOpen: actions.resetDevice,
        trailing: false,
      }),
    ),
    section(
      "일반",
      row("언어", glyph(iconGlobe, 16, "settings__icon"), {
        id: "language",
        detail: currentLanguage(model.preferences),
        onOpen: actions.openLanguage,
      }),
      row("알림", glyph(iconBell, 16, "settings__icon"), {
        id: "notifications",
        detail: notificationDetail(model),
        onOpen: actions.openNotifications,
      }),
    ),
    section(
      "키보드",
      row("키스트립", glyph(iconKeyboard, 16, "settings__icon"), {
        id: "key-strip",
        detail: t("키 {count}개", { count: model.keyStripCount }),
        onOpen: actions.openKeyStrip,
      }),
      row("햅틱", glyph(iconVibrate, 16, "settings__icon"), {
        id: "haptics",
        switch: { checked: model.preferences.haptics, onToggle: actions.toggleHaptics },
      }),
    ),
    section(
      "터미널",
      row("글꼴 크기", typeIcon(), {
        id: "font-size",
        detail: String(model.preferences.fontSize),
        onOpen: actions.openFontSize,
      }),
      row("스크롤", glyph(iconMouse, 16, "settings__icon"), {
        id: "scroll",
        detail: t(
          model.preferences.scrollSpeed === "slow"
            ? "느리게"
            : model.preferences.scrollSpeed === "fast"
              ? "빠르게"
              : "보통",
        ),
        onOpen: actions.openScroll,
      }),
      // Always live, even over an empty list: a disabled destructive row looks
      // identical to a live one, and a disabled button cannot take focus back
      // after the dialog closes. Confirming on nothing is harmless.
      row("최근 명령 지우기", glyph(iconTrash, 16, "settings__icon"), {
        id: "clear-commands",
        destructive: true,
        trailing: false,
        detail: t("명령 {count}개", { count: model.commandCount }),
        onOpen: actions.clearCommands,
      }),
    ),
    section(
      "보안",
      model.biometry === "unavailable"
        ? row("settings.security.approvalBiometric", glyph(iconScan, 16, "settings__icon"), {
            id: "face-id",
            unavailableSwitch: true,
            detail: t("이 기기에서 사용할 수 없음"),
          })
        : row("settings.security.approvalBiometric", glyph(iconScan, 16, "settings__icon"), {
            id: "face-id",
            switch: {
              checked: model.preferences.approvalBiometric,
              onToggle: actions.toggleApprovalBiometric,
            },
          }),
    ),
  );

  const help = section(
    "도움말",
    row("도움말", glyph(iconBook, 16, "settings__icon"), { id: "help", onOpen: actions.openHelp }),
    row("피드백 보내기", glyph(iconMessageSquare, 16, "settings__icon"), {
      id: "feedback",
      onOpen: actions.sendFeedback,
    }),
  );
  help.classList.add("settings__section--help");
  help.append(element("p", "settings__version", t("Dure {version}", { version: packageMetadata.version })));
  body.append(help);
  screen.append(body);
  return screen;
}

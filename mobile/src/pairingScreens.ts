/**
 * The first-run screen and the three pairing screens — Figma `dure-UI`
 * 2863:76314 / 2863:76554 / 2865:76794 / 2865:77049.
 *
 * Extracted from `app.ts` rather than added to it: `app.ts` is already past
 * 1500 lines, and these four screens have a sharper reason to live apart.
 * They are pure DOM — no camera, no IPC — so from here jsdom can render and
 * inspect them directly. Inside `app.ts` a test would have to stand up every
 * Tauri command just to look at one screen.
 *
 * These functions draw and nothing else. What gets scanned and where the flow
 * goes next arrives through `actions`. If this file knew the pairing flow, the
 * screen and the flow would move together and every mockup change would mean
 * re-reading the pairing logic.
 *
 * Icons are the SVG files exported from Figma, unmodified. Redrawing one by
 * hand produces a similar but different glyph, and that difference is visible
 * only to the person who made the mockup. Colour is applied with `mask`, so
 * the file stays exactly as exported while `currentColor` paints it: the same
 * file reads dark on the light primary button and light on a dark surface.
 *
 * UI copy is Korean-source and routed through `t()`, the way the rest of this
 * phone app works — `locales/en.ts` carries the English.
 */

import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconMonitor from "./assets/icon-monitor.svg";
import iconScan from "./assets/icon-scan.svg";
import iconX from "./assets/icon-x.svg";
import scanViewfinder from "./assets/scan-viewfinder.svg";
import { element, glyph, loader } from "./dom";
import { t } from "./i18n";
import { dureWordmark } from "./logo";

/** A 20px glyph inside a 32px tap target — every top-bar icon in the mockups. */
function iconButton(source: string, label: string, onPress: () => void): HTMLButtonElement {
  const button = element("button", "icon-tap");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.append(glyph(source, 20));
  button.addEventListener("click", onPress);
  return button;
}

function solidButton(label: string, className: string, onPress: () => void): HTMLButtonElement {
  const button = element("button", `pair-button pair-button--solid ${className}`, label);
  button.type = "button";
  button.addEventListener("click", onPress);
  return button;
}

function ghostButton(label: string, className: string, onPress: () => void): HTMLButtonElement {
  const button = element("button", `pair-button pair-button--ghost ${className}`, label);
  button.type = "button";
  button.addEventListener("click", onPress);
  return button;
}

/** Top bar: back arrow plus title. Figma 2863:76556 / 2865:77051. */
function pairBar(title: string | undefined, onBack: (() => void) | undefined): HTMLElement {
  const bar = element("header", "pair-bar");
  if (onBack) bar.append(iconButton(iconChevronLeft, t("뒤로"), onBack));
  if (title !== undefined) bar.append(element("h1", "pair-bar__title", title));
  return bar;
}

export interface FirstRunActions {
  /** Opens the camera — the mockup's primary action. */
  scan: () => void;
  /** The same path without a camera. */
  paste: () => void;
}

/**
 * What someone sees before anything is paired. Figma 2863:76314.
 *
 * The rule the home screen follows holds here too: this screen does not write
 * down numbers nobody counted. Nothing from an earlier draft — usage stats,
 * placeholder cards — comes back through this file.
 */
export function renderFirstRun(actions: FirstRunActions): HTMLElement {
  const host = element("div", "pair-screen first-run");
  const bar = element("header", "pair-bar first-run__bar");
  bar.append(dureWordmark());
  host.append(bar);

  const center = element("div", "first-run__center");
  center.append(element("h2", "first-run__title", t("데스크톱을 연결하세요")));
  center.append(
    element(
      "p",
      "first-run__body",
      t("컴퓨터에서 실행 중인 에이전트를 지켜보고, 승인하고, 터미널에 들어갑니다."),
    ),
  );

  const actionsRow = element("div", "first-run__actions");
  const scan = element("button", "pair-button pair-button--solid first-run__scan");
  scan.type = "button";
  scan.append(glyph(iconScan, 16), element("span", undefined, t("QR 스캔으로 연결")));
  scan.addEventListener("click", actions.scan);
  actionsRow.append(scan);
  actionsRow.append(ghostButton(t("코드 붙여넣기로 연결"), "first-run__paste", actions.paste));
  center.append(actionsRow);
  host.append(center);

  const guide = element("div", "first-run__guide");
  guide.append(element("h3", "first-run__guide-title", t("연결 방법")));
  guide.append(
    steps([
      {
        title: t("데스크톱 Dure에서 QR 표시"),
        body: t("설정 › 모바일 연결에서 페어링 QR을 만듭니다."),
      },
      {
        title: t("이 폰으로 스캔"),
        body: t("위 버튼으로 스캐너를 열고 화면의 QR을 비춥니다."),
      },
      {
        title: t("연결 완료"),
        body: t("세션 목록이 여기 나타납니다. 종단간 암호화."),
      },
    ]),
  );
  host.append(guide);
  return host;
}

interface Step {
  title: string;
  body: string;
}

/** Figma 2863:76329 — fixed-width numerals, no rule between the rows. */
function steps(items: readonly Step[]): HTMLElement {
  const list = element("ol", "pair-steps");
  items.forEach((step, index) => {
    const item = element("li", "pair-steps__item");
    item.append(element("span", "pair-steps__index", String(index + 1)));
    const body = element("div", "pair-steps__body");
    body.append(
      element("div", "pair-steps__title", step.title),
      element("div", "pair-steps__note", step.body),
    );
    item.append(body);
    list.append(item);
  });
  return list;
}

export interface ScanActions {
  /** Give up on scanning. Not an error, so it leaves no banner. */
  close: () => void;
  paste: () => void;
}

export interface ScanModel {
  /**
   * Why the camera could not open — permission off, or a build with no
   * scanner at all.
   *
   * When it is set the viewfinder is not drawn. A reticle with no camera
   * behind it reads as a broken camera, and the person keeps holding a QR code
   * up to a dead screen.
   */
  notice?: string;
}

/**
 * The layer over the camera. Figma 2865:76794.
 *
 * Paints no background of its own. While this screen is up the webview is
 * transparent and the camera shows through it (`scanner.ts`, windowed mode);
 * a background here would not be the mockup's scrim but a black sheet over
 * the camera.
 */
export function renderScan(model: ScanModel, actions: ScanActions): HTMLElement {
  const host = element("div", "pair-screen scan");
  if (model.notice) host.classList.add("scan--blind");

  const scrim = element("div", "scan__scrim");
  // The frame of Figma 2865:76798: one window left open for the camera, and
  // the scrim around it is the window's own shadow (`.scan__window`), so the
  // hole's corners can turn the way the brackets inside it do.
  const port = element("div", "scan__window");
  if (!model.notice) port.append(glyph(scanViewfinder, 252, "scan__frame"));
  scrim.append(port);
  host.append(scrim);

  host.append(iconButton(iconX, t("스캔 그만두기"), actions.close));

  const footer = element("div", "scan__footer");
  if (model.notice) {
    footer.append(element("p", "banner banner--warn scan__notice", t(model.notice)));
  }
  footer.append(
    element(
      "p",
      "scan__hint",
      t("데스크톱 Dure의 설정 › 모바일 연결에 표시된 QR 코드를 비추세요"),
    ),
  );
  const paste = element(
    "button",
    "pair-button pair-button--outline scan__paste",
    t("코드 붙여넣기로 연결"),
  );
  paste.type = "button";
  paste.addEventListener("click", actions.paste);
  footer.append(paste);
  host.append(footer);
  return host;
}

export interface PasteModel {
  /** Held in state so a re-render does not throw away what was typed. */
  deviceLabel: string;
  payload: string;
  notice?: string;
  busy: boolean;
}

export interface PasteActions {
  back: () => void;
  submit: (deviceLabel: string, payload: string) => void;
}

/**
 * Pairing from a pasted code. Figma 2863:76554.
 *
 * Not a fallback for the camera but the same path through another door. The
 * pairing commands take the scanned *string*, so this screen carries the flow
 * end to end on a desktop build with no camera — which is what makes the flow
 * testable off a phone.
 */
export function renderPaste(model: PasteModel, actions: PasteActions): HTMLElement {
  const host = element("div", "pair-screen paste");
  host.append(pairBar(t("코드로 연결"), actions.back));

  const body = element("div", "paste__body");
  const form = element("div", "paste__form");

  const nameField = element("label", "pair-field");
  nameField.append(element("span", "pair-field__label", t("이 기기 이름")));
  const name = element("input", "pair-input paste__label");
  name.type = "text";
  name.value = model.deviceLabel;
  name.placeholder = t("내 폰");
  name.autocapitalize = "off";
  name.spellcheck = false;
  nameField.append(name);
  nameField.append(
    element(
      "span",
      "pair-field__hint",
      t("데스크톱이 authorized_keys 주석에 적는 이름입니다."),
    ),
  );
  form.append(nameField);

  const codeField = element("label", "pair-field");
  codeField.append(element("span", "pair-field__label", t("페어링 코드")));
  const payload = element("textarea", "pair-input pair-input--payload paste__payload");
  payload.value = model.payload;
  // Exactly what the laptop prints for `--print-payload`. Not JSON — an early
  // draft assumed JSON and disagreed with the host it actually landed on.
  payload.placeholder = "hmux-pair:1?a=192.168.0.12&p=47821&t=… &k=ssh-ed25519&f=…&e=…";
  payload.autocapitalize = "off";
  payload.spellcheck = false;
  codeField.append(payload);
  form.append(codeField);

  if (model.notice) form.append(element("p", "banner banner--warn paste__notice", t(model.notice)));

  // Not pretending to be hardware-backed storage is part of the point of this
  // screen, and the mockup gives the sentence its own box.
  form.append(
    element(
      "p",
      "pair-warning",
      t(
        "개인키는 이 기기를 떠나지 않지만, 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다.",
      ),
    ),
  );
  body.append(form);

  const submit = solidButton(
    model.busy ? t("페어링 중…") : t("붙여넣은 코드로 페어링"),
    "pair-button--block paste__submit",
    () => actions.submit(name.value, payload.value),
  );
  submit.disabled = model.busy;
  body.append(submit);
  host.append(body);
  return host;
}

export interface CodeModel {
  code: string;
  notice?: string;
  busy: boolean;
}

export interface CodeActions {
  back: () => void;
  submit: (code: string) => void;
}

/**
 * The six characters that seal a v2 (offline) QR.
 *
 * Not one of the four mockups — that flow predates them — but it sits inside
 * the same pairing stack, so it wears the same chrome rather than dropping the
 * person onto a differently-shaped screen mid-flow.
 *
 * Holding both the QR and the code is the whole point of the flow, and the
 * screen says so: someone who does not know why they are typing six more
 * characters reads it as nothing but friction.
 */
export function renderCodeEntry(model: CodeModel, actions: CodeActions): HTMLElement {
  const host = element("div", "pair-screen paste");
  host.append(pairBar(t("페어링 코드"), actions.back));

  const body = element("div", "paste__body");
  const form = element("div", "paste__form");
  form.append(
    element(
      "p",
      "pair-field__hint",
      t("QR을 읽었습니다. 노트북 화면의 QR 옆에 있는 6글자를 입력하세요."),
    ),
  );

  const field = element("label", "pair-field");
  field.append(element("span", "pair-field__label", t("페어링 코드")));
  const code = element("input", "pair-input form__input--code");
  code.type = "text";
  code.value = model.code;
  // Uppercase letters and digits only. Autocapitalisation and autocorrect are
  // off because iOS turning six characters into a word reads to the person as
  // their own typo.
  code.autocapitalize = "characters";
  code.autocomplete = "off";
  code.spellcheck = false;
  code.inputMode = "text";
  code.maxLength = 12; // hyphens and spaces are allowed; normalisation strips them
  code.placeholder = "K7F2QX";
  field.append(code);
  field.append(
    element(
      "span",
      "pair-field__hint",
      t("소문자로 쳐도, 사이에 하이픈을 넣어도 됩니다. O와 0, I와 1은 알아서 맞춥니다."),
    ),
  );
  form.append(field);

  if (model.notice) form.append(element("p", "banner banner--warn", t(model.notice)));
  form.append(
    element(
      "p",
      "pair-field__hint",
      t("이 QR은 코드 없이는 아무것도 열지 않습니다 — 사진만으로는 서버에 닿을 수 없습니다."),
    ),
  );
  body.append(form);

  const submit = solidButton(
    model.busy ? t("페어링 중…") : t("코드로 페어링"),
    "pair-button--block pair__code",
    () => actions.submit(code.value),
  );
  submit.disabled = model.busy;
  // Enter sends it too. Typing six characters and then hunting for a button at
  // the bottom of the screen is one motion too many on a phone.
  code.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !model.busy) actions.submit(code.value);
  });
  body.append(submit);
  host.append(body);
  return host;
}

export interface ConfirmModel {
  boxLabel: string;
  /** `host:port`. The desktop settings screen shows the same value the same way. */
  endpoint: string;
  /** Whether it is reachable from outside. Arrives already translated. */
  reach: string;
  /**
   * The certificate fingerprint this phone would pin. **Never shortened.**
   *
   * The mockup shows a four-group sample; the real value is `SHA256:` plus 43
   * characters. Showing a prefix would make the compared thing a part of the
   * value, and that comparison is the only reason this screen exists. The
   * desktop settings screen shows the whole value too.
   */
  fingerprint: string;
  /**
   * Session count. **Unknown before connecting**, so it may be absent.
   *
   * The mockup reads "세션 3", but that number only exists after the phone has
   * reached the computer and taken its catalog. This screen runs *before* that,
   * and a plausible number here would be the screen claiming to have counted
   * something it never asked about.
   */
  sessionCount?: number;
  busy: boolean;
}

export interface ConfirmActions {
  back: () => void;
  connect: () => void;
  cancel: () => void;
}

/**
 * Comparing the fingerprint by eye before connecting. Figma 2865:77049.
 *
 * There is no certificate authority on this path, so the whole of trust starts
 * at this one comparison at the desk. That is why the screen does not
 * summarise the values it shows.
 */
export function renderConfirm(model: ConfirmModel, actions: ConfirmActions): HTMLElement {
  const host = element("div", "pair-screen confirm");
  host.append(pairBar(undefined, actions.back));

  const body = element("div", "confirm__body");
  const heading = element("div", "confirm__heading");
  heading.append(element("h2", "confirm__title", t("이 서버에 연결할까요?")));
  heading.append(
    element("p", "confirm__lede", t("데스크톱 화면의 지문과 같은지 확인하세요.")),
  );
  body.append(heading);

  const card = element("div", "confirm__card");
  const top = element("div", "confirm__device");
  const named = element("div", "confirm__device-name");
  named.append(glyph(iconMonitor, 16), element("span", undefined, model.boxLabel));
  top.append(named);
  if (model.sessionCount !== undefined) {
    top.append(
      element("span", "confirm__sessions", t("세션 {count}", { count: model.sessionCount })),
    );
  }
  card.append(top);

  const facts = element("div", "confirm__facts");
  facts.append(element("div", "confirm__fact", `${model.endpoint} · ${model.reach}`));
  facts.append(
    element("div", "confirm__fact", t("지문 {fingerprint}", { fingerprint: model.fingerprint })),
  );
  card.append(facts);
  body.append(card);
  host.append(body);

  const footer = element("div", "confirm__footer");
  const connect = solidButton(
    model.busy ? t("연결 중…") : t("연결"),
    "pair-button--block confirm__connect",
    actions.connect,
  );
  connect.disabled = model.busy;
  // A disabled button with a changed label says the press landed; it does not
  // say the app is still working. Connecting reaches a laptop over a network,
  // and the wait is long enough that a still screen reads as a stuck one.
  if (model.busy) connect.prepend(loader(16));
  footer.append(connect);
  const cancel = ghostButton(t("취소"), "pair-button--block confirm__cancel", actions.cancel);
  cancel.disabled = model.busy;
  footer.append(cancel);
  host.append(footer);
  return host;
}
